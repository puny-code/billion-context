import assert from "node:assert/strict";
import test from "node:test";

import { _resetRestoreRefusedForTest, restoreOutputBudget } from "../src/server/side-request.ts";

// F8: the #546 restore used to write a capability ceiling into `max_tokens`
// with no regard for the input side. On the context-overflow incident's lane it
// restored 1 -> 384,000 on a ~1.24M-token input, which (a) added 384K to the
// billed messages+completion total and (b) shrank the judged window through the
// output-headroom reservation — a guaranteed over-window 400 either way.
//
// The bound is: target = min(target, window - inputUpperBound - margin), with
// margin = max(2048, ceil(inputUpperBound * 0.05)) (the #453 clamp formula).
// window = metadata.nativeContextLimit — the PRE-reservation window handle.ts
// records every turn. Deliberately NOT effectiveContextLimit: that one is
// post-reservation, so fencing on it subtracts the reservation twice (the #3833
// shape below would be refused instead of restored). inputUpperBound =
// stats.localInputEstimate (the post-fold outbound upper bound, #728).
//
// Below OUTPUT_RESTORE_ABSOLUTE_FLOOR (32,768, #3071) the restore refuses: a
// sub-floor value is the death-rattle zone (too small to emit a compress call),
// so keeping the client's recoverable starvation is the honest choice.

interface RestoreSession {
    id: string;
    metadata: Record<string, unknown>;
    stats?: { localInputEstimate?: number };
}

function freshSession(metadata: Record<string, unknown> = {}, stats?: { localInputEstimate?: number }): RestoreSession {
    return stats === undefined ? { id: "f8-session", metadata } : { id: "f8-session", metadata, stats };
}

/** A starved main request: `max_tokens: 1` + tools is the #546 signature. */
function starvedBody(): { model: string; max_tokens: number; tools: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> } {
    return {
        model: "opencode/deepseek-v4",
        max_tokens: 1,
        tools: [{ name: "bash", description: "run a command", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: "hi" }],
    };
}

test("F8: the restore is bounded by the input side (incident arithmetic)", () => {
    // native window 1,048,576, post-fold input upper bound 941,626 (the
    // incident's calibrated estimate), capability ceiling 384,000:
    // margin = max(2048, ceil(941,626 * 0.05)) = 47,082
    // bound  = 1,048,576 - 941,626 - 47,082 = 59,868  -> above the 32,768 floor.
    const parsed = starvedBody();
    const session = freshSession({ nativeContextLimit: 1_048_576 }, { localInputEstimate: 941_626 });
    restoreOutputBudget(parsed, session, () => {}, 384_000);
    assert.equal(parsed.max_tokens, 59_868, "restored value must be bounded by window - inputUpperBound - margin, not the ceiling");
});

test("F8: a small input still restores the full ceiling (no false clamp)", () => {
    // margin = max(2048, 5,000) = 5,000 -> bound 1,043,576 > ceiling -> ceiling wins.
    const parsed = starvedBody();
    const session = freshSession({ nativeContextLimit: 1_048_576 }, { localInputEstimate: 100_000 });
    restoreOutputBudget(parsed, session, () => {}, 384_000);
    assert.equal(parsed.max_tokens, 384_000, "a request whose messages leave ample room is restored exactly as before");
});

test("F8: #3833's own shape still restores (the fence uses the NATIVE window)", () => {
    // W=1M, previous max_tokens 256K -> effectiveContextLimit 750K (post
    // reservation), input 827,069, ceiling 131,072. Fencing on the effective
    // window would compute a NEGATIVE bound and silently disable #3833's fix;
    // the native window gives 1,000,000 - 827,069 - 41,354 = 131,577 -> the
    // ceiling wins and the healthy restore is unchanged.
    const parsed = starvedBody();
    const session = freshSession({ nativeContextLimit: 1_000_000, effectiveContextLimit: 750_000 }, { localInputEstimate: 827_069 });
    restoreOutputBudget(parsed, session, () => {}, 131_072);
    assert.equal(parsed.max_tokens, 131_072, "the input+output total here (958,141) fits the 1M window, so the restore must go through");
});

test("F8: an over-window input side refuses to restore at all", () => {
    // The incident's true payload: 1,240,000 tokens of input against a
    // 1,048,576 window -> the bound is negative, well below the floor.
    _resetRestoreRefusedForTest();
    const parsed = starvedBody();
    const session = freshSession({ nativeContextLimit: 1_048_576 }, { localInputEstimate: 1_240_000 });
    const logged: string[] = [];
    restoreOutputBudget(parsed, session, (level: string) => { logged.push(level); }, 384_000);
    assert.equal(parsed.max_tokens, 1, "keeping the client's starvation leaves the request forwarded as-is; writing 384K guarantees an over-window 400");
    assert.equal(session.metadata.outputBudgetHighWater, undefined, "a refused restore must not seed the session high-water");
    assert.deepEqual(logged, ["warn"], "the refusal is surfaced as exactly one warn line");
});

test("F8: the refusal warning is one-shot per session", () => {
    // The same estimate keeps producing the same refusal on every turn; without
    // suppression this becomes a per-turn warn in the incident log.
    _resetRestoreRefusedForTest();
    const session = freshSession({ nativeContextLimit: 1_048_576 }, { localInputEstimate: 1_240_000 });
    const logged: string[] = [];
    for (let i = 0; i < 3; i++) {
        const parsed = starvedBody();
        restoreOutputBudget(parsed, session, (level: string) => { logged.push(level); }, 384_000);
        assert.equal(parsed.max_tokens, 1);
    }
    assert.deepEqual(logged, ["warn"], "three starving turns must not produce three warnings");
    // A DIFFERENT session is a different story: it gets its own first warning.
    const other = { ...freshSession({ nativeContextLimit: 1_048_576 }, { localInputEstimate: 1_240_000 }), id: "f8-other" };
    const otherLogged: string[] = [];
    restoreOutputBudget(starvedBody(), other, (level: string) => { otherLogged.push(level); }, 384_000);
    assert.deepEqual(otherLogged, ["warn"]);
});

test("F8: no input bound and no native window -> pre-F8 behavior is preserved", () => {
    // Callers that pass a bare { id, metadata } session (e.g. the #3833 suite)
    // must keep the old restore exactly: the fence degrades to a no-op.
    const bare = starvedBody();
    restoreOutputBudget(bare, freshSession(), () => {}, 131_072);
    assert.equal(bare.max_tokens, 131_072, "unknown window + unknown input -> the fence cannot bound and must not invent a value");

    const inputOnly = starvedBody();
    restoreOutputBudget(
        inputOnly,
        freshSession({}, { localInputEstimate: 941_626 }),
        () => {},
        131_072,
    );
    assert.equal(inputOnly.max_tokens, 131_072, "input known but window unknown -> no fence");

    const windowOnly = starvedBody();
    restoreOutputBudget(windowOnly, freshSession({ nativeContextLimit: 1_048_576 }), () => {}, 131_072);
    assert.equal(windowOnly.max_tokens, 131_072, "window known but input upper bound unknown (fresh session, no prepare yet) -> no fence");

    // The post-reservation window alone is NOT a fence input: a session that
    // only has effectiveContextLimit keeps the pre-F8 behavior.
    const effectiveOnly = starvedBody();
    restoreOutputBudget(effectiveOnly, freshSession({ effectiveContextLimit: 750_000 }, { localInputEstimate: 827_069 }), () => {}, 131_072);
    assert.equal(effectiveOnly.max_tokens, 131_072, "the fence reads the native window, never the reserved one");
});

test("F8: a bound that is above the target does not move it", () => {
    // Negative direction (Gate Test Discipline): the fence exists but must not
    // fire when the input side leaves room for the session's own budget.
    const parsed = starvedBody();
    const session = freshSession({ nativeContextLimit: 1_048_576, outputBudgetHighWater: 8_000 }, { localInputEstimate: 941_626 });
    restoreOutputBudget(parsed, session, () => {});
    assert.equal(parsed.max_tokens, 8_000, "bound 59,868 > target 8,000 -> the restore is written untouched");
});

import assert from "node:assert/strict";
import test from "node:test";

import { restoreOutputBudget } from "../src/server/side-request.ts";

// F8: the #546 restore used to write a capability ceiling into `max_tokens`
// with no regard for the input side. On the context-overflow incident's lane it
// restored 1 -> 384,000 on a ~1.24M-token input, which (a) added 384K to the
// billed messages+completion total and (b) shrank the judged window through the
// output-headroom reservation — a guaranteed over-window 400 either way.
//
// The bound is: target = min(target, window - inputUpperBound - margin), with
// margin = max(2048, ceil(inputUpperBound * 0.05)) (the #453 clamp formula).
// window = metadata.effectiveContextLimit (the window bili actually judged the
// session against last turn), inputUpperBound = stats.localInputEstimate (the
// post-fold outbound upper bound recorded by the last prepare, #728). Either
// value absent keeps the pre-F8 behavior exactly.

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

test("F8: the restore is bounded by the input side (incident numbers)", () => {
    // window 1,000,000, post-fold input upper bound 941,626 (the incident's own
    // calibrated estimate), capability ceiling 384,000 (the opencode lane's):
    // margin = max(2048, ceil(941,626 * 0.05)) = 47,082
    // bound  = 1,000,000 - 941,626 - 47,082 = 11,292
    const parsed = starvedBody();
    const session = freshSession({ effectiveContextLimit: 1_000_000 }, { localInputEstimate: 941_626 });
    restoreOutputBudget(parsed, session, () => {}, 384_000);
    assert.equal(parsed.max_tokens, 11_292, "restored value must be bounded by window - inputUpperBound - margin, not the ceiling");
});

test("F8: a small input still restores the full ceiling (no false clamp)", () => {
    // margin = max(2048, 5,000) = 5,000 -> bound 895,000 > ceiling -> ceiling wins.
    const parsed = starvedBody();
    const session = freshSession({ effectiveContextLimit: 1_000_000 }, { localInputEstimate: 100_000 });
    restoreOutputBudget(parsed, session, () => {}, 384_000);
    assert.equal(parsed.max_tokens, 384_000, "a request whose messages leave ample room is restored exactly as before");
});

test("F8: an over-window input side refuses to restore at all", () => {
    // The incident's true payload: 1,240,000 tokens of input against a
    // 1,000,000 window -> bound is negative, so the <=200 refusal applies.
    const parsed = starvedBody();
    const session = freshSession({ effectiveContextLimit: 1_000_000 }, { localInputEstimate: 1_240_000 });
    const logged: string[] = [];
    restoreOutputBudget(parsed, session, (level: string) => { logged.push(level); }, 384_000);
    assert.equal(parsed.max_tokens, 1, "keeping the client's starvation leaves the request forwarded as-is; writing 384K guarantees an over-window 400");
    assert.equal(session.metadata.outputBudgetHighWater, undefined, "a refused restore must not seed the session high-water");
    assert.deepEqual(logged, ["warn"], "the refusal is surfaced as exactly one warn line");
});

test("F8: no input bound and no window -> pre-F8 behavior is preserved", () => {
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
    restoreOutputBudget(windowOnly, freshSession({ effectiveContextLimit: 1_000_000 }), () => {}, 131_072);
    assert.equal(windowOnly.max_tokens, 131_072, "window known but input upper bound unknown (fresh session, no prepare yet) -> no fence");
});

test("F8: a bound that is above the target does not move it", () => {
    // Negative direction (Gate Test Discipline): the fence exists but must not
    // fire when the input side leaves room for the session's own budget.
    const parsed = starvedBody();
    const session = freshSession({ effectiveContextLimit: 1_000_000, outputBudgetHighWater: 8_000 }, { localInputEstimate: 941_626 });
    restoreOutputBudget(parsed, session, () => {});
    assert.equal(parsed.max_tokens, 8_000, "bound 11,292 > target 8,000 -> the restore is written untouched");
});

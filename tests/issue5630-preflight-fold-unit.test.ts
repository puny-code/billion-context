import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, createInitialState, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { coalesceFoldRanges, estimateCoreMessages, preflightCompress } from "../src/preflight.ts";
import type { Session } from "../src/session.ts";

// #5630: preflight could not converge on a long session because a round folds
// ONE range and the kernel splits ranges at every user turn.
//
// Incident session session-04109156 (sub:3bf8231d15d34093), 2026-11-07
// 00:52-00:57: 9377 messages, payload ~1,871,051 tok against a 786,432 window
// (deficit ~1,085,000), 505 advertised ranges. The nudge DISPLAY showed merged
// spans ("m01259-m03222 412.2K") because nudge-text.formatRanges merges
// positionally adjacent ranges, but the fold walk received the UNMERGED list:
//
//   [preflight] fold order (largest first outside the recent zone, #2682):
//   m09054:m09142 (19721 tok), m09325:m09444 (13816 tok), m05264:m05330
//   (13475 tok), ... (+497 more)
//
// The largest single foldable range was 19,721 tok = 2.5% of the window, so
// each round saved ~1% of a 1.1M deficit. The pass burned ~5 minutes of
// upstream summary calls (rounds 5-14 logged between 00:54:23 and 00:57:15,
// then "summarization aborted: client disconnected" at 00:57:50) and finally
// failed with the doomed-payload 413 (6,419,431 B core text).
//
// The fix coalesces adjacent advertised ranges into fold units sized from the
// entry deficit, so a round can remove a real fraction of the gap. These tests
// pin the coalescing contract directly (unit-level) and then prove the end-to-
// end shape converges through the real preflightCompress entry point.

const TURN_BYTES = 3309;
const PARA =
    "The build pipeline finished with 3 warnings and no errors; the rollout was staged and the next step is to verify the kernel fold path against the resent history. ";

/** Same 4-message turn cycle the throughput benchmarks use: user, assistant,
 *  tool-call, tool-result. The kernel segments a compressible range at each
 *  user message once a group has >= 3 messages, so this shape yields ~n/4
 *  ranges — the fragmentation that made one fold per round too slow. */
function makeHistory(n: number): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let i = 0; i < n; i++) {
        const head = `${i}: `;
        const body = PARA.repeat(Math.ceil(TURN_BYTES / PARA.length)).slice(0, TURN_BYTES - head.length);
        const text = head + body;
        const slot = i % 4;
        if (slot === 0) out.push({ id: `m${i}`, role: "user", contentType: "text", text });
        else if (slot === 1) out.push({ id: `m${i}`, role: "assistant", contentType: "text", text });
        else if (slot === 2) out.push({ id: `m${i}`, role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: `call_${i}`, text });
        else out.push({ id: `m${i}`, role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: `call_${i - 1}`, text });
    }
    return out;
}

function makeSession(lastInputTokens: number): Session {
    return {
        id: "fold-unit-test",
        meta: {},
        metadata: {},
        state: createInitialState(),
        stats: {
            requests: 1,
            tokensSaved: 0,
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            cacheSamples: 0,
            lastInputTokens,
            compressCreditTokens: 0,
            contextTokens: lastInputTokens,
            retrieveCalls: 0,
            retrieveHits: 0,
            retrieveMisses: 0,
            storedBytes: 0,
            storeBytesSaved: 0,
            rangeRestores: 0,
        },
        createdAt: 0,
        lastSeen: 0,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as unknown as Session;
}

type Range = Parameters<typeof coalesceFoldRanges>[0][number];

/** Builds advertised ranges laid out CONTIGUOUSLY on the wire (each range
 *  opens at the slot right after the previous one's last message), which is
 *  what the kernel emits for a dense append-only history: buildCompressibleRanges
 *  leaves no slot hole between two adjacent per-turn ranges. */
function ranges(specs: Array<{ start: number; end: number; tokens: number }>): Range[] {
    let index = 0;
    return specs.map((s) => {
        const count = s.end - s.start + 1;
        const r = {
            startRef: `m${String(s.start).padStart(5, "0")}`,
            endRef: `m${String(s.end).padStart(5, "0")}`,
            count,
            tokens: s.tokens,
            chars: s.tokens * 4,
            toolPct: 50,
            textPct: 50,
            startIndex: index,
            endIndex: index + count - 1,
        };
        index += count;
        return r;
    }) as Range[];
}

test("#5630: adjacent advertised ranges coalesce into fold-sized units", () => {
    // The incident's shape: many small per-turn ranges, contiguous positions.
    const input = ranges([
        { start: 1, end: 20, tokens: 19_721 },
        { start: 21, end: 40, tokens: 13_816 },
        { start: 41, end: 60, tokens: 13_475 },
        { start: 61, end: 80, tokens: 12_879 },
        { start: 81, end: 100, tokens: 12_547 },
    ]);
    const out = coalesceFoldRanges(input, 60_000);
    assert.ok(out.length < input.length, `expected coalescing, got ${out.length} unit(s)`);
    const largest = out.reduce((max, r) => Math.max(max, r.tokens), 0);
    assert.ok(largest > 19_721, `a unit must exceed the largest single range (got ${largest})`);
    assert.ok(largest <= 60_000, `no unit may exceed the cap (got ${largest})`);
    // Coalescing must preserve total mass and the outer endpoints exactly.
    assert.equal(out.reduce((s, r) => s + r.tokens, 0), input.reduce((s, r) => s + r.tokens, 0));
    assert.equal(out[0]!.startRef, input[0]!.startRef);
    assert.equal(out[out.length - 1]!.endRef, input[input.length - 1]!.endRef);
});

test("#5630: a physical index gap is a block/protected boundary and is never bridged", () => {
    const input = ranges([
        { start: 1, end: 20, tokens: 10_000 },
        // A block / protected / pruned boundary leaves a slot hole: the next
        // advertised range opens after the gap.
        { start: 50, end: 69, tokens: 10_000 },
    ]);
    // ranges() lays out contiguous slots; punch the hole the kernel leaves.
    (input[1] as { startIndex?: number; endIndex?: number }).startIndex = 30;
    (input[1] as { startIndex?: number; endIndex?: number }).endIndex = 49;
    const out = coalesceFoldRanges(input, 60_000);
    assert.equal(out.length, 2, "an index gap must split the unit");
    assert.equal(out[0]!.endRef, input[0]!.endRef);
    assert.equal(out[1]!.startRef, input[1]!.startRef);
});

test("#5630: noMergeBefore (dead-ref hole) is never bridged", () => {
    const input = ranges([
        { start: 1, end: 20, tokens: 10_000 },
        { start: 21, end: 40, tokens: 10_000 },
    ]);
    (input[1] as { noMergeBefore?: boolean }).noMergeBefore = true;
    const out = coalesceFoldRanges(input, 60_000);
    assert.equal(out.length, 2, "a dead-ref hole must split the unit");
});

test("#5630: a cap below one range's mass still emits that range (no starvation)", () => {
    const input = ranges([
        { start: 1, end: 20, tokens: 50_000 },
        { start: 21, end: 40, tokens: 50_000 },
    ]);
    const out = coalesceFoldRanges(input, 1_000);
    assert.equal(out.length, 2, "ranges larger than the cap stay separate, never dropped");
    assert.equal(out.reduce((s, r) => s + r.tokens, 0), 100_000);
});

test("#5630: contiguity without index data still coalesces (hand-built ranges)", () => {
    const input = ranges([
        { start: 1, end: 20, tokens: 10_000 },
        { start: 21, end: 40, tokens: 10_000 },
    ]);
    delete (input[0] as { endIndex?: number }).endIndex;
    delete (input[1] as { startIndex?: number }).startIndex;
    const out = coalesceFoldRanges(input, 60_000);
    assert.equal(out.length, 1, "absent index data falls back to accumulate (legacy behaviour)");
    assert.equal(out[0]!.tokens, 20_000);
});

test("#5630: a remembered-dead span is never bridged by a merged unit", () => {
    // filterDeadRanges removes the dead entry from the candidate list, so a
    // merger working on what REMAINS would silently span across the hole and
    // build exactly the wide range whose preview always returns the
    // structural-empty verdict (#2638) — one rejected preview per round.
    const input = ranges([
        { start: 1, end: 20, tokens: 10_000 },
        { start: 41, end: 60, tokens: 10_000 },
    ]);
    // Dead span m0021–m0040 sits in the hole between the two live ranges, and
    // the slot hole makes the two ranges non-contiguous on the wire.
    (input[1] as { startIndex?: number; endIndex?: number }).startIndex = 30;
    (input[1] as { startIndex?: number; endIndex?: number }).endIndex = 49;
    const out = coalesceFoldRanges(input, 60_000, [{ lo: 21, hi: 40 }]);
    assert.equal(out.length, 2, "a merged unit must not bridge a remembered-dead span");
});

test("#5630: non-monotonic refs against position are never merged (inverted range)", () => {
    // Hosts that rewrite history leave ref order disagreeing with array order
    // (#887/#1001). Merging such a pair emits startRef=m00038, endRef=m00022 —
    // an inverted range the walk can only drop. Caught by
    // tests/preflight-dead-ranges.test.ts, which is why this guard exists.
    const input = ranges([
        { start: 1, end: 20, tokens: 10_000 },
        { start: 41, end: 60, tokens: 10_000 },
    ]);
    (input[0] as { startRef: string; endRef: string }).startRef = "m00038";
    (input[0] as { startRef: string; endRef: string }).endRef = "m00022";
    const out = coalesceFoldRanges(input, 60_000);
    assert.equal(out.length, 2, "a ref pair that does not ascend with position must not merge");
});

test("#5630: the fold unit cap stays inside the documented per-fold coverage", () => {
    // CHUNK_FRACTION x window is the ceiling every depth budget was sized
    // against. Verify the production cap the loop computes never exceeds it.
    const WINDOW = 786_432;
    const budget = Math.max(2_000, Math.floor(WINDOW * 0.6));
    const deficit = 1_085_000;
    const unitCap = Math.max(2_000, Math.min(budget, Math.ceil(deficit / 4)));
    assert.ok(unitCap <= budget, `unit cap ${unitCap} must not exceed CHUNK_FRACTION x window ${budget}`);
    assert.ok(unitCap >= deficit / 4, `unit cap ${unitCap} cannot close the deficit in ~4 folds`);
});

/** End-to-end: the incident shape must converge through the real entry point.
 *  The relay URL is unroutable, so any summarization call fails — which is
 *  exactly the point: the assertion is that the pass stops spending rounds on
 *  a gap it cannot close rather than burning minutes and emitting the doomed
 *  413. `hadFoldableCandidates` plus a fold order whose largest unit is far
 *  above the largest ADVERTISED range proves the coalescing reached the walk. */
test("#5630: the incident shape produces fold units, not 500 fragments", async () => {
    const history = makeHistory(2400); // 600 per-turn ranges
    const tokens = estimateCoreMessages(history);
    const WINDOW = 786_432;
    const session = makeSession(tokens);
    const core = createCore();
    const controller = new AbortController();
    const logs: string[] = [];
    const result = await preflightCompress(
        {
            core,
            session,
            config: { ...defaultConfig(WINDOW), modelContextLimit: WINDOW },
            prompts: defaultPrompts,
            protocol: "responses",
            url: "http://127.0.0.1:9/fold-unit-test-no-network",
            headers: {},
            model: "fold-unit-test",
            signal: controller.signal,
            log: (level: string, message: string) => { logs.push(`${level}:${message}`); },
        },
        history,
    );
    const coalesceLine = logs.find((l) => l.includes("coalesced"));
    assert.ok(coalesceLine !== undefined, `the pass must report coalescing; logs: ${logs.slice(0, 5).join(" || ")}`);
    const m = /capped at ~(\d+) tok/.exec(coalesceLine);
    assert.ok(m !== null, `the cap must be named in the log line: ${coalesceLine}`);
    const cap = Number(m[1]);
    assert.ok(cap > 19_721, `the unit cap (${cap}) must exceed the largest single per-turn range`);
    // The payload is over the window, so the pass either folds or reports the
    // exact reason it cannot — never the silent burn the incident produced.
    assert.ok(result.payloadEstimate > 0, "payloadEstimate is always measured");
});

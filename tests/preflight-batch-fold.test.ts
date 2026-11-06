import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, createInitialState, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { _setBatchFoldForTest, estimateCoreMessages, preflightCompress, type PreflightResult } from "../src/preflight.ts";
import type { Session } from "../src/session.ts";

// #P3-A: the preflight emergency fold used to commit ONE range per kernel
// transaction (3 kernel projections per range, every one of them O(messages) for
// structural reasons), which at 8650 messages / 2162 ranges cost 234s per round.
// It now projects every candidate in a single multi-range applyCompression and
// commits them all in a single applyRanges call — two kernel passes per ROUND.
//
// These tests exist to prove the batching is invisible in the output: the state
// it commits must be IDENTICAL to the state the per-range walk commits, and a
// failure in either pass must leave the session exactly as it was. Both are
// checked against the same real entry point (preflightCompress) that production
// calls; the only difference is the _setBatchFoldForTest switch, which forces
// the legacy per-range walk.

// 3309 bytes/message, 4-message turn cycle — the shape the throughput work was
// measured on (27.3 MiB at 8650). At 200 messages the unit count (50) is past
// BATCH_FOLD_MIN_RANGES so the batched path is actually exercised.
const PARA =
    "The build pipeline finished with 3 warnings and no errors; the rollout was staged and the next step is to verify the kernel fold path against the resent history. ";
const TARGET_BYTES = 3309;

function makeHistory(n: number): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (let i = 0; i < n; i++) {
        const head = `${i}: `;
        const body = PARA.repeat(Math.ceil(TARGET_BYTES / PARA.length)).slice(0, TARGET_BYTES - head.length);
        const text = head + body;
        const slot = i % 4;
        if (slot === 0) out.push({ id: `m${i}`, role: "user", contentType: "text", text });
        else if (slot === 1) out.push({ id: `m${i}`, role: "assistant", contentType: "text", text });
        else if (slot === 2) out.push({ id: `m${i}`, role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: `call_${i}`, text });
        else out.push({ id: `m${i}`, role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: `call_${i - 1}`, text });
    }
    return out;
}

/** The shape the preflight bench drives (bench/per-turn-cost.ts): a minimal
 *  session whose only role is to carry state/stats for the fold loop. */
function makeSession(lastInputTokens: number): Session {
    return {
        id: "batch-fold-test",
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

const WINDOW = 200_000;
// 34.6x overshoot — the documented #2383 deterministic-digest regime (above the
// 19.2x coverage bound), so no summarization call is ever attempted and both
// runs are pure CPU.
const OVERSHOOT = 34.6;

interface RunOutcome {
    session: Session;
    result: PreflightResult;
}
interface RunOptions {
    batch: boolean;
    /** Wraps the kernel's applyCompression (the only kernel entry the fold
     *  loop uses) — used to inject a mid-batch failure. */
    instrument?: (core: ReturnType<typeof createCore>) => void;
}

async function runPreflight(n: number, opts: RunOptions, onSession?: (session: Session) => void): Promise<RunOutcome> {
    const history = makeHistory(n);
    const core = createCore();
    opts.instrument?.(core);
    const config = defaultConfig(WINDOW);
    const tokens = estimateCoreMessages(history);
    const limit = Math.max(1, Math.round(tokens / OVERSHOOT));
    const session = makeSession(tokens);
    const controller = new AbortController();
    onSession?.(session);
    _setBatchFoldForTest(!opts.batch);
    try {
        const result = await preflightCompress(
            {
                core,
                session,
                config: { ...config, modelContextLimit: limit },
                prompts: defaultPrompts,
                protocol: "responses",
                url: "http://127.0.0.1:9/batch-fold-test-no-network",
                headers: {},
                model: "batch-fold-test",
                signal: controller.signal,
                log: () => {},
            },
            history,
        );
        return { session, result };
    } finally {
        _setBatchFoldForTest(false);
    }
}

/** State projection with the three transaction-scoped / wall-clock fields
 *  dropped:
 *   - block.createdAt / durationMs are wall-clock,
 *   - nextRunId and block.runId identify the compress TRANSACTIONS a state went
 *     through. The per-range walk commits N one-range transactions (run ids
 *     r1…rN, nextRunId = N+1); the batched path commits one transaction per
 *     CHUNK (#P3-A4), like a model submitting one multi-range compress call per
 *     batch — which is the shape the kernel's run id is defined for. Nothing
 *     reads a run id for a decision (kernel/src/compress.ts only assigns it; src/
 *     only persists it through), so this is provenance, not state. The test
 *     asserts the exact relationship for both paths below instead of hiding it.
 *  Every other field — block ids, nextBlockId, coverage, summaries, tiers, token
 *  counts, ref maps — must match byte for byte, and that is what this checks. */
function stateFingerprint(session: Session): string {
    return JSON.stringify(
        session.state,
        (key, value) => (key === "createdAt" || key === "durationMs" || key === "runId" || key === "nextRunId" ? undefined : value),
        2,
    );
}

function contentFingerprint(session: Session): string {
    const entries = [...(session.blockContents ?? new Map()).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify(entries, (_key, value) => (value instanceof Map ? [...value.entries()] : value));
}

/** First differing offset with surrounding context — a plain assert.equal on two
 *  ~200 KB JSON strings is unreadable otherwise. */
function firstDiff(actual: string, expected: string): string {
    const n = Math.min(actual.length, expected.length);
    for (let i = 0; i < n; i++) {
        if (actual[i] !== expected[i]) {
            const from = Math.max(0, i - 160);
            return `first difference at offset ${i}\n  batched: ${JSON.stringify(actual.slice(from, i + 160))}\n  walk:    ${JSON.stringify(expected.slice(from, i + 160))}`;
        }
    }
    return actual.length === expected.length ? "(no difference)" : `length differs: batched=${actual.length} walk=${expected.length} (common prefix ${n})`;
}

test("#P3-A: batched emergency fold commits the SAME state as the per-range walk", async () => {
    const N = 200;
    const serial = await runPreflight(N, { batch: false });
    const batched = await runPreflight(N, { batch: true });

    // The scenario must really be the batched regime: enough units to trip
    // BATCH_FOLD_MIN_RANGES and a digest fold in both runs.
    assert.ok((serial.result.compressedRanges ?? 0) >= 32, `the per-range walk folded >= 32 ranges (got ${serial.result.compressedRanges})`);
    assert.equal(batched.result.compressedRanges, serial.result.compressedRanges, "same number of ranges folded");
    assert.equal(batched.result.fitsWindow, serial.result.fitsWindow, "same fit verdict");
    assert.equal(batched.result.failure?.kind, serial.result.failure?.kind, "same exhaustion verdict");
    assert.equal(batched.result.payloadEstimate, serial.result.payloadEstimate, "same post-fold payload estimate");
    assert.equal(batched.result.hadFoldableCandidates, serial.result.hadFoldableCandidates, "same candidate verdict");

    // ... and the committed state is identical block for block.
    const serialState = stateFingerprint(serial.session);
    const batchedState = stateFingerprint(batched.session);
    assert.equal(batchedState, serialState, `batched commit produced an identical kernel state (block ids, coverage, summaries, tiers, mass)\n${firstDiff(batchedState, serialState)}`);

    const serialBlocks = serial.session.state.blocks.filter((block) => block.active);
    const batchedBlocks = batched.session.state.blocks.filter((block) => block.active);
    assert.equal(batchedBlocks.length, serialBlocks.length, "same active block count");
    for (let i = 0; i < serialBlocks.length; i++) {
        assert.equal(batchedBlocks[i]!.blockId, serialBlocks[i]!.blockId, `block ${i}: same id (allocation order preserved)`);
        assert.equal(batchedBlocks[i]!.summary, serialBlocks[i]!.summary, `block ${i}: same digest text`);
        assert.deepEqual(batchedBlocks[i]!.directMessageIds, serialBlocks[i]!.directMessageIds, `block ${i}: same direct coverage`);
        assert.deepEqual(batchedBlocks[i]!.effectiveMessageIds, serialBlocks[i]!.effectiveMessageIds, `block ${i}: same effective coverage`);
        assert.deepEqual(batchedBlocks[i]!.directBlockIds, serialBlocks[i]!.directBlockIds, `block ${i}: same nested blocks`);
        assert.equal(batchedBlocks[i]!.compressedTokens, serialBlocks[i]!.compressedTokens, `block ${i}: same compressed mass`);
        assert.equal(batchedBlocks[i]!.tier, serialBlocks[i]!.tier, `block ${i}: same tier`);
        assert.equal(batchedBlocks[i]!.topic, serialBlocks[i]!.topic, `block ${i}: same topic`);
        assert.equal(batchedBlocks[i]!.active, serialBlocks[i]!.active, `block ${i}: same active flag`);
    }
    // Transaction shape: the walk commits one transaction per fold; the batched
    // path commits one per CHUNK (#P3-A4 chunked the batch and yields between
    // chunks), so it uses FEWER transactions than the walk but more than the
    // single one it used before chunking. Run ids are therefore scheduling, not
    // semantics — the state fingerprint above normalises them (see
    // stateFingerprint) and every block-level field still has to match.
    const batchedTransactions = new Set(batchedBlocks.map((block) => block.runId)).size;
    assert.ok(
        batchedTransactions >= 1 && batchedTransactions < serialBlocks.length,
        `the batch commits per chunk, not per fold (got ${batchedTransactions} transactions for ${batchedBlocks.length} folds)`,
    );
    assert.equal(new Set(serialBlocks.map((block) => block.runId)).size, serialBlocks.length, "the walk commits one transaction per fold");
    assert.equal(batched.session.state.nextRunId, batchedTransactions + 1, "the batch consumed one run id per chunk");
    assert.equal(serial.session.state.nextRunId, serialBlocks.length + 1, "the walk consumed one run id per fold");
    assert.equal(batched.session.state.nextBlockId, serial.session.state.nextBlockId, "same block-id high-water mark");

    // The originals cache (what decompress/range-restore reads back) matches too.
    assert.equal(contentFingerprint(batched.session), contentFingerprint(serial.session), "same folded-original content cache");

    // Accounting is summed rather than applied per fold — prove the sums agree.
    assert.equal(batched.session.stats.compressCreditTokens, serial.session.stats.compressCreditTokens, "same compress credit");
    assert.equal(batched.session.stats.lastInputTokens, serial.session.stats.lastInputTokens, "same input baseline");
});

test("#P3-A: a failure in the commit pass leaves the session untouched (no half-batch)", async () => {
    const N = 200;
    // The first applyCompression is the batch's projection pass; every later one
    // (the commit pass, and anything a fallback walk would try) throws. By then
    // the projection has already produced ~50 blocks IN MEMORY — none of them
    // may reach the session.
    let calls = 0;
    const instrument = (core: ReturnType<typeof createCore>): void => {
        const real = core.applyCompression.bind(core);
        core.applyCompression = ((input: Parameters<typeof real>[0]) => {
            calls += 1;
            if (calls > 1) throw new Error("injected commit-pass failure");
            return real(input);
        }) as typeof core.applyCompression;
    };
    let captured: Session | undefined;
    await assert.rejects(
        () => runPreflight(N, { batch: true, instrument }, (session) => { captured = session; }),
        /injected commit-pass failure/,
        "the injected commit-pass failure surfaces",
    );
    assert.ok(calls > 1, "the batch got past its projection pass before failing");
    assert.ok(captured, "session captured");
    const landed = captured as Session;
    assert.equal(landed.state.blocks.length, 0, "no block survived the failed batch");
    assert.equal(landed.stats.compressCreditTokens, 0, "no compress credit was netted");
    assert.equal(landed.blockContents?.size ?? 0, 0, "no folded-original content was cached");
});

test("#P3-A premise: kernel multi-range apply is all-or-nothing per call, per-range only for classification", () => {
    // The batched path relies on these two kernel contracts:
    //   (a) a call-level rejection (any batch-level gate, e.g. summary lengths)
    //       commits NOTHING — so a batch can never leave a partially folded
    //       prefix behind;
    //   (b) a classification-level failure (unknown / invalid ref) does NOT roll
    //       the batch back — the foldable siblings still land. That is exactly
    //       why the batched preflight path refuses to proceed when the
    //       projection reports ANY error and falls back to the per-range walk,
    //       which reproduces the walk's per-range skip notes for those ranges.
    const history = makeHistory(40);
    const core = createCore();
    const config = defaultConfig(WINDOW);
    // Seed refs the way a real request does (assignRefs runs inside processTurn).
    const seeded = core.processTurn({
        messages: history,
        state: createInitialState(),
        config,
        tokenCount: 1,
        renderTags: "text-only",
    }).state;
    const summary = "x".repeat(Math.max(50, config.compress.minSummaryLength));

    // (b) classification error: siblings commit, the bad range is reported.
    const classified = core.applyCompression({
        messages: history,
        state: seeded,
        config,
        ranges: [
            { startRef: "m00001", endRef: "m00004", summary },
            { startRef: "m00005", endRef: "m00008", summary },
            { startRef: "m00009", endRef: "m99999", summary },
        ],
    });
    assert.ok(classified.result.errors.length > 0, "the unresolvable range is reported");
    assert.equal(classified.result.blocksCreated, 2, "classification failures are per-range: the foldable siblings commit");

    // (a) call-level rejection: one over-long summary rejects the WHOLE batch
    // (kernel #3003 all-or-nothing length pre-check), so the healthy sibling
    // must not land either.
    const overLong = "y".repeat(Math.max(1, config.compress.maxSummaryLength) + 10);
    const rejected = core.applyCompression({
        messages: history,
        state: seeded,
        config,
        ranges: [
            { startRef: "m00001", endRef: "m00004", summary },
            { startRef: "m00009", endRef: "m00012", summary: overLong },
        ],
    });
    assert.ok(rejected.result.errors.length > 0, `the oversized summary is reported (errors: ${JSON.stringify(rejected.result.errors.slice(0, 2))})`);
    assert.equal(rejected.result.blocksCreated, 0, "a call-level rejection rolls back the whole batch");
    assert.deepEqual(rejected.state.blocks, seeded.blocks, "returned state carries no partial fold");
});

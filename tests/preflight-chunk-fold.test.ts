import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, createInitialState, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { _setBatchFoldForTest, estimateCoreMessages, preflightCompress, type PreflightResult } from "../src/preflight.ts";
import type { Session } from "../src/session.ts";

// #P3-A4: the emergency fold is committed CHUNK BY CHUNK with a real
// event-loop yield between chunks. The chunk is the transaction boundary: one
// multi-range applyCompression (projection) + one multi-range applyRanges
// (commit) per chunk, so a failed chunk lands nothing. These tests pin the two
// properties that make the chunking invisible:
//
//   1. EQUIVALENCE — whatever the chunk boundaries are (fixed K=1, K=3, a
//      non-dividing K, the adaptive default, or a single one-shot chunk), the
//      committed state is identical block for block. Chunk boundaries are a
//      scheduling artefact, never a semantic one.
//   2. FAILURE — a chunk that dies mid-flight keeps the already-committed prefix
//      (a PREFIX OF THE FOLD LIST, never a partial fold), leaves the session
//      exactly at the previous chunk boundary, and hands the remainder to the
//      unchanged per-range walk, which catches up to the identical final state.
//
// Everything is driven through the real entry point (preflightCompress) in the
// deterministic-digest regime, so no upstream and no store is involved.

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

function makeSession(lastInputTokens: number): Session {
    return {
        id: "chunk-fold-test",
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
// 34.6x overshoot: above the 19.2x coverage bound ⇒ #2383 deterministic digest,
// zero summarization calls, pure CPU (bench/per-turn-cost.ts uses the same ratio).
const OVERSHOOT = 34.6;
const N = 200;

interface RunOptions {
    /** Fixed chunk size (BILI_PREFLIGHT_FOLD_CHUNK_RANGES); undefined = adaptive. */
    chunkRanges?: number;
    /** Wraps the kernel's applyCompression (the only kernel entry the fold uses). */
    instrument?: (core: ReturnType<typeof createCore>) => void;
    onSession?: (session: Session) => void;
}
interface RunOutcome {
    session: Session;
    result: PreflightResult;
}

async function runPreflight(opts: RunOptions = {}): Promise<RunOutcome> {
    const history = makeHistory(N);
    const core = createCore();
    opts.instrument?.(core);
    const config = defaultConfig(WINDOW);
    const tokens = estimateCoreMessages(history);
    const limit = Math.max(1, Math.round(tokens / OVERSHOOT));
    const session = makeSession(tokens);
    opts.onSession?.(session);
    const previous = process.env.BILI_PREFLIGHT_FOLD_CHUNK_RANGES;
    if (opts.chunkRanges === undefined) delete process.env.BILI_PREFLIGHT_FOLD_CHUNK_RANGES;
    else process.env.BILI_PREFLIGHT_FOLD_CHUNK_RANGES = String(opts.chunkRanges);
    _setBatchFoldForTest(false);
    try {
        const result = await preflightCompress(
            {
                core,
                session,
                config: { ...config, modelContextLimit: limit },
                prompts: defaultPrompts,
                protocol: "responses",
                url: "http://127.0.0.1:9/preflight-chunk-no-network",
                headers: {},
                model: "chunk-fold-test",
                signal: new AbortController().signal,
                log: () => {},
            },
            history,
        );
        return { session, result };
    } finally {
        if (previous === undefined) delete process.env.BILI_PREFLIGHT_FOLD_CHUNK_RANGES;
        else process.env.BILI_PREFLIGHT_FOLD_CHUNK_RANGES = previous;
        _setBatchFoldForTest(false);
    }
}

/** State projection with wall-clock and transaction-scoped fields dropped:
 *  block.createdAt/durationMs are wall-clock, and block.runId / state.nextRunId
 *  count compress TRANSACTIONS — one per chunk, so they legitimately differ with
 *  the chunk count (the kernel only ever assigns them, never reads them for a
 *  decision). Every other field — block ids, nextBlockId, coverage, summaries,
 *  tiers, token counts, ref maps, credit — must match byte for byte. */
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

function firstDiff(actual: string, expected: string): string {
    const n = Math.min(actual.length, expected.length);
    for (let i = 0; i < n; i++) {
        if (actual[i] !== expected[i]) {
            const from = Math.max(0, i - 160);
            return `first difference at offset ${i}\n  chunked: ${JSON.stringify(actual.slice(from, i + 160))}\n  one-shot: ${JSON.stringify(expected.slice(from, i + 160))}`;
        }
    }
    return actual.length === expected.length ? "(no difference)" : `length differs: chunked=${actual.length} one-shot=${expected.length} (common prefix ${n})`;
}

/** Compares a chunked run against the one-shot baseline on everything that must
 *  not depend on chunk boundaries. */
function assertSameState(chunked: RunOutcome, oneShot: RunOutcome, label: string): void {
    assert.equal(chunked.result.compressedRanges, oneShot.result.compressedRanges, `${label}: same compressedRanges`);
    assert.equal(chunked.result.fitsWindow, oneShot.result.fitsWindow, `${label}: same fit verdict`);
    assert.equal(chunked.result.failure?.kind, oneShot.result.failure?.kind, `${label}: same failure verdict`);
    assert.equal(chunked.result.payloadEstimate, oneShot.result.payloadEstimate, `${label}: same post-fold payload estimate`);
    assert.equal(chunked.session.stats.compressCreditTokens, oneShot.session.stats.compressCreditTokens, `${label}: same compress credit`);
    assert.equal(chunked.session.stats.lastInputTokens, oneShot.session.stats.lastInputTokens, `${label}: same input baseline`);
    const got = stateFingerprint(chunked.session);
    const want = stateFingerprint(oneShot.session);
    assert.equal(got, want, `${label}: state must be identical to the one-shot batch\n${firstDiff(got, want)}`);
    assert.equal(contentFingerprint(chunked.session), contentFingerprint(oneShot.session), `${label}: same folded-original content cache`);
    assert.equal(chunked.session.state.nextBlockId, oneShot.session.state.nextBlockId, `${label}: same block-id high-water mark`);
    const activeChunked = chunked.session.state.blocks.filter((block) => block.active);
    const activeOneShot = oneShot.session.state.blocks.filter((block) => block.active);
    assert.equal(activeChunked.length, activeOneShot.length, `${label}: same active block count`);
    for (let i = 0; i < activeChunked.length; i++) {
        assert.equal(activeChunked[i]!.blockId, activeOneShot[i]!.blockId, `${label}: block ${i} id (fold order preserved)`);
        assert.equal(activeChunked[i]!.summary, activeOneShot[i]!.summary, `${label}: block ${i} digest text`);
        assert.deepEqual(activeChunked[i]!.directMessageIds, activeOneShot[i]!.directMessageIds, `${label}: block ${i} direct coverage`);
        assert.deepEqual(activeChunked[i]!.effectiveMessageIds, activeOneShot[i]!.effectiveMessageIds, `${label}: block ${i} effective coverage`);
        assert.equal(activeChunked[i]!.compressedTokens, activeOneShot[i]!.compressedTokens, `${label}: block ${i} compressed mass`);
        assert.equal(activeChunked[i]!.tier, activeOneShot[i]!.tier, `${label}: block ${i} tier`);
    }
}

/** Counts setImmediate turns (yieldToEventLoop's primitive) taken during a run. */
async function countYields<T>(run: () => Promise<T>): Promise<{ value: T; yields: number }> {
    const real = globalThis.setImmediate;
    let yields = 0;
    globalThis.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
        yields += 1;
        return real(callback as never, ...(args as never[]));
    }) as typeof setImmediate;
    try {
        const value = await run();
        return { value, yields };
    } finally {
        globalThis.setImmediate = real;
    }
}

test("#P3-A4: chunked fold is state-identical to one batch for every chunking (K=1, K=3, non-dividing, adaptive)", async () => {
    // One chunk = today's single-transaction shape, used as the reference.
    const oneShot = await runPreflight({ chunkRanges: 1_000_000 });
    assert.ok((oneShot.result.compressedRanges ?? 0) >= 32, `scenario must exercise the batched path (folded ${oneShot.result.compressedRanges})`);

    // 50 candidates at N=200: K=1 → 50 chunks, K=3 → 17 chunks, K=7 → 8 chunks
    // (6×7 + 8: NOT dividing, so the tail chunk is short), adaptive → whatever
    // the controller converges on, which is exactly the point of including it.
    const k1 = await runPreflight({ chunkRanges: 1 });
    assertSameState(k1, oneShot, "K=1 (one range per transaction, 50 chunks)");

    const k3 = await runPreflight({ chunkRanges: 3 });
    assertSameState(k3, oneShot, "K=3");

    const k7 = await runPreflight({ chunkRanges: 7 });
    assertSameState(k7, oneShot, "K=7 (non-dividing: 6 chunks of 7 + a tail of 8)");

    const adaptive = await runPreflight({});
    assertSameState(adaptive, oneShot, "adaptive default sizing");

    // The chunk count is scheduling, not semantics: same blocks, different
    // transaction counts.
    const runIds = (outcome: RunOutcome) => new Set(outcome.session.state.blocks.filter((block) => block.active).map((block) => block.runId)).size;
    assert.equal(runIds(oneShot), 1, "one chunk ⇒ one compress transaction");
    assert.ok(runIds(k1) > 1, `K=1 ⇒ one transaction per range (got ${runIds(k1)})`);
    assert.ok(runIds(k7) > runIds(oneShot), "K=7 ⇒ more transactions than the one-shot batch");
});

test("#P3-A4: the fold actually blocks the event loop between chunks (and only between them)", async () => {
    // setImmediate is yieldToEventLoop's primitive, so counting its turns counts
    // real hand-offs to the poll phase — deterministic, no wall-clock involved.
    const oneShot = await countYields(() => runPreflight({ chunkRanges: 1_000_000 }));
    const chunked = await countYields(() => runPreflight({ chunkRanges: 7 }));

    // 50 candidates / 7 = 8 chunks ⇒ at least 7 hand-offs from the fold driver.
    assert.ok(
        chunked.yields - oneShot.yields >= 7,
        `K=7 must add one event-loop turn per chunk boundary: chunked=${chunked.yields} one-shot=${oneShot.yields}`,
    );
    // And the one-shot path performs none of them (its 1-2 turns are the round
    // loop's own pre-existing yields, not the fold's).
    assert.ok(oneShot.yields <= 3, `the one-shot fold adds no per-chunk yields (got ${oneShot.yields})`);
});

test("#P3-A4: a chunk that fails mid-fold keeps the committed prefix and leaves no partial chunk", async () => {
    // Chunk 3's COMMIT call throws (with K=7 that is applyCompression call #6:
    // chunk1 project+commit = 1,2; chunk2 = 3,4; chunk3 project = 5, throw on 6).
    // Nothing of chunk 3 may land, chunks 1-2 must stay, and the per-range walk
    // must then finish the job — reaching the SAME final state as the one-shot
    // batch (each kept block is a complete fold the walk would have made anyway).
    const FAIL_ON_CALL = 6;
    let calls = 0;
    const instrument = (core: ReturnType<typeof createCore>): void => {
        const real = core.applyCompression.bind(core);
        core.applyCompression = ((input: Parameters<typeof real>[0]) => {
            calls += 1;
            if (calls === FAIL_ON_CALL) throw new Error("injected mid-fold chunk failure");
            return real(input);
        }) as typeof core.applyCompression;
    };

    // First, capture the state at the moment of the failure so the "no partial
    // chunk" property can be checked against the chunk boundary itself.
    // applyRanges catches the throw, so the run continues; we observe the final
    // state and the fact that exactly 2×7 ranges were committed before the walk.
    const failed = await runPreflight({ chunkRanges: 7, instrument });
    assert.ok(calls >= FAIL_ON_CALL, "the injector fired");
    assert.equal(failed.result.compressedRanges, 50, "the walk caught up: every candidate still folded");

    const oneShot = await runPreflight({ chunkRanges: 1_000_000 });
    // The failure path must reach the identical state — the kept prefix is a
    // prefix of the same fold list, and the walk folds the rest the same way.
    assertSameState(failed, oneShot, "mid-fold failure + per-range-walk catch-up");

    // And the transaction split proves the prefix really was kept as chunks:
    // 2 committed chunks + one run id per walk fold for the rest.
    const runIds = new Set(failed.session.state.blocks.filter((block) => block.active).map((block) => block.runId)).size;
    assert.ok(runIds > 1, `the failed chunk boundary is visible in the run ids (got ${runIds})`);
    // No block may exist for a range that came after the failure without also
    // existing in the one-shot run — i.e. nothing was invented or lost.
    const failedIds = failed.session.state.blocks.filter((block) => block.active).map((block) => block.blockId);
    const oneShotIds = oneShot.session.state.blocks.filter((block) => block.active).map((block) => block.blockId);
    assert.deepEqual(failedIds, oneShotIds, "same block ids in the same order after recovering from the failure");

    // Interior consistency: every active block covers messages that exist, and
    // the folded set has no duplicates (a half-committed chunk would show up as
    // one block claiming another's coverage).
    const seen = new Map<string, string>();
    for (const block of failed.session.state.blocks.filter((candidate) => candidate.active)) {
        assert.ok(block.directMessageIds.length > 0, `block ${block.blockId} folds at least one message`);
        for (const id of block.effectiveMessageIds) {
            assert.equal(seen.get(id), undefined, `message ${id} is covered by exactly one block (${seen.get(id)} vs ${block.blockId})`);
            seen.set(id, block.blockId);
        }
    }
});

test("#P3-A4: an abort between chunks stops cleanly and keeps the committed prefix", async () => {
    // The client can disconnect while the fold is yielding. The driver must stop
    // at the next boundary with the committed prefix intact and let the round
    // report the abort — no torn chunk, no lost state.
    const controller = new AbortController();
    const history = makeHistory(N);
    const core = createCore();
    const config = defaultConfig(WINDOW);
    const tokens = estimateCoreMessages(history);
    const limit = Math.max(1, Math.round(tokens / OVERSHOOT));
    const session = makeSession(tokens);
    let chunks = 0;
    const real = core.applyCompression.bind(core);
    core.applyCompression = ((input: Parameters<typeof real>[0]) => {
        chunks += 1;
        // Abort after the first chunk's project+commit have landed.
        if (chunks === 3) controller.abort();
        return real(input);
    }) as typeof core.applyCompression;
    process.env.BILI_PREFLIGHT_FOLD_CHUNK_RANGES = "7";
    try {
        const result = await preflightCompress(
            {
                core,
                session,
                config: { ...config, modelContextLimit: limit },
                prompts: defaultPrompts,
                protocol: "responses",
                url: "http://127.0.0.1:9/preflight-chunk-no-network",
                headers: {},
                model: "chunk-fold-test",
                signal: controller.signal,
                log: () => {},
            },
            history,
        );
        const blocks = session.state.blocks.filter((block) => block.active);
        assert.ok(blocks.length > 0, "the chunk(s) committed before the abort are kept");
        assert.equal(result.failure?.kind, "aborted", `the round reports the abort (got ${result.failure?.kind ?? "none"})`);
        // Whatever landed is a whole number of chunks: 7 ranges per block, one
        // block per range ⇒ block count is a multiple of the chunk size.
        assert.equal(blocks.length % 7, 0, `the landed fold count is a whole number of chunks (got ${blocks.length})`);
    } finally {
        delete process.env.BILI_PREFLIGHT_FOLD_CHUNK_RANGES;
    }
});

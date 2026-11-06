/**
 * P1 bench: per-turn stage cost at the reported real scale
 * (8650 messages / single request ≈ 27.3 MiB).
 *
 * WHAT THIS MEASURES (all against the REAL shipped code — nothing re-implemented):
 *   S0  estimateCoreMessages            src/preflight.ts  (the estimate layer)
 *   S1  processTurn  (cold state, under window)   acp-kernel core.processTurn
 *   S1b processTurn  (over window → emergency-truncate armed)
 *   S1n processTurn  node-by-node attribution: the exact kernel pipeline nodes
 *       (core.defaultNodes(), render-refs swapped to the "text-only" strategy
 *       bili passes) driven one at a time — validates its sum against S1.
 *   S2  reconcileFoldCoverage  COLD round   src/fold-reconcile.ts
 *   S3  reconcileFoldCoverage  STEADY round (same ids resent, anchor reuse)
 *   S4  preflightCompress      the whole per-request round loop
 *       src/preflight.ts (the #2041 `for (let round …)` walk) — real entry,
 *       driven with a deterministic-digest regime so it needs no upstream.
 *
 * Isolation: run under
 *   BILI_SESSIONS_DIR / XDG_STATE_HOME / XDG_CONFIG_HOME / XDG_CACHE_HOME
 *   pointed at fresh %TEMP% dirs, BILLION_CONTEXT_NATIVE removed.
 *   This file never opens the real store; it never touches ~/.local/state or
 *   ~/.dsh.
 *
 * Usage:  node --expose-gc --import tsx bench/per-turn-cost.ts [n]
 *         (no argument = the full 1000 / 2000 / 4000 / 8650 matrix)
 */
import {
    createContentStore,
    createCore,
    createInitialState,
    createRenderRefsNode,
    defaultConfig,
    defaultCountTokens,
    defaultPrompts,
    makeIO,
    type CoreMessage,
    type PipelineNode,
} from "acp-kernel";
import { estimateCoreMessages, preflightCompress } from "../src/preflight.ts";
import { reconcileFoldCoverage } from "../src/fold-reconcile.ts";
import type { Session } from "../src/session.ts";

// ---------------------------------------------------------------------------
// Synthetic history. 8650 messages × 3309 bytes = 27.30 MiB, matching the
// reported "8650 messages / ≈27.3 MiB single request" scale. Message shape
// cycles user text → assistant text → assistant tool-call → tool-result so
// turn-integrity grouping and tool pairs are exercised like real traffic.
// ---------------------------------------------------------------------------
const TARGET_BYTES = 3309;
const PARA =
    "The build pipeline finished with 3 warnings and no errors; the rollout was staged and the next step is to verify the kernel fold path against the resent history. ";

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

// ---------------------------------------------------------------------------
// Timing helpers. Median (not mean) of 3, GC between reps.
// ---------------------------------------------------------------------------
function ms(fn: () => unknown): number {
    const s = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - s) / 1e6;
}
function gc(): void {
    (globalThis as { gc?: () => void }).gc?.();
}
function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
}
function measure3(fn: () => unknown): number[] {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
        gc();
        runs.push(ms(fn));
    }
    return runs;
}

const WINDOW = 200_000; // the reported incident's window (200k-token model)
// The reported case is ~6.9M estimated tokens against a 200k window ≈ 34.6×.
// Every scale is run at that SAME overshoot ratio so the preflight regime
// (deterministic-digest fold, #2383) is identical across the matrix; at 8650
// this is exactly the real 200k-window case.
const OVERSHOOT = 34.6;

type Row = Record<string, number | string>;
const results: Record<string, Row> = {};

// ---------------------------------------------------------------------------
// S1n: node-by-node attribution of the kernel fold pass.
// ---------------------------------------------------------------------------
function timeNodes(
    history: CoreMessage[],
    config: ReturnType<typeof defaultConfig>,
): { timings: Array<[string, number]>; units: number; ranges: number } {
    const core = createCore();
    const nodes: PipelineNode[] = core.defaultNodes();
    if (nodes[nodes.length - 1]?.name === "render-refs") nodes[nodes.length - 1] = createRenderRefsNode("text-only");
    const ctx = { config, tokenCount: 1, countTokens: defaultCountTokens, contentStore: createContentStore() };
    let io = makeIO(history, createInitialState(), { applyView: undefined });
    const out: Array<[string, number]> = [];
    for (const node of nodes) {
        if (node.enabled && !node.enabled(io, ctx)) {
            out.push([node.name, Number.NaN]); // skipped this pass
            continue;
        }
        const t = ms(() => {
            io = node.run(io, ctx);
        });
        out.push([node.name, t]);
    }
    // How many candidate units the recommend node advertised to the model —
    // this is the multiplier on projectUnit's per-unit O(messages) re-scan.
    const nudge = io.effects.nudge as { compressibleRanges?: unknown[] } | undefined;
    return {
        timings: out,
        units: nudge?.compressibleRanges?.length ?? -1,
        ranges: io.effects.recommendation ? 1 : 0,
    };
}

function runScale(n: number): Row {
    const history = makeHistory(n);
    const bytes = history.reduce((a, m) => a + Buffer.byteLength(m.text ?? "", "utf8"), 0);
    const core = createCore();
    const config = defaultConfig(WINDOW);
    const tokens = estimateCoreMessages(history);
    const limit = Math.max(1, Math.round(tokens / OVERSHOOT));

    // --- S0 estimate layer
    const est = measure3(() => estimateCoreMessages(history));

    // --- S1 processTurn, cold state, comfortably under the window
    const ptCold = measure3(() =>
        core.processTurn({ messages: history, state: createInitialState(), config, tokenCount: 1, renderTags: "text-only" }),
    );

    // --- S1b processTurn with truncation armed (judged over the window)
    const ptOver = measure3(() =>
        core.processTurn({
            messages: history,
            state: createInitialState(),
            config,
            tokenCount: tokens + 10 * config.modelContextLimit,
            renderTags: "text-only",
        }),
    );

    // --- S1n node attribution (median per node over 3 walks)
    const walks: Array<ReturnType<typeof timeNodes>> = [];
    for (let i = 0; i < 3; i++) {
        gc();
        walks.push(timeNodes(history, config));
    }
    const nodeNames = walks[0]!.timings.map(([name]) => name);
    const nodeMedian: Array<[string, number]> = nodeNames.map((name, idx) => [name, median(walks.map((w) => w.timings[idx]![1]))]);
    const nodeSum = nodeMedian.reduce((a, [, t]) => a + (Number.isNaN(t) ? 0 : t), 0);

    // --- S2/S3 reconcileFoldCoverage: cold round vs steady (anchor-reuse) round
    const ids = history.map((m) => m.id!);
    const makeSession = (): Session =>
        ({ state: { blocks: [{ active: true, effectiveMessageIds: ids }] }, metadata: {} }) as unknown as Session;
    const opts = { mode: "repair" as const, sessionId: "bench", log: () => {} };
    const recColdRuns: number[] = [];
    for (let i = 0; i < 3; i++) {
        gc();
        const s = makeSession(); // fresh session per cold run — a reused one would be warm
        recColdRuns.push(ms(() => reconcileFoldCoverage(s, history, opts)));
    }
    const warmSession = makeSession();
    reconcileFoldCoverage(warmSession, history, opts); // seed anchors
    const recWarmRuns: number[] = [];
    for (let i = 0; i < 3; i++) {
        gc();
        recWarmRuns.push(ms(() => reconcileFoldCoverage(warmSession, history, opts)));
    }

    return {
        n,
        bytesMiB: bytes / 1048576,
        tokens,
        preflightLimit: limit,
        estimate: median(est),
        ptCold: median(ptCold),
        ptOver: median(ptOver),
        nodeSum,
        units: median(walks.map((w) => w.units)),
        recCold: median(recColdRuns),
        recWarm: median(recWarmRuns),
        nodeDetail: nodeMedian.map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" "),
    };
}

// ---------------------------------------------------------------------------
// S4: preflightCompress — the whole per-request round loop.
//
// The real entry point, driven with the same window/overshoot as the real
// 8650-message case. That overshoot puts it in the #2383 deterministic-digest
// regime (no summarization calls, so no fake upstream needed) — which is
// exactly the regime the reported 27.3 MiB incident runs in.
//
// A wall-clock budget aborts the walk (`deps.signal`) when a scale would need
// more rounds than we are willing to spend; the round count reached plus the
// announced round cap let us project the full cost instead of inventing it.
// ---------------------------------------------------------------------------
async function runPreflight(n: number, budgetMs: number): Promise<Row> {
    const history = makeHistory(n);
    const core = createCore();
    const config = defaultConfig(WINDOW);
    const tokens = estimateCoreMessages(history);
    const limit = Math.max(1, Math.round(tokens / OVERSHOOT));
    const logs: string[] = [];
    const controller = new AbortController();
    const session = {
        id: "bench-preflight",
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
            lastInputTokens: tokens,
            compressCreditTokens: 0,
            contextTokens: tokens,
            retrieveCalls: 0,
            retrieveHits: 0,
            retrieveMisses: 0,
            storedBytes: 0,
            storeBytesSaved: 0,
            rangeRestores: 0,
        },
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as unknown as Session;
    let rounds = 0;
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const started = process.hrtime.bigint();
    let result: Awaited<ReturnType<typeof preflightCompress>> | undefined;
    let error: string | undefined;
    try {
        result = await preflightCompress(
            {
                core,
                session,
                config: { ...config, modelContextLimit: limit },
                prompts: defaultPrompts,
                protocol: "responses",
                url: "http://127.0.0.1:9/bench-no-network", // digest regime never egresses
                headers: {},
                model: "bench",
                signal: controller.signal,
                log: (_level: string, message: string) => {
                    logs.push(message);
                    if (/^\[preflight\] round \d+\//.test(message)) rounds++;
                },
            },
            history,
        );
    } catch (e) {
        error = e instanceof Error ? e.message : String(e);
    } finally {
        clearTimeout(timer);
    }
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    const capMatch = /round \d+\/(\d+)/.exec(logs.find((l) => /round \d+\/\d+/.test(l)) ?? "");
    const cap = capMatch ? Number(capMatch[1]) : Number.NaN;
    return {
        n,
        elapsed,
        rounds,
        cap,
        aborted: controller.signal.aborted ? "yes" : "no",
        perRound: rounds > 0 ? elapsed / rounds : Number.NaN,
        compressedRanges: result?.compressedRanges ?? -1,
        fitsWindow: String(result?.fitsWindow),
        failure: result?.failure?.kind ?? error ?? "none",
    };
}

// ---------------------------------------------------------------------------
const SCALES = process.argv[2] ? [Number(process.argv[2])] : [1000, 2000, 4000, 8650];
const PREFLIGHT_BUDGET_MS = Number(process.env.BENCH_PREFLIGHT_BUDGET_MS ?? 60_000);

console.log(`# per-turn cost bench — window=${WINDOW} overshoot=${OVERSHOOT}×`);
for (const n of SCALES) {
    const row = runScale(n);
    results[String(n)] = row;
    console.log(
        `\nn=${n}  ${(row.bytesMiB as number).toFixed(2)}MiB  est=${(row.tokens as number).toLocaleString()}tok  preflightLimit=${row.preflightLimit}` +
            `\n  estimateCoreMessages ${(row.estimate as number).toFixed(2)}ms` +
            `\n  processTurn cold     ${(row.ptCold as number).toFixed(1)}ms` +
            `\n  processTurn over     ${(row.ptOver as number).toFixed(1)}ms` +
            `\n  processTurn nodewalk ${(row.nodeSum as number).toFixed(1)}ms` +
            `\n  reconcile cold       ${(row.recCold as number).toFixed(1)}ms` +
            `\n  reconcile steady     ${(row.recWarm as number).toFixed(2)}ms` +
            `\n  candidate units      ${row.units}` +
            `\n  nodes: ${row.nodeDetail}`,
    );
    process.stdout.write(`  preflight ${n}: running… `);
    const pf = await runPreflight(n, PREFLIGHT_BUDGET_MS);
    results[`preflight:${n}`] = pf;
    console.log(
        `rounds=${pf.rounds}/${pf.cap} elapsed=${(pf.elapsed as number).toFixed(0)}ms compressed=${pf.compressedRanges} ` +
            `fits=${pf.fitsWindow} aborted=${pf.aborted} failure=${pf.failure}`,
    );
}

const { writeFileSync } = await import("node:fs");
writeFileSync(new URL("./results-per-turn-cost.json", import.meta.url), JSON.stringify(results, null, 2));
console.log("\nwrote bench/results-per-turn-cost.json");

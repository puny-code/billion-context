/**
 * P2 — `recommend` node linearization: equivalence evidence.
 *
 * `screenRecommendedUnits` projects every advertised unit through `projectUnit`,
 * and `projectUnit` used to re-derive per-TURN facts (id index, protected-tool
 * verdicts, pair maps, turn groups, integrity fixed point) for every unit. At
 * 8650 messages that is O(units × messages) ≈ 6.5s per fold pass. The fix hoists
 * those facts into one `createProjectionContext` per screening call (per turn
 * only — never across turns, messages/state change there).
 *
 * These tests pin the two halves of the proof:
 *
 *  1. SNAPSHOT — the observable output (recommended ranges + every unit's full
 *     projection, warnings included) is unchanged from the pre-fix build. The
 *     digest below was produced by the code at HEAD (03c5e4bf) before this
 *     change; it covers a bench-shaped log (user / assistant / tool-call /
 *     tool-result cycle like the production regression) and a hand-built
 *     fixture that drives every projection branch: INV1 turn withdrawals, INV2
 *     pair withdrawals, zone fatal, split fatal on a merge, live checkpoint
 *     carrier exclusion, unrecoverable-media carve, protected-tool carve,
 *     aged/failed compress exchanges, nested blocks, consumed blocks and
 *     block-boundary ranges.
 *  2. TRANSPARENCY — calling `projectUnit` WITH the shared context produces
 *     exactly what calling it without one produces, and screening with the
 *     context keeps exactly the same units. Together with (1) that is
 *     old == no-context == context.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createContentStore,
  createCore,
  createInitialState,
  defaultConfig,
  defaultCountTokens,
  makeIO,
  type CompressionBlock,
  type CompressionState,
  type CoreMessage,
} from "../src/index.js";
import {
  buildCompressibleRanges,
  computeProtectedRefs,
  mergeRangesToThreshold,
  screenRecommendedUnits,
} from "../src/recommend.js";
import { collectCoverage, projectUnit } from "../src/unit-projection.js";
import { computeIntegrityWithdrawals } from "../src/turn-integrity.js";

// ── optional (post-fix) API, loaded dynamically so this file also runs on the
//    pre-fix build to regenerate/verify the snapshot ─────────────────────────
type NewApi = {
  createProjectionContext?: (
    messages: CoreMessage[],
    state: CompressionState,
    config: Config,
  ) => unknown;
  buildIntegrityIndex?: (messages: CoreMessage[]) => unknown;
};
type Config = ReturnType<typeof defaultConfig>;

async function newApi(): Promise<NewApi> {
  const projection = (await import("../src/unit-projection.js")) as Record<
    string,
    unknown
  >;
  const integrity = (await import("../src/turn-integrity.js")) as Record<
    string,
    unknown
  >;
  return {
    createProjectionContext:
      projection.createProjectionContext as NewApi["createProjectionContext"],
    buildIntegrityIndex:
      integrity.buildIntegrityIndex as NewApi["buildIntegrityIndex"],
  };
}

// ── message / block builders ────────────────────────────────────────────────
function user(id: string, text?: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: text ?? `u-${id}` };
}
function assistant(id: string, text?: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "text",
    text: text ?? `a-${id}`,
  };
}
function reasoning(id: string, text?: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "reasoning",
    text: text ?? `r-${id}`,
  };
}
function toolCall(
  id: string,
  toolCallId: string,
  toolName = "read",
): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId,
    text: `{"call":"${toolCallId}"}`,
  };
}
function toolResult(
  id: string,
  toolCallId: string,
  toolName = "read",
  extra: Partial<CoreMessage> = {},
): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolName,
    toolCallId,
    text: `result-${toolCallId}`,
    ...extra,
  } as CoreMessage;
}
function block(
  id: number,
  effectiveMessageIds: string[],
  overrides: Partial<CompressionBlock> = {},
): CompressionBlock {
  return {
    blockId: `b${id}`,
    runId: `r${id}`,
    tier: 1,
    summary: `Summary ${id}`,
    directMessageIds: effectiveMessageIds,
    effectiveMessageIds,
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: 0,
    survivedCount: 1,
    generation: "old",
    active: true,
    ...overrides,
  };
}

// ── fixture A: bench-shaped log (the production regression shape) ───────────
const BENCH_PARA =
  "The build pipeline finished with 3 warnings and no errors; the rollout was staged and the next step is to verify the kernel fold path. ";

function benchShaped(n: number): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (let i = 0; i < n; i++) {
    const text = `${i}: ${BENCH_PARA.repeat(3)}`;
    const slot = i % 4;
    if (slot === 0) out.push(user(`m${i}`, text));
    else if (slot === 1) out.push(assistant(`m${i}`, text));
    else if (slot === 2) out.push(toolCall(`m${i}`, `call_${i}`, "bash"));
    else out.push(toolResult(`m${i}`, `call_${i - 1}`, "bash", { text }));
  }
  return out;
}

function runRecommend(
  messages: CoreMessage[],
  config: Config,
  state: CompressionState = createInitialState(),
): { messages: CoreMessage[]; state: CompressionState } {
  const nodes = createCore().defaultNodes();
  const ctx = {
    config,
    tokenCount: 1,
    countTokens: defaultCountTokens,
    contentStore: createContentStore(),
  };
  let io = makeIO(messages, state, {});
  for (const node of nodes) {
    if (node.enabled && !node.enabled(io, ctx)) continue;
    io = node.run(io, ctx);
    if (node.name === "recommend") break;
  }
  return { messages: io.messages, state: io.state };
}

// ── fixture B: hand-built state that drives every projection branch ─────────
function manualFixture(): {
  messages: CoreMessage[];
  state: CompressionState;
} {
  const messages: CoreMessage[] = [
    user("m0", "please build it"),
    reasoning("m1", "think: build steps"),
    assistant("m2", "building now"),
    // bash exchange: protectedTools ["bash"] carves BOTH halves out of the
    // fold, which is what turns a whole reasoning turn into an INV1 split.
    toolCall("m3", "c1", "bash"),
    toolResult("m4", "c1", "bash"),
    user("m5", "next"),
    reasoning("m6", "think: read file"),
    assistant("m7", "reading"),
    toolCall("m8", "c2", "read"),
    // unrecoverable media on the RESULT half only: the result is carved, the
    // call stays folded → INV2 pair withdrawal.
    toolResult("m9", "c2", "read", {
      text: "file body",
      rawOpenaiContent: {
        type: "image_url",
        image_url: { url: "https://example.com/x.png" },
      },
    } as Partial<CoreMessage>),
    user("m10", "compress the old part"),
    assistant("m11", "compressing"),
    // four compress exchanges: the newest three stay protected, older ones age
    // out of the ALWAYS_PROTECTED exemption; one is a failed exchange (#4289).
    toolCall("m12", "cc1", "compress"),
    toolResult("m13", "cc1", "compress", {
      text: "[Compressed m1-m4 -> b7, ~10 tokens saved]",
    }),
    user("m14", "and again"),
    toolCall("m15", "cc2", "compress"),
    toolResult("m16", "cc2", "compress", {
      text: "[Compressed m5-m6 -> b8, ~5 tokens saved]",
    }),
    user("m17", "hmm"),
    toolCall("m18", "cc3", "compress"),
    toolResult("m19", "cc3", "compress", {
      text: "[Compression FAILED: no ranges applied]",
    }),
    user("m20", "third"),
    toolCall("m21", "cc4", "compress"),
    toolResult("m22", "cc4", "compress", {
      text: "[Compressed m7-m8 -> b9, ~5 tokens saved]",
    }),
    user("m23", "fourth"),
    toolCall("m24", "cc5", "compress"),
    toolResult("m25", "cc5", "compress", {
      text: "[Compressed m9-m10 -> b10, ~5 tokens saved]",
    }),
    // host checkpoint carrier of a still-active block: a plain range spanning
    // it must skip it and keep the checkpoints visible.
    {
      ...assistant("m26", "[summary of b1]"),
      summaryOfBlockId: "b1",
    } as CoreMessage,
    user("m27", "tail question"),
    assistant("m28", "tail answer"),
    user("m29", "last question"),
  ];
  const state = createInitialState();
  messages.forEach((message, index) => {
    const ref = `m${String(index + 1).padStart(5, "0")}`;
    state.messageRefs.byRaw[message.id] = ref;
    state.messageRefs.byRef[ref] = message.id;
  });
  state.blocks = [
    block(1, ["m1", "m2"]),
    block(2, ["m6", "m7"]),
    block(3, ["m4", "m5"], { tier: 2 }),
  ];
  state.nextBlockId = 4;
  return { messages, state };
}

// ── canonicalisation + digest ───────────────────────────────────────────────
function canon(value: unknown): unknown {
  if (value instanceof Set) return [...value].sort();
  if (value instanceof Error)
    return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canon(record[key]);
    return out;
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Project every unit of a fixture and return the canonical observation set. */
function observe(
  name: string,
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  spans: Array<[string, string]>,
  context?: unknown,
): Record<string, unknown> {
  const protectedRefs = computeProtectedRefs(
    messages,
    state,
    config,
    defaultCountTokens,
  );
  const coverage = collectCoverage(state);
  const ranges = mergeRangesToThreshold(
    buildCompressibleRanges(
      messages,
      state,
      config,
      protectedRefs,
      defaultCountTokens,
    ).compressible,
    config.compress.minCompressRange,
  );
  const screened = screenRecommendedUnits(
    ranges,
    messages,
    state,
    config,
    protectedRefs,
  );
  const project = (startRef: string, endRef: string): unknown => {
    try {
      return canon(
        projectUnit({
          messages,
          state,
          config,
          startRef,
          endRef,
          preExistingCoverage: coverage,
          protectedMessageIds: protectedRefs,
          ...(context === undefined ? {} : { context: context as never }),
        }),
      );
    } catch (error) {
      return { thrown: canon(error) };
    }
  };
  return {
    name,
    screened,
    unitProjections: ranges.map((unit) => ({
      startRef: unit.startRef,
      endRef: unit.endRef,
      projection: project(unit.startRef, unit.endRef),
    })),
    spanProjections: spans.map(([startRef, endRef]) => ({
      startRef,
      endRef,
      projection: project(startRef, endRef),
    })),
  };
}

function allSpans(count: number): Array<[string, string]> {
  const spans: Array<[string, string]> = [];
  for (let a = 1; a <= count; a++) {
    for (let b = a; b <= count; b++) {
      spans.push([
        `m${String(a).padStart(5, "0")}`,
        `m${String(b).padStart(5, "0")}`,
      ]);
    }
  }
  return spans;
}

/** A compact, readable census of which branches the fixture actually reaches —
 *  pinned too, so a fixture that silently stops covering a branch is caught. */
function census(observations: Record<string, unknown>): Record<string, number> {
  const counters: Record<string, number> = {
    projections: 0,
    fatalZone: 0,
    fatalSplit: 0,
    withdrawn: 0,
    splitTurn: 0,
    splitPair: 0,
    skippedCarrier: 0,
    carvedIds: 0,
    consumedBlocks: 0,
    nestedBlocks: 0,
    blockBoundary: 0,
    thrown: 0,
  };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.projection !== undefined) {
      counters.projections += 1;
      walk(record.projection);
      return;
    }
    if (record.thrown !== undefined) {
      counters.thrown += 1;
      return;
    }
    if (record.fatal !== undefined) {
      const fatal = record.fatal as { kind?: string } | null;
      if (fatal?.kind === "zone") counters.fatalZone += 1;
      if (fatal?.kind === "split") counters.fatalSplit += 1;
    }
    if (Array.isArray(record.withdrawnIds) && record.withdrawnIds.length > 0) {
      counters.withdrawn += 1;
    }
    if ((record.splitTurnCount as number) > 0) counters.splitTurn += 1;
    if ((record.splitPairCount as number) > 0) counters.splitPair += 1;
    if (
      Array.isArray(record.skippedCarrierIds) &&
      record.skippedCarrierIds.length > 0
    ) {
      counters.skippedCarrier += 1;
    }
    const direct = (record.directMessageIds as unknown[] | undefined)?.length;
    const filtered = (record.filteredIds as unknown[] | undefined)?.length;
    if (typeof direct === "number" && typeof filtered === "number") {
      counters.carvedIds += direct - filtered;
    }
    if (Array.isArray(record.consumedBlockIds)) {
      counters.consumedBlocks += record.consumedBlockIds.length;
    }
    if (Array.isArray(record.nestedBlockIds)) {
      counters.nestedBlocks += record.nestedBlockIds.length;
    }
    if (record.isBlockBoundary === true) counters.blockBoundary += 1;
    for (const child of Object.values(record)) walk(child);
  };
  walk(observations);
  return counters;
}

const BENCH_CONFIG = defaultConfig(200_000);
const MANUAL_CONFIG: Config = {
  ...defaultConfig(200_000),
  preserveRecentMessages: 2,
  preserveRecentTokens: 0,
  protectedTools: ["bash"],
};
const MANUAL_BLOCK_SPANS: Array<[string, string]> = [
  ["b1", "b1"],
  ["b2", "b2"],
  ["b1", "b3"],
  ["b1", "b2"],
];

function buildObservations(context?: unknown): Record<string, unknown> {
  const bench = runRecommend(benchShaped(160), BENCH_CONFIG);
  const manual = manualFixture();
  return {
    bench: observe(
      "bench-shaped-160",
      bench.messages,
      bench.state,
      BENCH_CONFIG,
      [],
      context,
    ),
    manual: observe(
      "mixed-manual",
      manual.messages,
      manual.state,
      MANUAL_CONFIG,
      [...allSpans(manual.messages.length), ...MANUAL_BLOCK_SPANS],
      context,
    ),
  };
}

// Digest of the PRE-FIX build (HEAD 03c5e4bf) — regenerate only from a build
// whose recommend path is known-good.
const EXPECTED_SNAPSHOT_SHA256 =
  "452b0f942f3efc4c86d551aab7a1d81d38a6ac76e865bb37d01f98301d1dc4a4";

const EXPECTED_CENSUS = {
  projections: 472,
  fatalZone: 3,
  fatalSplit: 219,
  withdrawn: 109,
  splitTurn: 209,
  splitPair: 296,
  skippedCarrier: 108,
  carvedIds: 1238,
  consumedBlocks: 274,
  nestedBlocks: 415,
  blockBoundary: 4,
  thrown: 0,
};

describe("P2 recommend linearization: equivalence", () => {
  it("reproduces the pre-fix snapshot of recommendations + every projection", () => {
    const observations = buildObservations();
    assert.deepEqual(
      census(observations),
      EXPECTED_CENSUS,
      "fixture no longer reaches the branches it is meant to pin",
    );
    assert.equal(sha256(observations), EXPECTED_SNAPSHOT_SHA256);
  });

  it("shares one per-turn context without changing any projection", async () => {
    const api = await newApi();
    if (!api.createProjectionContext) return; // pre-fix build: nothing to compare
    const manual = manualFixture();
    const bench = runRecommend(benchShaped(80), BENCH_CONFIG);
    const withContext = (
      name: string,
      messages: CoreMessage[],
      state: CompressionState,
      config: Config,
      spans: Array<[string, string]>,
    ) =>
      observe(
        name,
        messages,
        state,
        config,
        spans,
        api.createProjectionContext!(messages, state, config),
      );
    // One shared context per fixture — the exact shape screenRecommendedUnits
    // uses — must reproduce the per-call rebuild, projection for projection.
    assert.deepEqual(
      withContext(
        "bench-shaped-80",
        bench.messages,
        bench.state,
        BENCH_CONFIG,
        [],
      ),
      observe("bench-shaped-80", bench.messages, bench.state, BENCH_CONFIG, []),
    );
    assert.deepEqual(
      withContext(
        "mixed-manual",
        manual.messages,
        manual.state,
        MANUAL_CONFIG,
        [...allSpans(manual.messages.length), ...MANUAL_BLOCK_SPANS],
      ),
      observe("mixed-manual", manual.messages, manual.state, MANUAL_CONFIG, [
        ...allSpans(manual.messages.length),
        ...MANUAL_BLOCK_SPANS,
      ]),
    );
  });
});

// ── turn-integrity: full scan vs pre-indexed candidate walk ─────────────────
type Withdrawals = {
  withdrawn: Set<string>;
  splitTurnCount: number;
  splitPairCount: number;
};

function expectSameWithdrawals(
  messages: CoreMessage[],
  folded: Set<string>,
  indexed: (messages: CoreMessage[], folded: Set<string>) => Withdrawals,
  label: string,
): void {
  const full = computeIntegrityWithdrawals(messages, folded);
  const fast = indexed(messages, folded);
  assert.deepEqual(
    [...fast.withdrawn].sort(),
    [...full.withdrawn].sort(),
    `${label}: withdrawn set`,
  );
  assert.equal(
    fast.splitTurnCount,
    full.splitTurnCount,
    `${label}: splitTurnCount`,
  );
  assert.equal(
    fast.splitPairCount,
    full.splitPairCount,
    `${label}: splitPairCount`,
  );
}

describe("P2 recommend linearization: indexed turn-integrity gate", () => {
  it("matches the full scan on the shapes the fixed point exists for", async () => {
    const api = await newApi();
    if (!api.buildIntegrityIndex) return; // pre-fix build: nothing to compare
    const build = api.buildIntegrityIndex as (m: CoreMessage[]) => unknown;
    const indexed = (
      messages: CoreMessage[],
      folded: Set<string>,
    ): Withdrawals =>
      computeIntegrityWithdrawals(
        messages,
        folded,
        build(messages) as never,
      ) as Withdrawals;

    // 1. MULTI-TURN: three reasoning turns; folding only the reasoning halves
    //    must withdraw every touched turn (INV1).
    const multi = [
      reasoning("m1"),
      assistant("m2"),
      toolCall("m3", "c1"),
      toolResult("m4", "c1"),
      user("m5"),
      reasoning("m6"),
      assistant("m7"),
      toolCall("m8", "c2"),
      toolResult("m9", "c2"),
      user("m10"),
      reasoning("m11"),
      assistant("m12"),
      toolCall("m13", "c3"),
      toolResult("m14", "c3"),
    ];
    expectSameWithdrawals(
      multi,
      new Set(["m1", "m2", "m6", "m7", "m11", "m12"]),
      indexed,
      "multi-turn",
    );

    // 2. SINGLE TURN, pair broken (INV2), then INV1 re-check on the leftovers.
    expectSameWithdrawals(
      multi,
      new Set(["m3", "m8", "m13"]),
      indexed,
      "single-turn-pairs",
    );

    // 3. DISJOINT: folded ids touch no turn and no pair at all.
    expectSameWithdrawals(multi, new Set(["m5", "m10"]), indexed, "disjoint");

    // 4. DUPLICATE toolCallIds (two calls, one result) + duplicate ids.
    const duplicates = [
      toolCall("m1", "c1"),
      toolCall("m2", "c1"),
      toolResult("m3", "c1"),
      assistant("m4"),
      toolCall("m5", "c1"),
      toolResult("m6", "c1"),
      reasoning("m7"),
      assistant("m8"),
      toolCall("m9", "c2"),
      toolResult("m10", "c2"),
    ];
    expectSameWithdrawals(
      duplicates,
      new Set(["m1", "m5", "m7", "m8"]),
      indexed,
      "duplicate-call-ids",
    );

    // 5. ORPHAN reasoning and results (no partner anywhere).
    const orphans = [
      reasoning("m1"),
      user("m2"),
      toolResult("m3", "nobody"),
      assistant("m4"),
      reasoning("m5"),
    ];
    expectSameWithdrawals(orphans, new Set(["m1", "m5"]), indexed, "orphans");
  });

  it("matches the full scan across randomised histories", async () => {
    const api = await newApi();
    if (!api.buildIntegrityIndex) return;
    const build = api.buildIntegrityIndex as (m: CoreMessage[]) => unknown;
    const indexed = (
      messages: CoreMessage[],
      folded: Set<string>,
    ): Withdrawals =>
      computeIntegrityWithdrawals(
        messages,
        folded,
        build(messages) as never,
      ) as Withdrawals;

    // Deterministic LCG so failures reproduce.
    let seed = 0x2f6e2b1;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };
    const kinds: CoreMessage["contentType"][] = [
      "reasoning",
      "text",
      "tool-call",
      "tool-result",
    ];
    for (let round = 0; round < 200; round++) {
      const length = 4 + next(24);
      const messages: CoreMessage[] = [];
      let callSeq = 0;
      for (let i = 0; i < length; i++) {
        const kind = kinds[next(kinds.length)]!;
        const id = `m${i}`;
        if (kind === "reasoning") messages.push(reasoning(id));
        else if (kind === "text")
          messages.push(next(2) === 0 ? user(id) : assistant(id));
        else if (kind === "tool-call") {
          const callId = next(3) === 0 ? `shared` : `c${callSeq++}`;
          messages.push(toolCall(id, callId));
        } else {
          const callId =
            next(3) === 0 ? `shared` : `c${next(Math.max(1, callSeq))}`;
          messages.push(toolResult(id, callId));
        }
      }
      const folded = new Set<string>();
      for (const message of messages) {
        if (next(2) === 0) folded.add(message.id);
        if (next(4) === 0) folded.add("ghost-id");
      }
      expectSameWithdrawals(messages, folded, indexed, `random-${round}`);
    }
  });
});

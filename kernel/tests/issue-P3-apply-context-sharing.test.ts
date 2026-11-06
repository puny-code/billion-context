/**
 * P3-A2 — one projection context per `applyCompression` batch.
 *
 * `applyCompression` projects every requested range through `projectUnit`.
 * Each projection used to rebuild the O(messages) derived structures (id index,
 * id→message map, protected-tool facts, turn groups, media verdicts) — a fixed
 * ~21ms + ~5.2ms/range at 8650 messages, which dominated a multi-range apply.
 * The batch now builds ONE `createProjectionContext` and shares it.
 *
 * Equivalence argument, in two halves:
 *
 *  1. SHARING IS TRANSPARENT — for the state sequence an apply batch walks
 *     through (a block appended, consumed blocks deactivated, blocks refolded
 *     in place), a shared context produces exactly the projection a freshly
 *     built context produces. Proven below by driving the same range sequence
 *     twice: once with one shared context, once with a brand-new context per
 *     range.
 *  2. INVALIDATION IS NARROW — the context holds no state-derived cache, so an
 *     in-place state mutation needs no rebinding; what DOES invalidate it is a
 *     different messages array, a different state OBJECT or a different config,
 *     and projectUnit checks all three at entry (last test).
 *
 * On top of that, the real entry point is compared against itself: a batch
 * apply must produce byte-identical blocks to the same ranges applied one call
 * at a time (each of those calls builds its own throwaway context).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCore,
  createInitialState,
  defaultConfig,
  defaultCountTokens,
  type CompressionBlock,
  type CompressionState,
  type Config,
  type CoreMessage,
} from "../src/index.js";
import {
  collectCoverage,
  createProjectionContext,
  projectUnit,
} from "../src/unit-projection.js";
import { computeProtectedRefs } from "../src/recommend.js";
import { allocateBlockId } from "../src/state.js";

// ── builders ───────────────────────────────────────────────────────────────
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
    summary: `Summary ${id} (a summary long enough for the length gate)`,
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

/**
 * Fixture:
 *   m0..m3   plain text turns                       → fresh folds
 *   b1       an ACTIVE block covering m4,m5         → a later range MERGES it
 *   m6,m7    user + read tool-call
 *   m8       the read RESULT carrying unrecoverable media (remote URL) — the
 *            fold carves it, which breaks the call/result pair (INV2)
 *   m9,m10   plain text turns
 *   m11..m12 the soft-protected recent zone         → protected-zone carve/fatal
 */
function fixture(): {
  messages: CoreMessage[];
  state: CompressionState;
  config: Config;
} {
  const messages: CoreMessage[] = [
    user("m0"),
    assistant("m1"),
    user("m2"),
    assistant("m3"),
    user("m4"),
    assistant("m5"),
    user("m6"),
    toolCall("m7", "c2", "read"),
    toolResult("m8", "c2", "read", {
      text: "file body",
      rawOpenaiContent: {
        type: "image_url",
        image_url: { url: "https://example.com/x.png" },
      },
    } as Partial<CoreMessage>),
    user("m9"),
    assistant("m10"),
    user("m11"),
    user("m12"),
  ];
  const state = createInitialState();
  messages.forEach((message, index) => {
    const ref = `m${String(index + 1).padStart(5, "0")}`;
    state.messageRefs.byRaw[message.id] = ref;
    state.messageRefs.byRef[ref] = message.id;
  });
  state.blocks = [block(1, ["m4", "m5"])];
  state.nextBlockId = 2;
  const defaults = defaultConfig(200_000);
  const config: Config = {
    ...defaults,
    preserveRecentMessages: 3,
    preserveRecentTokens: 0,
    // The min-chars gate is not what this test is about; the real entry point
    // must still fold the small fixture ranges.
    compress: { ...defaults.compress, minCompressRange: 0 },
  };
  return { messages, state, config };
}

function refOf(state: CompressionState, id: string): string {
  return state.messageRefs.byRaw[id]!;
}

// ── canonicalisation ───────────────────────────────────────────────────────
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

/** The part of apply output that must be byte-identical: run ids and
 *  wall-clock stamps are per-call identity, not semantics. */
function normalizeBlocks(state: CompressionState): unknown {
  return state.blocks.map((b) => {
    const { runId: _runId, createdAt: _createdAt, ...rest } = b;
    return canon(rest);
  });
}

function normalizeResult(result: {
  blocksCreated: number;
  tokensCompressed: number;
  errors: string[];
  warnings: string[];
}): unknown {
  return canon({
    blocksCreated: result.blocksCreated,
    tokensCompressed: result.tokensCompressed,
    errors: result.errors,
    warnings: result.warnings,
  });
}

// ── 1. shared context vs a brand-new context per range ─────────────────────
describe("P3-A2 apply: shared projection context", () => {
  it("matches a per-range context across a state-mutating range sequence", () => {
    const { messages, state, config } = fixture();
    const protectedMessageIds = computeProtectedRefs(
      messages,
      state,
      config,
      defaultCountTokens,
    );
    const preExistingCoverage = collectCoverage(state);
    const ranges: Array<[string, string, string]> = [
      // 1. fresh fold in the head → commits a block
      ["m0", "m2", "first fold"],
      // 2. MERGES the pre-existing block b1 (m4..m5): consumed block,
      //    merge-path turn integrity, b1 deactivated
      ["m3", "m6", "merge of b1"],
      // 3. overlaps the block created by range 1 — a block that did not exist
      //    when the shared context was built
      ["m0", "m1", "overlap with the block created above"],
      // 4. spans the media-carved result → the call/result pair breaks (INV2)
      ["m6", "m8", "media pair break"],
      // 5. brushes the protected recent zone
      ["m9", "m10", "protected zone brush"],
      // 6. wholly inside the protected zone → fatal zone
      ["m11", "m12", "protected zone only"],
    ];

    const shared = createProjectionContext(messages, state, config);
    const observed: Array<{ fatal: string | null; blocked: boolean }> = [];
    for (const [startId, endId, label] of ranges) {
      const startRef = refOf(state, startId);
      const endRef = refOf(state, endId);
      let sharedProjection: unknown;
      let sharedThrew: unknown;
      try {
        sharedProjection = canon(
          projectUnit({
            messages,
            state,
            config,
            startRef,
            endRef,
            preExistingCoverage,
            protectedMessageIds,
            context: shared,
          }),
        );
      } catch (error) {
        sharedThrew = canon(error);
      }
      // Control: a context built from scratch for this range (the pre-fix shape).
      let freshProjection: unknown;
      let freshThrew: unknown;
      try {
        freshProjection = canon(
          projectUnit({
            messages,
            state,
            config,
            startRef,
            endRef,
            preExistingCoverage,
            protectedMessageIds,
          }),
        );
      } catch (error) {
        freshThrew = canon(error);
      }
      assert.deepEqual(sharedThrew, freshThrew, `${label}: thrown`);
      assert.deepEqual(
        sharedProjection,
        freshProjection,
        `${label}: projection`,
      );

      const projection = freshProjection as {
        fatal: { kind: string } | null;
        filteredIds: string[];
        effectiveMessageIds: string[];
        consumedBlockIds: string[];
        outputTier: number;
      };
      observed.push({
        fatal: projection.fatal?.kind ?? null,
        blocked:
          projection.filteredIds.length === 0 &&
          projection.consumedBlockIds.length === 0,
      });
      // Commit exactly like applySingleRange does, so the NEXT range sees the
      // mutated state (new block, deactivated consumed blocks).
      if (projection.fatal !== null || projection.filteredIds.length === 0) {
        continue;
      }
      const blockId = allocateBlockId(state);
      state.blocks.push({
        blockId,
        runId: "r-shared",
        tier: projection.outputTier as CompressionBlock["tier"],
        summary: `summary for ${startRef}..${endRef} (long enough for the gate)`,
        directMessageIds: [...projection.filteredIds],
        effectiveMessageIds: [...projection.effectiveMessageIds],
        directBlockIds: [...projection.consumedBlockIds],
        compressedTokens: 10,
        createdAt: 0,
        survivedCount: 0,
        generation: "young",
        active: true,
        startRef,
        endRef,
      });
      for (const consumedId of projection.consumedBlockIds) {
        const consumed = state.blocks.find((b) => b.blockId === consumedId);
        if (consumed) consumed.active = false;
      }
    }

    // The sequence must actually have walked the branches it claims to cover,
    // or the equivalence above proves nothing.
    assert.ok(
      state.blocks.length >= 4,
      `folds should have committed blocks (got ${state.blocks.length})`,
    );
    assert.equal(
      state.blocks
        .filter((b) => !b.active)
        .map((b) => b.blockId)
        .join(","),
      // b1 is the pre-existing block; b2 was created by range 1 of THIS
      // sequence and consumed by range 3 — so the shared context had to see a
      // block that did not exist when it was built.
      "b1,b2",
      "the merges should have deactivated the consumed blocks",
    );
    assert.equal(
      observed.filter((step) => step.fatal === "zone").length,
      1,
      "the sequence should end on a protected-zone fatal",
    );
    assert.equal(
      observed.filter((step) => step.fatal === null).length,
      5,
      "five ranges should project without a fatal",
    );
  });

  it("keeps a batch apply byte-identical to per-range apply calls", () => {
    const core = createCore();
    for (const rangeCount of [1, 2, 3]) {
      const { messages, state, config } = fixture();
      // Disjoint, independently foldable ranges. Batching differences that are
      // NOT about context sharing (overlap skipping, the pre-loop coverage
      // snapshot) need no proof here — the kernel's apply tests cover them.
      const spans: Array<[string, string]> = [
        ["m0", "m2"],
        ["m6", "m7"],
        ["m9", "m10"],
      ].slice(0, rangeCount);
      const ranges = spans.map(([startId, endId], index) => ({
        startRef: refOf(state, startId),
        endRef: refOf(state, endId),
        summary: `batch summary ${index}: folded ${startId}..${endId} into one block, summary long enough for the length gate`,
      }));

      // A: ONE batch call — internally shares a single projection context.
      const batch = core.applyCompression({
        ranges,
        messages,
        state,
        config,
      });
      assert.deepEqual(batch.result.errors, [], "batch should fold cleanly");

      // B: the same ranges, one applyCompression call each — every call builds
      // its own throwaway context, i.e. the pre-fix per-range shape.
      const sequential = (() => {
        let running = state;
        let blocksCreated = 0;
        let tokensCompressed = 0;
        const errors: string[] = [];
        const warnings: string[] = [];
        for (const range of ranges) {
          const out = core.applyCompression({
            ranges: [range],
            messages,
            state: running,
            config,
          });
          running = out.state;
          blocksCreated += out.result.blocksCreated;
          tokensCompressed += out.result.tokensCompressed;
          errors.push(...out.result.errors);
          warnings.push(...out.result.warnings);
        }
        return {
          state: running,
          result: { blocksCreated, tokensCompressed, errors, warnings },
        };
      })();

      assert.equal(
        batch.result.blocksCreated,
        rangeCount,
        `${rangeCount} range(s): every range should fold`,
      );
      assert.deepEqual(
        normalizeResult(batch.result),
        normalizeResult(sequential.result),
        `${rangeCount} range(s): result`,
      );
      assert.deepEqual(
        normalizeBlocks(batch.state),
        normalizeBlocks(sequential.state),
        `${rangeCount} range(s): blocks`,
      );
      assert.deepEqual(
        canon(batch.state.messageRefs),
        canon(sequential.state.messageRefs),
        `${rangeCount} range(s): refs`,
      );
      assert.equal(
        batch.state.stats.compressionCount,
        sequential.state.stats.compressionCount,
        `${rangeCount} range(s): compressionCount`,
      );
    }
  });

  it("rebuilds instead of reusing a context bound to another array/state/config", () => {
    const { messages, state, config } = fixture();
    const preExistingCoverage = collectCoverage(state);
    const protectedMessageIds = computeProtectedRefs(
      messages,
      state,
      config,
      defaultCountTokens,
    );
    const startRef = refOf(state, "m0");
    const endRef = refOf(state, "m2");
    const expected = canon(
      projectUnit({
        messages,
        state,
        config,
        startRef,
        endRef,
        preExistingCoverage,
        protectedMessageIds,
      }),
    );

    // A different message ARRAY (same contents) must not be served from the
    // context built for the first array.
    const otherArrayContext = createProjectionContext(
      [...messages],
      state,
      config,
    );
    assert.deepEqual(
      canon(
        projectUnit({
          messages,
          state,
          config,
          startRef,
          endRef,
          preExistingCoverage,
          protectedMessageIds,
          context: otherArrayContext,
        }),
      ),
      expected,
      "different messages array",
    );

    // A different state OBJECT must not reuse the old state layer.
    const cloned = structuredClone(state) as CompressionState;
    const clonedContext = createProjectionContext(messages, cloned, config);
    assert.deepEqual(
      canon(
        projectUnit({
          messages,
          state,
          config,
          startRef,
          endRef,
          preExistingCoverage,
          protectedMessageIds,
          context: clonedContext,
        }),
      ),
      expected,
      "different state object",
    );

    // A different CONFIG object must not reuse memoized protection verdicts.
    const otherConfig: Config = { ...config, protectedTools: ["read"] };
    const otherConfigContext = createProjectionContext(
      messages,
      state,
      otherConfig,
    );
    assert.deepEqual(
      canon(
        projectUnit({
          messages,
          state,
          config,
          startRef,
          endRef,
          preExistingCoverage,
          protectedMessageIds,
          context: otherConfigContext,
        }),
      ),
      expected,
      "different config",
    );
  });
});

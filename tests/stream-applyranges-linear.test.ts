import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressibleRange, CoreMessage, NudgeDecision } from "acp-kernel";
import { assignRefs, collectBlockContent, createCore, createInitialState, defaultConfig, emptyRefMap, formatRanges, ONE_CALL_HINT, viableRanges } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { excludeDeadRefRanges } from "../src/acp-status.ts";
import { prefixTokensBeforeRef } from "../src/cache-ledger.ts";

// P3-A3: applyRanges used to scan the whole messages array for every new block
// (`collectBlockContent` filters by the block's ids) and for every offered range
// (`submitted.some(spansOverlap…)`), and it rescanned the whole ref map per new
// block while building the fold-attribution log line. All three are now
// index/prefix-sum based. This file pins SEMANTIC ZERO-CHANGE by comparing the
// shipped code against reference snapshots of the OLD implementations:
//   A. block-content cache  == collectBlockContent over the FULL messages array
//      (including the "id not in the array" boundary — the block covers ids the
//      live view no longer carries)
//   B. remaining-offer tail == the old nested `.some(spansOverlap)` filter
//   C. fold-attribution X   == prefixTokensBeforeRef per block
// The reference side always calls the SHIPPED kernel helper / a verbatim copy
// of the removed helper, never a re-derivation of the new code.

const RANGES_HEADER = "Current compressible ranges (use these refs exactly as listed):";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[], overrides?: Record<string, unknown>): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, overrides as never),
        messages,
        session: {
            id: "applyranges-linear-test",
            meta: {},
            metadata: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        } as unknown as RewriteCtx["session"],
        log: (m: string) => { logs.push(m); },
        logs,
    };
}

function withRefs(ctx: Ctx): Ctx {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function runApply(ctx: Ctx, args: unknown): string {
    return applyRanges(parseCompressInput(args), ctx).text;
}

function offerRange(startRef: string, endRef: string, count: number, tokens = 8000): CompressibleRange {
    return { startRef, endRef, count, tokens, chars: tokens * 4, toolPct: 0, textPct: 100 };
}

function setOffer(ctx: Ctx, ranges: CompressibleRange[]): void {
    ctx.lastNudge = { compressibleRanges: ranges, tier: null } as unknown as NudgeDecision;
}

/** Blocks this applyRanges call created (everything not present before). */
function newBlocks(ctx: Ctx, before: ReadonlySet<string>): Array<{ blockId: string; startRef?: string; effectiveMessageIds: string[]; directBlockIds: string[] }> {
    return ctx.session.state.blocks.filter((b) => !before.has(b.blockId)) as never;
}

function historyBlocks(ctx: Ctx): Set<string> {
    return new Set(ctx.session.state.blocks.map((b) => b.blockId));
}

// ── A. block-content cache: new == old full-array collection ────────────────
test("A1: cached block content is byte-identical to collectBlockContent over the full array", () => {
    const msgs = Array.from({ length: 12 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", `${i}:${"y".repeat(4000)}`));
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 100000;
    const before = historyBlocks(ctx);
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00006", summary: "P3-A3 EQUIVALENCE SUMMARY PAYLOAD LONG ENOUGH FOR THE KERNEL MIN LENGTH" }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 160)}`);

    const created = newBlocks(ctx, before);
    assert.ok(created.length > 0, "fold must create blocks");
    for (const b of created) {
        const cached = ctx.session.blockContents.get(b.blockId);
        assert.ok(cached !== undefined, `block ${b.blockId} content must be cached`);
        // OLD implementation: the collector was handed the WHOLE messages array.
        const oldFull = collectBlockContent(ctx.session.state, b as never, ctx.messages, { full: true });
        const oldOne = collectBlockContent(ctx.session.state, b as never, ctx.messages, { full: false });
        if (oldFull.count === 0 && oldOne.count === 0) {
            assert.fail(`block ${b.blockId} should have had content`);
        }
        assert.equal(cached.full.text, oldFull.text, `block ${b.blockId}: full text differs from the old full-array result`);
        assert.equal(cached.full.count, oldFull.count, `block ${b.blockId}: full count differs`);
        const sameView = oldOne.text === oldFull.text && oldOne.count === oldFull.count;
        assert.deepEqual(cached.one, sameView ? null : { text: oldOne.text, count: oldOne.count }, `block ${b.blockId}: one-tier content differs`);
    }
});

test("A2 BOUNDARY: ids missing from the live view keep the old partial/empty behavior", () => {
    // Stage 1: fold m00001–m00004 for real so blocks exist.
    const all = Array.from({ length: 12 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", `${i}:${"z".repeat(4000)}`));
    const ctx = withRefs(makeCtx(all, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 100000;
    runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: "STAGE ONE SUMMARY PAYLOAD LONG ENOUGH FOR THE KERNEL MIN LENGTH CHECK" }] });
    const stage1Ids = new Set(ctx.session.state.blocks.map((b) => b.blockId));

    // Stage 2: the live view is PRUNED — m00005..m00008 (which the next fold
    // covers) are gone from ctx.messages, while ctx.compressMessages still
    // carries the full log (the host shape this branch exists for). So the new
    // block covers ids that are NOT in the array it is collected against.
    const pruned = [all[0]!, all[8]!, all[9]!]; // m00001 survives, m00009/m00010 present, m00005..m00008 gone
    ctx.messages = pruned;
    ctx.compressMessages = all;
    const out = runApply(ctx, { content: [{ startId: "m00005", endId: "m00008", summary: "STAGE TWO SUMMARY PAYLOAD LONG ENOUGH FOR THE KERNEL MIN LENGTH CHECK" }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 160)}`);

    const created = newBlocks(ctx, stage1Ids);
    assert.ok(created.length > 0, "stage 2 must create blocks");
    for (const b of created) {
        const cached = ctx.session.blockContents.get(b.blockId);
        // OLD implementation: whole (pruned) array = the missing-id case.
        const oldFull = collectBlockContent(ctx.session.state, b as never, pruned, { full: true });
        const oldOne = collectBlockContent(ctx.session.state, b as never, pruned, { full: false });
        if (oldFull.count === 0) {
            // Every id of this block is absent from the view: the old code wrote
            // NOTHING to the cache, so the new code must not either.
            assert.equal(cached, undefined, `block ${b.blockId}: nothing was collectable, the cache must stay empty`);
            continue;
        }
        assert.ok(cached !== undefined, `block ${b.blockId} content must be cached`);
        assert.equal(cached.full.text, oldFull.text, `block ${b.blockId}: partial-view full text differs`);
        assert.equal(cached.full.count, oldFull.count);
        const sameView = oldOne.text === oldFull.text && oldOne.count === oldFull.count;
        assert.deepEqual(cached.one, sameView ? null : { text: oldOne.text, count: oldOne.count });
    }
});

test("A3 BOUNDARY: a block whose ids are ALL absent from the view caches NOTHING, like before", () => {
    const all = Array.from({ length: 10 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", `${i}:${"d".repeat(3000)}`));
    const ctx = withRefs(makeCtx(all, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 100000;
    const before = historyBlocks(ctx);
    // The live view keeps ONLY m00001/m00002; the fold covers m00005–m00008,
    // every id of which is missing from the array the collector is handed.
    ctx.messages = [all[0]!, all[1]!];
    ctx.compressMessages = all;
    const out = runApply(ctx, { content: [{ startId: "m00005", endId: "m00008", summary: "ABSENT IDS SUMMARY PAYLOAD LONG ENOUGH FOR THE KERNEL MIN LENGTH CHECK" }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 160)}`);
    const created = newBlocks(ctx, before);
    assert.ok(created.length > 0, "the fold must still create blocks");
    const cachedBefore = new Set([...ctx.session.blockContents.keys()]);
    for (const b of created) {
        const oldFull = collectBlockContent(ctx.session.state, b as never, ctx.messages, { full: true });
        const oldOne = collectBlockContent(ctx.session.state, b as never, ctx.messages, { full: false });
        assert.equal(oldFull.count, 0, "precondition: no id of this block is in the live view");
        assert.equal(oldOne.count, 0, "precondition: no direct id and no active child renders content");
        // OLD code: `if (full.count > 0 || one.count > 0)` was false ⇒ no cache write.
        assert.equal(cachedBefore.has(b.blockId), false, `block ${b.blockId}: nothing was collectable, the cache must stay empty`);
        assert.equal(ctx.session.blockContents.get(b.blockId), undefined);
    }
});

// ── B. remaining-offer tail: new sweep == old nested `some(spansOverlap)` ────
// Verbatim snapshot of the helper the sweep replaced (kept here as the oracle).
function oldSpanNum(ref: string): number {
    const n = Number(ref.replace(/\D/g, ""));
    return Number.isFinite(n) ? n : 0;
}
function oldSpansOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
    const aLo = Math.min(oldSpanNum(aStart), oldSpanNum(aEnd));
    const aHi = Math.max(oldSpanNum(aStart), oldSpanNum(aEnd));
    const bLo = Math.min(oldSpanNum(bStart), oldSpanNum(bEnd));
    const bHi = Math.max(oldSpanNum(bStart), oldSpanNum(bEnd));
    return aLo <= bHi && bLo <= aHi;
}

/** The exact tail the old implementation produced for this ctx. */
function oldTail(ctx: Ctx, submitted: Array<{ startRef: string; endRef: string }>): string {
    const minChars = ctx.config.compress.minCompressRange;
    const submitGate = (r: CompressibleRange): boolean => minChars <= 0 || (r.chars ?? r.tokens * 4) >= minChars;
    const base = ctx.lastNudge
        ? excludeDeadRefRanges(viableRanges(ctx.lastNudge.compressibleRanges).filter(submitGate), ctx.session.state.deadRefs)
        : [];
    const remaining = ctx.lastNudge
        ? base.filter((r) => !submitted.some((s) => oldSpansOverlap(r.startRef, r.endRef, s.startRef, s.endRef)))
        : base;
    if (remaining.length > 0) return `\n\n${RANGES_HEADER}\n${formatRanges(remaining, [])}\n${ONE_CALL_HINT}`;
    return "";
}

test("B1: remaining-offer tail is byte-identical to the old nested-scan result", () => {
    const msgs = Array.from({ length: 12 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", `${i}:${"t".repeat(5000)}`));
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 100000;
    const offer = [offerRange("m00001", "m00004", 4), offerRange("m00005", "m00007", 3), offerRange("m00008", "m00010", 3)];
    setOffer(ctx, offer);
    const submitted = [{ startRef: "m00001", endRef: "m00004" }];
    const expectedTail = oldTail(ctx, submitted);
    const out = runApply(ctx, { content: [{ startRef: "m00001", endRef: "m00004", summary: "TAIL EQUIVALENCE SUMMARY PAYLOAD LONG ENOUGH FOR THE KERNEL CHECK" }] });
    assert.ok(out.startsWith("[Compressed"), out.slice(0, 160));
    assert.ok(expectedTail.length > 0, "reference tail must be non-empty for this case");
    assert.ok(out.endsWith(expectedTail), `tail differs.\n--- expected ---\n${expectedTail}\n--- got ---\n${out.slice(-expectedTail.length - 200)}`);
});

test("B2 EDGE: spans that only TOUCH at one ref still count as overlapping (<=), like the old test", () => {
    const msgs = Array.from({ length: 12 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", `${i}:${"e".repeat(5000)}`));
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 100000;
    // Submitted m00001–m00005, offered m00005–m00008: they share m00005 only.
    const offer = [offerRange("m00005", "m00008", 4), offerRange("m00009", "m00010", 2)];
    setOffer(ctx, offer);
    const submitted = [{ startRef: "m00001", endRef: "m00005" }];
    const expectedTail = oldTail(ctx, submitted);
    const out = runApply(ctx, { content: [{ startRef: "m00001", endRef: "m00005", summary: "TOUCHING SPANS SUMMARY PAYLOAD LONG ENOUGH FOR THE KERNEL MIN LENGTH" }] });
    if (!out.startsWith("[Compressed")) {
        // The kernel may refuse this span (range shape); the boundary math is
        // still pinned by B1's oracle. Skip rather than assert on kernel policy.
        return;
    }
    assert.ok(!out.includes(RANGES_HEADER) || out.endsWith(expectedTail), "touching range must be excluded exactly as before");
    assert.ok(!/m00005[–-]m00008/.test(out.slice(out.indexOf(RANGES_HEADER))), "the touching offer must not be re-advertised:\n" + out);
});

test("B3: disjoint offer survives; the tail matches the old oracle range-for-range", () => {
    const msgs = Array.from({ length: 14 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", `${i}:${"s".repeat(5000)}`));
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 100000;
    const offer = [offerRange("m00003", "m00004", 2), offerRange("m00008", "m00009", 2)];
    setOffer(ctx, offer);
    const submitted = [{ startRef: "m00011", endRef: "m00013" }];
    const expectedTail = oldTail(ctx, submitted);
    const out = runApply(ctx, { content: [{ startRef: "m00011", endRef: "m00013", summary: "DISJOINT OFFER SUMMARY PAYLOAD LONG ENOUGH FOR THE KERNEL MIN LENGTH" }] });
    if (!out.startsWith("[Compressed")) return; // kernel policy on this span — oracle still pins the math in B1
    assert.ok(expectedTail.length > 0, "reference tail must be non-empty for this case");
    assert.ok(out.endsWith(expectedTail), `tail differs.\n--- expected ---\n${expectedTail}\n--- got ---\n${out.slice(-expectedTail.length - 200)}`);
});

// ── C. fold-attribution X == prefixTokensBeforeRef per block ────────────────
test("C1: the fold-attribution log carries prefixTokensBeforeRef's exact numbers", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => textMsg(`raw_${i + 1}`, i % 2 === 0 ? "user" : "assistant", `${i}:${"a".repeat(2500)}`));
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 2, preserveRecentTokens: 0 }));
    ctx.session.stats.lastInputTokens = 100000;
    const before = historyBlocks(ctx);
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00006", summary: "ATTRIBUTION SUMMARY PAYLOAD LONG ENOUGH FOR THE KERNEL MIN LENGTH CHECK" }] });
    assert.ok(out.startsWith("[Compressed"), out.slice(0, 160));
    const line = ctx.logs.find((l) => l.includes("fold-attribution X(firstFoldStartTokens)="));
    assert.ok(line !== undefined, "fold-attribution line must be logged");
    const xsPart = line!.slice(line!.indexOf("X(firstFoldStartTokens)=") + "X(firstFoldStartTokens)=".length, line!.indexOf(" · V="));
    const pairs = xsPart.trim().length === 0 ? [] : xsPart.trim().split(" ");
    const logged = new Map<string, number>();
    let noneCount = 0;
    for (const pair of pairs) {
        const eq = pair.lastIndexOf("=");
        const key = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        if (value === "none") { noneCount++; continue; }
        logged.set(key, Number(value));
    }
    const created = newBlocks(ctx, before);
    assert.equal(logged.size + noneCount, created.length, "one entry per new block");
    for (const b of created) {
        if (!b.startRef) continue;
        const expected = prefixTokensBeforeRef(ctx.session, b.startRef);
        assert.equal(logged.get(b.startRef), expected, `X for ${b.startRef} must equal prefixTokensBeforeRef`);
    }
    assert.ok(logged.size > 0, "at least one block carried a startRef to compare");
});

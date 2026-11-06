import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressionBlock } from "acp-kernel";
import { recordCacheFoldsFromBlocks, prefixTokensBeforeRef } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

// P3-A5: `recordCacheFoldsFromBlocks` used to call `prefixTokensBeforeRef` once
// per block, i.e. a full `messageRefs.byRef` rescan per block — O(blocks × refs),
// measured at 4.8s for the 2162-block batched preflight fold. It now builds one
// prefix-sum index per call. This file pins SEMANTIC ZERO-CHANGE by comparing
// the ledger records the shipped code writes against a verbatim snapshot of the
// OLD per-block scan (the oracle below), field for field, line for line.

// ── oracle: the removed implementation, kept verbatim ───────────────────────
function oldRefNum(ref: string): number {
    return Number(ref.replace(/\D/g, "")) || 0;
}
function oldPrefixTokensBeforeRef(session: Session, ref: string): number {
    const byRef = session.state?.messageRefs?.byRef;
    const snap = session.state?.tokenSnapshot;
    if (!byRef || !snap || oldRefNum(ref) === 0) return 0;
    let n = 0;
    for (const key of Object.keys(byRef)) {
        if (oldRefNum(key) < oldRefNum(ref)) n += snap[key] ?? 0;
    }
    return n;
}

// ── fixtures ────────────────────────────────────────────────────────────────
type FoldRec = Record<string, unknown>;
function makeSession(byRefKeys: string[], tokens: Record<string, number>, opts?: { withRefs?: boolean; withSnap?: boolean; lastBlockId?: number }): Session {
    const byRef: Record<string, unknown> = {};
    for (const k of byRefKeys) byRef[k] = { rawId: `raw_${k}` };
    const state: Record<string, unknown> = { blocks: [] };
    if (opts?.withRefs !== false) state.messageRefs = { byRef, byRaw: {} };
    if (opts?.withSnap !== false) state.tokenSnapshot = { ...tokens };
    return {
        id: "cache-ledger-prefix-test",
        meta: {},
        metadata: {},
        state,
        stats: {},
        createdAt: 0,
        lastSeen: 0,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
        ...(opts?.lastBlockId !== undefined ? {} : {}),
    } as unknown as Session;
}

function block(blockId: string, startRef: string | undefined, size = 100, createdAt = 1000): CompressionBlock {
    return { blockId, startRef, compressedTokens: size, summary: "x".repeat(40), createdAt, active: true, directMessageIds: [], effectiveMessageIds: [], directBlockIds: [] } as unknown as CompressionBlock;
}

function foldsOf(session: Session): FoldRec[] {
    return ((session.metadata as Record<string, unknown>)["cacheLedger"] as { folds: FoldRec[] }).folds;
}

function seedLedgerLastBlockId(session: Session, lastBlockId: number): void {
    // First call with an empty batch bootstraps nothing (early return), so seed
    // through a record then adjust the high-water mark the way a resumed
    // session's persisted ledger would carry it.
    (session.metadata as Record<string, unknown>)["cacheLedger"] = {
        v: 1, lastBlockId, consumedFoldSeq: 0, sampleSeq: 0, foldSeqCounter: 0,
        folds: [], lines: [], agg: {},
    };
}

// ── 1. every record line equals the old per-block scan ──────────────────────
test("ledger records are line-identical to the old per-block prefixTokensBeforeRef scan", () => {
    const keys: string[] = [];
    const tokens: Record<string, number> = {};
    for (let i = 1; i <= 200; i++) {
        const ref = `m${String(i).padStart(5, "0")}`;
        keys.push(ref);
        tokens[ref] = 100 + ((i * 37) % 211); // deterministic, non-uniform
    }
    const session = makeSession(keys, tokens);
    const blocks: CompressionBlock[] = [];
    // Mixed shapes on purpose: refs inside the map, a ref PAST the last mapped
    // ref, a ref with no digits ("xyz" -> 0), a block with no startRef at all,
    // and blockIds that arrive out of numeric order.
    const refs = ["m00001", "m00007", "m00050", "m00199", "m00200", "m99999", "xyz", "b12", undefined];
    let id = 1;
    for (const ref of refs) blocks.push(block(`b${String(id++).padStart(3, "0")}`, ref as string | undefined, 100 + id));
    // an out-of-order id (higher) followed by a lower one that must be skipped
    blocks.push(block("b900", "m00010", 777));
    blocks.push(block("b002", "m00011", 1)); // below the running high-water mark -> skipped by the ledger gate

    recordCacheFoldsFromBlocks(session, blocks, { V: 1000, Vp: 900 });

    const folds = foldsOf(session);
    // Which blocks the ledger gate accepts (id strictly above the running
    // high-water mark), in order — the oracle for count and order.
    const accepted: CompressionBlock[] = [];
    let highWater = 0;
    for (const b of blocks) {
        const num = oldRefNum(b.blockId);
        if (num <= highWater) continue;
        accepted.push(b);
        highWater = Math.max(highWater, num);
    }
    assert.equal(folds.length, accepted.length, `record count differs: ${folds.length} vs ${accepted.length}`);
    // pushFold freezes every OPEN fold's k to its requestsAfter when the NEXT
    // record is pushed, so all records except the last carry k=0 and the last
    // one still carries null.
    const expectedLines = accepted.map((b, idx) => {
        const x = b.startRef ? oldPrefixTokensBeforeRef(session, b.startRef) : undefined;
        const expected: FoldRec = {
            at: b.createdAt || 0, S: b.compressedTokens, sigma: Math.ceil(b.summary.length / 4),
            V: 1000, Vp: 900, bid: b.blockId, seq: idx + 1, T: 0, hPct: null, requestsAfter: 0,
            k: idx === accepted.length - 1 ? null : 0,
        };
        if (x !== undefined) expected.X = x;
        // key order is irrelevant to JSON equality, so compare canonicalized forms
        return JSON.stringify(expected, Object.keys(expected).sort());
    });
    for (let i = 0; i < folds.length; i++) {
        const got = JSON.stringify(folds[i], Object.keys(folds[i]!).sort());
        assert.equal(got, expectedLines[i], `ledger line ${i + 1} differs from the old implementation`);
    }
    // and the same through the exported single-ref API
    for (const ref of ["m00001", "m00050", "m00199", "m99999", "xyz", "b12"]) {
        assert.equal(prefixTokensBeforeRef(session, ref), oldPrefixTokensBeforeRef(session, ref), `prefixTokensBeforeRef(${ref})`);
    }
});

// ── 2. boundaries the old code had ─────────────────────────────────────────
test("missing ref map / token snapshot / refs with no digits keep the old zeros", () => {
    const noRefs = makeSession(["m00001"], { m00001: 500 }, { withRefs: false });
    recordCacheFoldsFromBlocks(noRefs, [block("b001", "m00001")], { V: 1, Vp: 1 });
    assert.equal((foldsOf(noRefs)[0] as { X?: number }).X, 0);

    const noSnap = makeSession(["m00001"], {}, { withSnap: false });
    recordCacheFoldsFromBlocks(noSnap, [block("b001", "m00001")], { V: 1, Vp: 1 });
    assert.equal((foldsOf(noSnap)[0] as { X?: number }).X, 0);

    const session = makeSession(["m00001", "m00002"], { m00001: 500, m00002: 700 });
    recordCacheFoldsFromBlocks(session, [block("b001", "xyz"), block("b002", undefined), block("b003", "m00002")], { V: 1, Vp: 1 });
    const folds = foldsOf(session);
    assert.equal((folds[0] as { X?: number }).X, 0, "a ref with no digits has prefix 0 (old refNum===0 branch)");
    assert.equal(folds[1]!.X, undefined, "a block without startRef carries X=undefined, exactly as the old code shaped it (JSON omits it)");
    assert.equal((folds[2] as { X?: number }).X, 500, "prefix stops before the query ref");
});

test("blocks at or below the ledger high-water mark are skipped and record nothing", () => {
    const session = makeSession(["m00001", "m00002"], { m00001: 500, m00002: 700 });
    seedLedgerLastBlockId(session, 50);
    recordCacheFoldsFromBlocks(session, [block("b010", "m00002"), block("b050", "m00002")], { V: 1, Vp: 1 });
    assert.equal(foldsOf(session).length, 0, "nothing above the high-water mark -> no fold events");
    recordCacheFoldsFromBlocks(session, [block("b051", "m00002")], { V: 1, Vp: 1 });
    assert.equal(foldsOf(session).length, 1);
    assert.equal((foldsOf(session)[0] as { X?: number }).X, 500);
});

test("empty batch is a no-op and does not touch the ledger", () => {
    const session = makeSession(["m00001"], { m00001: 500 });
    recordCacheFoldsFromBlocks(session, [], { V: 1, Vp: 1 });
    assert.equal((session.metadata as Record<string, unknown>)["cacheLedger"], undefined, "an empty batch must not bootstrap a ledger");
});

// ── 3. no cross-call caching ───────────────────────────────────────────────
test("the prefix index is per-call: a later state mutation changes the next call's X", () => {
    const session = makeSession(["m00001", "m00002", "m00003"], { m00001: 100, m00002: 200, m00003: 300 });
    recordCacheFoldsFromBlocks(session, [block("b001", "m00003")], { V: 1, Vp: 1 });
    assert.equal((foldsOf(session)[0] as { X?: number }).X, 300); // 100 + 200

    // Simulate the follow-on round: the snapshot is rewritten (first-render
    // counts are frozen per ref, but a restored/extended session can rewrite
    // them) and a new ref appears. A cached index would keep reporting 300.
    const snap = (session.state as unknown as { tokenSnapshot: Record<string, number> }).tokenSnapshot;
    snap["m00001"] = 1000;
    snap["m00004"] = 4000;
    (session.state as unknown as { messageRefs: { byRef: Record<string, unknown> } }).messageRefs.byRef["m00004"] = { rawId: "raw_m00004" };
    recordCacheFoldsFromBlocks(session, [block("b002", "m00004")], { V: 1, Vp: 1 });
    const folds = foldsOf(session);
    assert.equal((folds[1] as { X?: number }).X, 1500, "second call must see m00001=1000 + m00002=200 + m00003=300");
});

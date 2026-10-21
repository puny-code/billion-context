import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { incomingCoreMessages, maybeRecoverFoldsFromSibling } from "../src/fork-adoption.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { createSession, type Session } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";
import type { CompressionBlock } from "acp-kernel";

// #4046: the recovery's ELIGIBILITY/planning half is covered by
// fold-recovery.test.ts, but its SERVER HOOK — the piece handle.ts actually
// calls before prepare assigns refs — had no test at all: deleting the hook left
// every suite green. These cases drive the hook exactly as the request path does
// (a real on-disk store, a donor lane saved through persist, a wire payload) and
// assert the ledger moves.

/** A complete kernel block record (the unified importer binds every column —
 *  a partial fixture makes it fall back to the legacy view with an error log). */
function block(id: string, rawIds: string[], tokens: number): CompressionBlock {
    return {
        blockId: id,
        runId: "run-1",
        tier: 1,
        summary: "folded summary",
        directMessageIds: rawIds,
        effectiveMessageIds: rawIds,
        directBlockIds: [],
        compressedTokens: tokens,
        createdAt: 1,
        survivedCount: 0,
        generation: "young",
        active: true,
    };
}

/** A real on-disk store per case. closeQuietly() is mandatory before the
 *  teardown delete: Windows cannot unlink index.db while the sidecar handle is
 *  open, and that lock is OURS (not the transient AV/indexer race rmrf retries). */
/** An anthropic wire payload big enough to pass RECOVERY_MIN_INCOMING. */
function wire(n: number): { model: string; messages: Array<{ role: string; content: string }> } {
    return {
        model: "m",
        messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `cell-${i}-` + "z".repeat(80) })),
    };
}
function withDir(fn: (dir: string, store: SessionStore) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "bili-foldrec-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        fn(dir, store);
    } finally {
        _setStoreForTest(new SessionStore({ enabled: false }));
        store.closeQuietly();
        rmrf(dir);
    }
}

test("#4046 hook: adopts the sibling lane's ledger from disk before prepare runs", () => {
    withDir((dir, store) => {

            const protocol = "anthropic" as const;
            const parsed = wire(10);
            const incoming = incomingCoreMessages(protocol, parsed);
            assert.ok(incoming !== null && incoming.length === 10);
            const rawIds = incoming.map((m) => m.id);
            // The donor lane: the SAME conversation's persona lane, holding folds
            // over exactly the messages this replay carries.
            const donor = createSession("conv-w|sub:919f2f1b4676a9ad", { protocol, upstreamOrigin: "api.deepseek.com" });
            donor.state.blocks.push(block("blk1", [rawIds[0], rawIds[1]], 900));
            donor.blockContents.set("blk1", { text: "folded summary" } as never);
            donor.state.messageRefs.byRaw[rawIds[0]] = "m00001";
            donor.state.messageRefs.byRef.m00001 = rawIds[0];
            donor.stats.requests = 5;
            assert.ok(store.flushSync(donor), "the donor lane must be really on disk for discovery to find it");

            // The husk lane: served requests before, lost its ledger.
            const husk = createSession("conv-w", { protocol, upstreamOrigin: "api.deepseek.com" });
            husk.stats.requests = 9;
            husk.state.messageRefs.byRaw[rawIds[0]] = "m00001";
            husk.state.messageRefs.byRef.m00001 = rawIds[0];
            const lines: string[] = [];
            maybeRecoverFoldsFromSibling({
                session: husk,
                protocol,
                parsed,
                upstreamOrigin: "api.deepseek.com",
                log: (level, msg) => lines.push(`${level} ${msg}`),
            });
            assert.equal(husk.state.blocks.length, 1, "the folded block must arrive before prepare assigns refs");
            assert.equal(husk.state.blocks[0].blockId, "blk1");
            assert.equal(husk.metadata.foldRecoveredFrom, donor.id);
            assert.equal(husk.metadata.foldRecoveredBlocks, 1);
            assert.ok(lines.some((l) => l.startsWith("info [fold-recovery]")), "an adoption is announced");

            // A second request on the same lane is a no-op: the lane is healthy now.
            const lines2: string[] = [];
            maybeRecoverFoldsFromSibling({
                session: husk,
                protocol,
                parsed,
                upstreamOrigin: "api.deepseek.com",
                log: (level, msg) => lines2.push(`${level} ${msg}`),
            });
            assert.equal(husk.state.blocks.length, 1, "no duplicate adoption");
            assert.deepEqual(lines2, [], "a healthy lane logs nothing");

    });
});

test("#4046 hook: a replays-too-small request leaves the lane alone (and retries later)", () => {
    withDir((dir, store) => {

            const protocol = "anthropic" as const;
            const parsed = { model: "m", messages: [{ role: "user", content: "solo" }] };
            const incoming = incomingCoreMessages(protocol, parsed);
            assert.ok(incoming !== null);
            const donor = createSession("conv-s|sub:919f2f1b4676a9ad", { protocol, upstreamOrigin: "api.deepseek.com" });
            donor.state.blocks.push(block("blk1", [incoming[0].id], 900));
            donor.blockContents.set("blk1", { text: "folded summary" } as never);
            donor.stats.requests = 5;
            assert.ok(store.flushSync(donor));

            const husk = createSession("conv-s", { protocol, upstreamOrigin: "api.deepseek.com" });
            husk.stats.requests = 4;
            const lines: string[] = [];
            maybeRecoverFoldsFromSibling({
                session: husk,
                protocol,
                parsed,
                upstreamOrigin: "api.deepseek.com",
                log: (level, msg) => lines.push(`${level} ${msg}`),
            });
            assert.equal(husk.state.blocks.length, 0);
            assert.equal(husk.metadata.foldRecoveryTries, undefined, "a request below RECOVERY_MIN_INCOMING must not even spend an attempt");
            assert.deepEqual(lines, []);

    });
});

test("#4046 hook: a lane that never served a request never scans sibling lanes", () => {
    withDir((dir, store) => {

            const protocol = "anthropic" as const;
            const parsed = wire(10);
            const incoming = incomingCoreMessages(protocol, parsed);
            assert.ok(incoming !== null);
            const donor = createSession("conv-f|sub:919f2f1b4676a9ad", { protocol, upstreamOrigin: "api.deepseek.com" });
            donor.state.blocks.push(block("blk1", incoming.map((m) => m.id), 900));
            donor.blockContents.set("blk1", { text: "folded summary" } as never);
            donor.stats.requests = 5;
            assert.ok(store.flushSync(donor));

            const fresh = createSession("conv-f", { protocol, upstreamOrigin: "api.deepseek.com" });
            assert.equal(fresh.stats.requests, 0);
            const lines: string[] = [];
            maybeRecoverFoldsFromSibling({ session: fresh, protocol, parsed, upstreamOrigin: "api.deepseek.com", log: (level, msg) => lines.push(`${level} ${msg}`) });
            assert.equal(fresh.state.blocks.length, 0, "a brand-new conversation must not inherit a stranger's folds");
            assert.deepEqual(lines, []);

    });
});

test("#4046 hook: an unsupported protocol is ignored", () => {
    const lines: string[] = [];
    const session = createSession("conv-u", { protocol: "google", upstreamOrigin: "generativelanguage.googleapis.com" });
    session.stats.requests = 7;
    session.state.blocks.push(block("own", ["raw"], 10));
    maybeRecoverFoldsFromSibling({
        session,
        protocol: "google" as never,
        parsed: { contents: [] },
        upstreamOrigin: "generativelanguage.googleapis.com",
        log: (level, msg) => lines.push(`${level} ${msg}`),
    });
    assert.equal(session.state.blocks.length, 1, "the lane's own block stays exactly as it was");
    assert.deepEqual(lines, []);
});

test("#4046 hook: a lane with an idle sibling but no covering replay keeps its own state", () => {
    withDir((dir, store) => {

            const protocol = "anthropic" as const;
            const parsed = wire(10);
            const incoming = incomingCoreMessages(protocol, parsed);
            assert.ok(incoming !== null);
            // Donor's block covers a message the replay does NOT carry: adopting it
            // would drop live messages. (Negative direction for the coverage gate.)
            const donor = createSession("conv-n|sub:919f2f1b4676a9ad", { protocol, upstreamOrigin: "api.deepseek.com" });
            donor.state.blocks.push(block("blk1", ["raw-absent", incoming[0].id], 900));
            donor.blockContents.set("blk1", { text: "folded summary" } as never);
            donor.stats.requests = 5;
            assert.ok(store.flushSync(donor));

            const husk = createSession("conv-n", { protocol, upstreamOrigin: "api.deepseek.com" });
            husk.stats.requests = 3;
            const lines: string[] = [];
            maybeRecoverFoldsFromSibling({ session: husk, protocol, parsed, upstreamOrigin: "api.deepseek.com", log: (level, msg) => lines.push(`${level} ${msg}`) });
            assert.equal(husk.state.blocks.length, 0);
            assert.equal(husk.metadata.foldRecoveryTries, 1, "the attempt is spent (bounded retries cover the full replay later)");
            assert.ok(lines.some((l) => l.includes("folding from scratch")), "a miss is visible in the log");

    });
});

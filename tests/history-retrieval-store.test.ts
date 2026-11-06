// acp_history storage half: proving searchMessageText actually reads the
// `messages` + `content` tables it claims to (a silent WHERE-column typo would
// return "no matches" forever and look exactly like "the history is empty").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialState } from "acp-kernel";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "legacy";
process.env.BILI_CONFIG_FILE = join(mkdtempSync(join(tmpdir(), "hs-cfg-")), "missing.json");

function wmsg(id: string, text: string, wireIndex: number) {
    return { id, role: "user", contentType: "text", text, wireIndex };
}

function histLike(id: string, requests: number, msgs: { id: string; text: string; wireIndex: number }[]): LegacySessionLike {
    return {
        id,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        meta: { label: id, protocol: "anthropic", upstreamOrigin: "https://api.anthropic.com" },
        stats: { requests },
        metadata: { pluginAgent: "proxy" },
        state: { ...createInitialState(), requests } as never,
        blockContents: new Map() as never,
        lastMessages: msgs as never,
        lastMessagesFolded: false,
    };
}

function seeded(): { store: UnifiedStore; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "hs-store-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    store.ingestSession(
        planIngest(
            histLike("hs", 1, [
                wmsg("a", "alpha deploy notes", 0),
                wmsg("b", "bravo unrelated chatter", 1),
                wmsg("c", "charlie DEPLOY again", 2),
                wmsg("d", "delta noise", 3),
            ]),
        ),
        undefined,
        { completeLog: true },
    );
    return { store, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* store may still hold the file on Windows */ } } };
}

test("searchMessageText finds stored bodies, newest first, case-insensitively", () => {
    const { store, cleanup } = seeded();
    try {
        const res = store.searchMessageText("hs", ["deploy"], { limit: 10, scanLimit: 100 });
        assert.equal(res.total, 4, "counts every live stored row");
        assert.equal(res.scanned, 4, "scanned the whole session under the budget");
        assert.equal(res.hits.length, 2, "both spellings matched");
        assert.ok(res.hits[0].seq > res.hits[1].seq, "newest first");
        assert.match(res.hits[0].content, /DEPLOY/);
        assert.match(res.hits[1].content, /deploy/);
        assert.equal(res.capped, false);
        assert.equal(res.scannedTo, 0, "cursor is the oldest seq examined (seqs start at 0)");
    } finally {
        cleanup();
    }
});

test("searchMessageText honors the hit limit and the scan budget separately", () => {
    const { store, cleanup } = seeded();
    try {
        const one = store.searchMessageText("hs", ["deploy"], { limit: 1, scanLimit: 100 });
        assert.equal(one.hits.length, 1);
        assert.equal(one.capped, false, "stopping at the HIT limit is not a truncated scan");

        const capped = store.searchMessageText("hs", ["nothing-matches"], { limit: 5, scanLimit: 2 });
        assert.equal(capped.hits.length, 0);
        assert.equal(capped.scanned, 2, "scan budget respected");
        assert.equal(capped.capped, true, "a partial scan must say so");
        assert.ok(typeof capped.scannedTo === "number", "cursor handed back for the rest");

        const rest = store.searchMessageText("hs", ["nothing-matches"], { limit: 5, scanLimit: 2, beforeSeq: capped.scannedTo as number });
        assert.equal(rest.scanned, 2, "the continuation resumes below the cursor, not from the top");
    } finally {
        cleanup();
    }
});

test("an unknown session is an empty result, never a throw", () => {
    const { store, cleanup } = seeded();
    try {
        const none = store.searchMessageText("no-such-session", ["x"], { limit: 5, scanLimit: 5 });
        assert.deepEqual(none, { hits: [], scanned: 0, total: 0, capped: false, scannedTo: null });
        const noNeedles = store.searchMessageText("hs", [], { limit: 5, scanLimit: 5 });
        assert.equal(noNeedles.hits.length, 0);
        assert.equal(noNeedles.total, 4, "still reports the session size");
    } finally {
        cleanup();
    }
});

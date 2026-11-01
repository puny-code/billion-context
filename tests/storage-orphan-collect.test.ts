import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-orphan-collect-")),
    "no-config.json",
);

interface CoreMsg { id: string; role: string; contentType: string; text: string }
const mkMsg = (id: string, text: string): CoreMsg => ({ id, role: "user", contentType: "text", text });
const mkSession = (id: string, msgs: CoreMsg[]): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen: 2_000,
    meta: { protocol: "openai" },
    stats: {},
    metadata: { label: `label-${id}` },
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

function rawCount(dbPath: string): number {
    const raw = UnifiedStore.open(dbPath);
    try {
        return (raw as unknown as { db: { prepare(s: string): { get(): { n: number } } } }).db
            .prepare("SELECT COUNT(*) AS n FROM content").get().n;
    } finally {
        raw.close();
    }
}

test("orphan collection removes refcount-0 rows nothing references", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-collect-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        store.ingestSession(planIngest(mkSession("sess-live", [mkMsg("m-live", "live body ".repeat(40))])));
        const before = rawCount(dbPath);
        const orphanBody = Buffer.from("orphan body ".repeat(40), "utf8");
        const orphanHash = "ff".repeat(32);
        (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
            .prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 0, 'sha256', ?)")
            .run(orphanHash, orphanBody.byteLength, orphanBody);
        const freed = store.collectOrphans();
        assert.equal(freed, 1, "exactly the one unreferenced orphan is collected");
        assert.equal(rawCount(dbPath), before, "live content rows untouched");
        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("zero-refcount row that is still referenced is NOT collected", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-referenced-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        store.ingestSession(planIngest(mkSession("sess-live", [mkMsg("m-live", "live body ".repeat(40))])));
        const db = (store as unknown as { db: { prepare(s: string): { get(): { content_hash: string }; run(...a: unknown[]): unknown } } }).db;
        const referenced = db.prepare("SELECT content_hash FROM messages LIMIT 1").get().content_hash;
        db.prepare("UPDATE content SET refcount = 0 WHERE hash = ?").run(referenced);
        const freed = store.collectOrphans();
        assert.equal(freed, 0, "a row a message still points at must never be collected");
        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("archived session content survives orphan collection (archive keeps its own copy)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-archive-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        store.ingestSession(planIngest(mkSession("sess-A", [mkMsg("m-a", "archived body ".repeat(40))])));
        store.archiveSession("sess-A", { archiveDir: path.join(dir, "archive") });
        const freed = store.collectOrphans();
        assert.ok(freed >= 0);
        const archiveLog = fs.readFileSync(path.join(dir, "archive", "archive.jsonl"), "utf8");
        assert.ok(archiveLog.includes("archived body"), "archive export still holds the bodies");
        assert.equal(store.getSessionRow("sess-A")?.status, "archived", "tombstone survives");
        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

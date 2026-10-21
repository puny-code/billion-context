import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { planIngest, planIngestDelta, loadLegacyView, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore, sha256Hex } from "../src/storage/store.ts";
import { splitMediaContent } from "../src/storage/media.ts";

/**
 * #3901 / #3762 / #4069 — media-level content addressing.
 *
 * The same image posted into two conversations (or twice into one) is stored
 * once: ingest splits EVERY copy of the payload out of the message JSON into
 * content-CAS media rows — both the top-level imageBase64 sidecar AND the raw
 * OpenAI wire data URL that carries the SAME bytes (#4069: the codec writes
 * the payload twice, so splitting only the sidecar halves at best); the
 * stored message keeps key positions and carries media references;
 * getMessages() hydrates the bytes back so every reader sees the ORIGINAL
 * verbatim JSON (byte-identical round-trip). Deleting the last referencing
 * session releases the media row.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-media-cas-")),
    "no-config.json",
);

// Above MIN_SPLIT_MEDIA_CHARS so these payloads actually split (#4069 floor).
const BIG_B64 = "a".repeat(70_000); // stand-in for base64 image bytes
const SMALL_B64 = "a".repeat(4096); // below the floor: stays inline

interface CoreMsg { id: string; role: string; contentType: string; text: string; imageBase64?: string; imageMediaType?: string }

const mkMsg = (id: string, text: string, image?: string): CoreMsg => ({
    id,
    role: "user",
    contentType: image !== undefined ? "image" : "text",
    text,
    ...(image !== undefined ? { imageBase64: image, imageMediaType: "image/png" } : {}),
});

const mkSession = (id: string, msgs: CoreMsg[]): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen: 2_000,
    meta: { protocol: "openai" },
    stats: {},
    metadata: {},
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

test("media CAS: same image in two sessions stored once; round-trip verbatim; release on delete", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const mA = mkMsg("m-a", "look at this in session A", BIG_B64);
        const mB = mkMsg("m-b", "same screenshot in session B", BIG_B64);
        const mC = mkMsg("m-c", "plain text message");
        store.ingestSession(planIngest(mkSession("sess-A", [mA, mC])));
        store.ingestSession(planIngest(mkSession("sess-B", [mB])));

        // (1) Media bytes exist exactly once, referenced by both messages.
        assert.equal(store.mediaRefCount(BIG_B64), 2, "one media row, two references");

        // (2) STORED (pre-hydration) message content does NOT inline the
        // base64 — query the table directly; getMessages always hydrates.
        const rawStore = store as unknown as { db: { prepare(q: string): { all(...a: unknown[]): { content_hash: string }[] } }; getContent?(h: string): string | null };
        const rawRows = (sid: string): { content_hash: string }[] =>
            rawStore.db.prepare("SELECT content_hash FROM messages WHERE session_id = ?").all(sid);
        for (const sid of ["sess-A", "sess-B"]) {
            for (const row of rawRows(sid)) {
                const body = (store as unknown as { db: { prepare(q: string): { get(...a: unknown[]): { bytes: Uint8Array } | undefined } } })
                    .db.prepare("SELECT bytes FROM content WHERE hash = ?").get(row.content_hash);
                assert.ok(body, `content row for ${sid}`);
                assert.ok(!Buffer.from(body.bytes).toString("utf8").includes(BIG_B64), `stored content must not inline media bytes (${sid})`);
            }
        }
        // (3) …and getMessages hydrates back to the ORIGINAL verbatim JSON.
        const rowsA = store.getMessages("sess-A");
        assert.equal(JSON.parse(rowsA[0].content).imageBase64, BIG_B64);
        assert.equal(rowsA[0].content, JSON.stringify(mA), "byte-identical round-trip");

        // (4) Deleting one session keeps the shared media row; deleting both releases it.
        store.deleteSession("sess-A");
        assert.equal(store.mediaRefCount(BIG_B64), 1, "shared media survives one deletion");
        store.deleteSession("sess-B");
        assert.equal(store.mediaRefCount(BIG_B64), 0, "last reference gone → media row released");

        // (5) Legacy rows (inline bytes, pre-split) still read back verbatim.
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("media CAS: viewFor round-trip through loadLegacyView carries hydrated messages", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-2-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const m = mkMsg("m-img", "image turn", BIG_B64);
        store.ingestSession(planIngest(mkSession("sess-img", [m])));
        const view = loadLegacyView({
            session: store.getSessionRow("sess-img")!,
            messages: store.getMessages("sess-img"),
            blocks: store.getBlocks("sess-img"),
            deadRefs: store.getDeadRefs("sess-img"),
            refs: store.getRefs("sess-img"),
        }) as LegacySessionLike & { lastMessages?: CoreMsg[] };
        const tail = (view.lastMessages ?? []) as CoreMsg[];
        assert.equal(tail.length, 1);
        assert.equal(tail[0].imageBase64, BIG_B64, "view path hydrates media bytes");
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("media CAS: stale-row sweep releases media refs and mappings (full re-ingest drops the image)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-3-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const mImg = mkMsg("m-img", "image turn", BIG_B64);
        const mTxt = mkMsg("m-txt", "plain turn");
        store.ingestSession(planIngest(mkSession("sess-sweep", [mImg, mTxt])), undefined, { completeLog: true });
        assert.equal(store.mediaRefCount(BIG_B64), 1, "one media reference before re-ingest");

        // The session's raw tail no longer contains the image message: the
        // full path sweeps the stale row — its media mapping and CAS refcount
        // must go with it, or the bytes leak forever (#3762 review, #3901).
        store.ingestSession(planIngest(mkSession("sess-sweep", [mTxt])), undefined, { completeLog: true });

        assert.equal(store.mediaRefCount(BIG_B64), 0, "swept message released its media ref");
        const mappings = (store as unknown as { db: { prepare(q: string): { all(...a: unknown[]): { n: number }[] } } })
            .db.prepare("SELECT COUNT(*) AS n FROM message_media WHERE session_id = ?").all("sess-sweep");
        assert.equal(mappings[0].n, 0, "swept media mappings deleted");
        const rows = (store as unknown as { db: { prepare(q: string): { all(...a: unknown[]): { n: number }[] } } })
            .db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").all("sess-sweep");
        assert.equal(rows[0].n, 1, "only the surviving message row remains");
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

// ---- #4069: the OpenAI codec stores the SAME payload twice per image — the
// top-level sidecar AND the raw wire part (rawOpenaiContent / plural array).
// Splitting only the sidecar caps the win at ~2× on real data; both copies
// must ride the CAS for the full dedup.

const RAW_IMG = (b64: string): { type: string; image_url: { url: string } } => ({
    type: "image_url",
    image_url: { url: `data:image/png;base64,${b64}` },
});

interface DualMsg extends CoreMsg { rawOpenaiContent?: unknown; rawOpenaiContentParts?: unknown[] }

const mkDualMsg = (id: string, text: string, b64: string): DualMsg => ({
    id,
    role: "user",
    contentType: "image",
    text,
    rawOpenaiContent: RAW_IMG(b64),
    imageBase64: b64,
    imageMediaType: "image/png",
});

type DbShape = {
    prepare(q: string): {
        all(...a: unknown[]): { content_hash: string }[];
        get(...a: unknown[]): { bytes: Uint8Array } | undefined;
    };
};

const storedBodies = (store: UnifiedStore, sid: string): string[] => {
    const db = (store as unknown as { db: DbShape }).db;
    return db.prepare("SELECT content_hash FROM messages WHERE session_id = ?").all(sid)
        .map((r) => Buffer.from(db.prepare("SELECT bytes FROM content WHERE hash = ?").get(r.content_hash)!.bytes).toString("utf8"));
};

test("#4069: dual-field message splits BOTH copies into ONE CAS row; round-trip byte-identical", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-4-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const m = mkDualMsg("m-dual", "screenshot turn", BIG_B64);
        store.ingestSession(planIngest(mkSession("sess-dual", [m])));

        assert.equal(store.mediaRefCount(BIG_B64), 1, "sidecar and raw url share one CAS row");
        for (const body of storedBodies(store, "sess-dual")) {
            assert.ok(!body.includes(BIG_B64), "stored content must not inline the payload in either shape");
            assert.ok(body.includes("$media:"), "raw url carries the embedded ref");
        }
        const rows = store.getMessages("sess-dual");
        assert.equal(rows[0].content, JSON.stringify(m), "byte-identical round-trip");
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("#4069: same dual-field image across two sessions → one shared CAS row, refcount 2", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-5-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        store.ingestSession(planIngest(mkSession("sess-a", [mkDualMsg("m-a", "A", BIG_B64)])));
        store.ingestSession(planIngest(mkSession("sess-b", [mkDualMsg("m-b", "B", BIG_B64)])));
        assert.equal(store.mediaRefCount(BIG_B64), 2, "one shared CAS row, two references");
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("#4069: plural carrier (multi-image legacy shape) splits every part", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-6-"));
    const PA = "b".repeat(70_000);
    const PB = "c".repeat(70_000);
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const m: DualMsg = {
            id: "m-multi",
            role: "user",
            contentType: "image",
            text: "two pics",
            rawOpenaiContentParts: [RAW_IMG(PA), { type: "text", text: "between" }, RAW_IMG(PB)],
        };
        store.ingestSession(planIngest(mkSession("sess-multi", [m])));
        assert.equal(store.mediaRefCount(PA), 1);
        assert.equal(store.mediaRefCount(PB), 1);
        for (const body of storedBodies(store, "sess-multi")) {
            assert.ok(!body.includes(PA) && !body.includes(PB), "no part stays inline");
        }
        const rows = store.getMessages("sess-multi");
        assert.equal(rows[0].content, JSON.stringify(m), "byte-identical round-trip");
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("#4069: non-canonical data URLs stay inline (reconstruction not provably exact)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-7-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        // Extra params: the kernel's loose parseDataUrl rejects these entirely
        // (no sidecar produced) — nothing to dedup against, url stays verbatim.
        const mParams: DualMsg = {
            id: "m-params", role: "user", contentType: "image", text: "svg",
            rawOpenaiContent: { type: "image_url", image_url: { url: `data:image/svg+xml;charset=utf8;base64,${BIG_B64}` } },
        };
        // Missing ;base64 / uppercase scheme: the loose parser ACCEPTS them
        // (the sidecar exists) but the strict gate refuses — the sidecar
        // splits, the raw url stays inline untouched.
        const mLoose: DualMsg = {
            id: "m-loose", role: "user", contentType: "image", text: "loose",
            rawOpenaiContent: { type: "image_url", image_url: { url: `data:image/png,${BIG_B64}` } },
            imageBase64: BIG_B64, imageMediaType: "image/png",
        };
        const mUpper: DualMsg = {
            id: "m-upper", role: "user", contentType: "image", text: "upper",
            rawOpenaiContent: { type: "image_url", image_url: { url: `DATA:image/png;base64,${BIG_B64}` } },
            imageBase64: BIG_B64, imageMediaType: "image/png",
        };
        store.ingestSession(planIngest(mkSession("sess-noncanon", [mParams, mLoose, mUpper])));

        const rows = store.getMessages("sess-noncanon");
        assert.equal(rows[0].content, JSON.stringify(mParams), "extra-param url stays verbatim");
        assert.equal(rows[1].content, JSON.stringify(mLoose), "missing-;base64 url stays verbatim");
        assert.equal(rows[2].content, JSON.stringify(mUpper), "uppercase-scheme url stays verbatim");
        assert.equal(store.mediaRefCount(BIG_B64), 2, "sidecars of the loose messages still ride the CAS");
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("#4069: remote URL image source passes through untouched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-8-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const m: DualMsg = {
            id: "m-remote", role: "user", contentType: "image", text: "linked",
            rawOpenaiContent: { type: "image_url", image_url: { url: "https://example.com/pic.png" } },
        };
        store.ingestSession(planIngest(mkSession("sess-remote", [m])));
        assert.equal(storedBodies(store, "sess-remote")[0], JSON.stringify(m), "no refs → plain passthrough serialization");
        assert.equal(store.getMessages("sess-remote")[0].content, JSON.stringify(m));
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("#4069: sub-floor payloads stay fully inline (ref overhead would exceed the payload)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-9-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const m = mkDualMsg("m-small", "tiny icon", SMALL_B64);
        store.ingestSession(planIngest(mkSession("sess-small", [m])));
        assert.equal(store.mediaRefCount(SMALL_B64), 0, "nothing interned below the floor");
        assert.equal(storedBodies(store, "sess-small")[0], JSON.stringify(m), "stored verbatim, unsplit");
        assert.equal(store.getMessages("sess-small")[0].content, JSON.stringify(m));
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("#4069: stale-row sweep releases dual-slot media refs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-10-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const mImg = mkDualMsg("m-img", "image turn", BIG_B64);
        const mTxt = mkMsg("m-txt", "plain turn");
        store.ingestSession(planIngest(mkSession("sess-sweep2", [mImg, mTxt])), undefined, { completeLog: true });
        assert.equal(store.mediaRefCount(BIG_B64), 1, "first ingest keeps the ref");
        store.ingestSession(planIngest(mkSession("sess-sweep2", [mTxt])), undefined, { completeLog: true });
        assert.equal(store.mediaRefCount(BIG_B64), 0, "swept dual-slot message released its ref");
        const rows = (store as unknown as { db: { prepare(q: string): { all(...a: unknown[]): { n: number }[] } } })
            .db.prepare("SELECT COUNT(*) AS n FROM message_media WHERE session_id = ?").all("sess-sweep2");
        assert.equal(rows[0].n, 0, "no orphan mapping rows");
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

test("#4069: delta planner verifies an image boundary through the split hash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-media-cas-11-"));
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        const mImg = mkDualMsg("m-img", "boundary image", BIG_B64);
        const mTxt = mkMsg("m-txt", "after the image");
        store.ingestSession(planIngest(mkSession("sess-delta", [mImg])));

        const storedHash = (store as unknown as { db: DbShape }).db
            .prepare("SELECT content_hash FROM messages WHERE msg_id = ?").get("m-img")!.content_hash;
        const session2 = mkSession("sess-delta", [mImg, mTxt]);
        // Positive: the stored boundary hash covers the SPLIT serialization;
        // the probe re-splits identically and accepts the delta.
        const ok = planIngestDelta(session2, 1, [1], { msgId: "m-img", contentHash: storedHash }, true);
        assert.ok(ok, "image boundary verifies through the split hash");
        // Negative: the plain (unsplit) hash must NOT verify an image row.
        const bad = planIngestDelta(session2, 1, [1], { msgId: "m-img", contentHash: sha256Hex(JSON.stringify(mImg)) }, true);
        assert.equal(bad, null, "unsplit hash fails the boundary probe");
        store.close();
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows stray handles */ }
    }
});

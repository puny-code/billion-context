// #4041 CI flake root cause: when the unified sidecar fails to OPEN (disk
// pressure → ENOSPC allocating index.db/-wal/-shm, locked or corrupt db),
// maybeOpen degrades to null and SessionStore.shadow stays undefined — but
// the lazy disk-walk seed in loadEnvelope was gated on the live shadow
// INSTANCE, so the fallback that hydrates bare-id loads from pooled
// envelopes was disabled exactly when the index was unavailable, and
// loadSync returned null for records just flushed to disk (the #3769-family
// hydration tests going red under parallel CI load). This test pins the
// fallback deterministically without needing ENOSPC: poisoning <dir>/index.db
// as a directory makes UnifiedStore.open throw hermetically, the seam proves
// the degraded state, and the bare-id load must still hydrate off disk.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-4041-hermetic-")), "no-config.json");

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

const LABEL = "pool4041";

type M = Record<string, unknown>;

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

test("bare-id loadSync hydrates a pooled envelope when the sidecar failed to open (#4041)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-4041-store-"));
    // Poison: SQLite cannot open a database whose path is a directory —
    // every UnifiedStore.open over this dir throws, maybeOpen degrades to
    // null, and both stores below run with the documented no-sidecar
    // posture (legacy writes continue) instead of a live index.
    mkdirSync(path.join(dir, "index.db"));
    const upstream = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok 1" } }] }));
        res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
        res.write("data: [DONE]\n\n");
        res.end();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upPort = (upstream.address() as { port: number }).port;

    const stores: SessionStore[] = [];
    try {
        const store1 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        stores.push(store1);
        assert.equal(store1.__sidecarOpenForTests(), false, "poisoned index.db keeps the sidecar closed");
        _setStoreForTest(store1);
        _resetSessionsForTest();
        setRegistryForTest({});
        const proxy = await startServer({
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upPort}`]: { models: { "gpt-test": { context: 15_000 } } } },
            modelContextLimit: 15_000,
            kernelConfig: defaultConfig(15_000),
            compress: { injectTool: true, injectNudge: true },
            sessionHeader: "x-acp-session",
            passthrough: false,
            passthroughSource: null,
            autoUpdate: false,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: true,
            releaseNotesCheck: true,
            compat: { roles: {} },
            streamErrorShape: "protocol",
            mitm: { enabled: false, domains: [] },
        } as unknown as ProxyOptions);
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upPort}/v1/chat/completions`;

        const hist: M[] = [
            { role: "user", content: "sidecar-dead hydration one" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "sidecar-dead hydration two SIDE_DEAD_TAIL_MARKER" },
        ];
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": LABEL }, body: JSON.stringify({ model: "gpt-test", messages: hist, stream: true }) });
        assert.equal(r.status, 200);

        const s1 = listSessions().find((x) => x.meta.label === LABEL);
        assert.ok(s1, "session exists");
        assert.ok(store1.flushSync(s1!), "record commits with the sidecar dead");
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close").catch(() => undefined);

        // The pooled envelope must exist at a namespaced path (protocol dir
        // + host-prefixed hash file) — that shape is what the bare three
        // livePaths in loadEnvelope can never see.
        const pooled = readdirSync(path.join(dir, "openai"));
        assert.equal(pooled.filter((f) => f.endsWith(".json") && !f.endsWith(".content-store.json")).length, 1, "pooled envelope present");

        // Fresh store over the same poisoned dir: the sidecar fails again,
        // and the bare-id load MUST hydrate from the pooled envelope via the
        // walked disk fallback. Before the fix the walk seeded only when the
        // shadow instance existed, so this exact shape returned null.
        const store2 = new SessionStore({ enabled: true, dir, debounceMs: 0 });
        stores.push(store2);
        assert.equal(store2.__sidecarOpenForTests(), false, "second store is sidecar-dead too");
        _setStoreForTest(store2);
        _resetSessionsForTest();
        const hydrated = store2.loadSync(LABEL);
        assert.ok(hydrated, "bare-id loadSync hydrates the pooled envelope with the sidecar dead");
        assert.ok(hydrated!.state.messageRefs && Object.keys(hydrated!.state.messageRefs.byRaw).length > 0, "hydrated state carries refs");
    } finally {
        _setStoreForTest(new SessionStore({ enabled: false }));
        for (const s of stores) s.closeQuietly();
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close").catch(() => undefined);
        _resetSessionsForTest();
        setRegistryForTest({});
        await rmrf(dir);
    }
});

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
const instruction = "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE.";
const reply = 'data: {"choices":[{"delta":{"content":"native checkpoint"}}]}\n\ndata: [DONE]\n\n';

async function harness(run: (url: string, received: { body: Buffer; headers: http.IncomingHttpHeaders }[]) => Promise<void>): Promise<void> {
    const received: { body: Buffer; headers: http.IncomingHttpHeaders }[] = [];
    const upstream = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        received.push({ body: Buffer.concat(chunks), headers: req.headers });
        res.writeHead(200, { "content-type": "text/event-stream", "x-native-result": "kept" });
        res.end(reply);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const up = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: up, routes: {},
        modelContextLimit: 100_000, kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session", log: false, debug: false,
        passthrough: false, autoUpdate: false, autoRestartOnUpdate: false,
        advisoryCheck: false, releaseNotesCheck: false, compat: { roles: {} },
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    try {
        await run(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${up}`, received);
    } finally {
        proxy.close(); proxy.closeIdleConnections(); await once(proxy, "close");
        upstream.close(); upstream.closeIdleConnections(); await once(upstream, "close");
    }
}

for (const wire of ["openai", "anthropic", "responses"] as const) {
    test(`native ${wire} compaction relays exact request and response without creating kernel state`, async () => {
        await harness(async (url, received) => {
            const history = [{ role: "user", content: "history" }, { role: "assistant", content: "signed history" }, { role: "user", content: instruction }];
            const body = JSON.stringify(wire === "responses"
                ? { model: "gpt-test", input: history, stream: true }
                : { model: "gpt-test", messages: history, max_tokens: 4321, stream: true }, null, 2);
            const endpoint = wire === "openai" ? "/v1/chat/completions" : wire === "anthropic" ? "/v1/messages" : "/v1/responses";
            const response = await fetch(url + endpoint, { method: "POST", headers: {
                "content-type": "application/json", "x-bili-plugin": "dsh", "x-acp-session": "native-relay",
                "authorization": "Bearer keep-me", "x-ofm-signature": "body-signature-unchanged",
            }, body });
            assert.equal(response.status, 200, await response.clone().text());
            assert.equal(await response.text(), reply);
            assert.equal(response.headers.get("x-native-result"), "kept");
            assert.equal(received.length, 1);
            assert.equal(received[0].body.toString(), body);
            assert.equal(received[0].headers.authorization, "Bearer keep-me");
            assert.equal(received[0].headers["x-ofm-signature"], "body-signature-unchanged");
            assert.equal(received[0].headers["x-bili-hop"], undefined);
            assert.equal(received[0].headers["x-bili-plugin"], "dsh");
            assert.equal(listSessions().length, 0);
        });
    });
}

const compressedLanes: Record<string, string>[] = [{ "x-bili-passthrough": "1" }, { "x-bili-plugin": "dsh" }];
for (const headers of compressedLanes) {
test(`native compaction preserves gzip bytes and encoding with ${Object.keys(headers)[0]}`, async () => {
    await harness(async (url, received) => {
        const body = gzipSync(JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: instruction }] }));
        const response = await fetch(url + "/v1/chat/completions", { method: "POST", headers: {
            "content-type": "application/json", "content-encoding": "gzip", ...headers,
        }, body });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(await response.text(), reply);
        assert.equal(received.length, 1);
        assert.deepEqual(received[0].body, body);
        assert.equal(received[0].headers["content-encoding"], "gzip");
        assert.equal(listSessions().length, 0);
    });
});

}

test("sticky DSH compaction does not alter existing kernel state or accounting", async () => {
    await harness(async (url, received) => {
        const endpoint = url + "/v1/chat/completions";
        const warm = await fetch(endpoint, { method: "POST", headers: {
            "content-type": "application/json", "x-bili-plugin": "dsh", "x-acp-session": "sticky-native",
        }, body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "normal main turn" }], stream: true }) });
        assert.equal(warm.status, 200);
        await warm.text();
        const session = listSessions()[0];
        assert.equal(session.metadata.pluginAgent, "dsh");
        const state = JSON.stringify(session.state);
        const stats = JSON.stringify(session.stats);
        const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: instruction }], stream: true });
        const encoded = gzipSync(body);
        const response = await fetch(endpoint, { method: "POST", headers: {
            "content-type": "application/json", "content-encoding": "gzip", "x-acp-session": "sticky-native",
        }, body: encoded });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(await response.text(), reply);
        assert.deepEqual(received.at(-1)!.body, encoded);
        assert.equal(received.at(-1)!.headers["content-encoding"], "gzip");
        assert.equal(JSON.stringify(session.state), state);
        assert.equal(JSON.stringify(session.stats), stats);
        assert.equal(session.metadata.dshAuthoredCompactions, undefined);
        assert.equal(session.metadata.dshCompactionRefusals, undefined);
        assert.equal(session.metadata.dshCompactionRefusedBytes, undefined);
    });
});

test("non-DSH marker text does not bypass the normal compression pipeline", async () => {
    await harness(async (url, received) => {
        const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: instruction }], stream: true });
        const response = await fetch(url + "/v1/chat/completions", { method: "POST", headers: {
            "content-type": "application/json", "x-acp-session": "other-host",
        }, body });
        assert.equal(response.status, 200, await response.clone().text());
        await response.text();
        assert.equal(received.length, 1);
        assert.notEqual(received[0].body.toString(), body);
        assert.equal(listSessions().length, 1);
        assert.equal(listSessions()[0].stats.requests, 1);
    });
});

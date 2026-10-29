// Wiring: does the relay actually run the lossy pass before it signs and sends?
//
// The unit suite pins the algorithm; this pins the CHOKEPOINT. It matters because
// a pass that never runs is worthless — and a pass that runs when it should not
// (under budget, or with the knob off) would silently degrade every image turn.
// So the gate is an upstream that can only answer bodies under a given size:
//   * over the budget  -> the body must arrive smaller AND the turn must succeed;
//   * under the budget -> the body must arrive byte-identical (quality untouched);
//   * knob = 0         -> the oversized body must arrive unchanged (kill switch).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";

import { Jimp } from "jimp";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const MiB = 1024 * 1024;

/** An opaque, byte-heavy PNG (noise = big, like a real screenshot). */
async function shotPng(width: number, height: number, seed0: number): Promise<string> {
    const img = new Jimp({ width, height });
    const data = img.bitmap.data;
    let seed = seed0;
    for (let i = 0; i < width * height; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i * 4] = (seed >> 16) & 0xff;
        data[i * 4 + 1] = (seed >> 8) & 0xff;
        data[i * 4 + 2] = seed & 0xff;
        data[i * 4 + 3] = 255;
    }
    return `data:image/png;base64,${(await img.getBuffer("image/png")).toString("base64")}`;
}

/** Upstream that answers only bodies <= limit; above it, closes the socket. */
function makeGatedUpstream(limit: number) {
    const sizes: number[] = [];
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
        const declared = Number(req.headers["content-length"] ?? "0");
        sizes.push(declared);
        if (declared > limit) {
            req.socket.destroy();
            return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
        });
    });
    return { server, sizes, bodies };
}

async function startProxy(upstreamPort: number, window: number): Promise<{ proxy: http.Server; port: number }> {
    const store = new SessionStore({ enabled: false });
    _setStoreForTest(store);
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-relay": { context: window } } } },
        modelContextLimit: window,
        kernelConfig: defaultConfig(window),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxy, port: (proxy.address() as { port: number }).port };
}

async function post(port: number, upstreamPort: number, body: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": "s-lossy" },
        body,
    });
    return { status: res.status, text: await res.text() };
}

function chatBody(urls: string[]): string {
    const messages: unknown[] = [];
    urls.forEach((url, i) => {
        messages.push({ role: "user", content: [{ type: "text", text: `shot ${i}` }, { type: "image_url", image_url: { url } }] });
        messages.push({ role: "assistant", content: "ok" });
    });
    return JSON.stringify({ model: "gpt-relay", messages, max_tokens: 16 });
}

test("wiring: an over-budget screenshot body is re-encoded before it reaches the upstream", async () => {
    const shot = await shotPng(420, 320, 7);
    const body = chatBody([shot, shot, shot]);
    const bytes = Buffer.byteLength(body);
    assert.ok(bytes > 600 * 1024, `fixture must exceed the test budget (got ${bytes})`);
    // The upstream refuses anything over this: only a shrunken body can succeed.
    const gate = 600 * 1024;
    const { server: upstream, sizes } = makeGatedUpstream(gate);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    process.env.BILI_IMAGE_LOSSY_BYTES = "600000";
    const { proxy, port } = await startProxy(upstreamPort, 1_000_000);
    try {
        const out = await post(port, upstreamPort, body);
        assert.equal(out.status, 200, `turn must be delivered, got ${out.status}: ${out.text.slice(0, 300)}`);
        const seen = sizes[0] ?? 0;
        assert.ok(seen > 0, "the upstream saw exactly one attempt");
        assert.ok(seen < bytes, `upstream body must be smaller than the client's (${seen} < ${bytes})`);
        assert.ok(seen <= gate, `upstream body must fit the gate (${seen} <= ${gate})`);
        assert.match(out.text, /"ok"/);
    } finally {
        delete process.env.BILI_IMAGE_LOSSY_BYTES;
        proxy.close();
        upstream.close();
    }
});

test("wiring: under the budget the upstream body is byte-identical (negative: no gratuitous loss)", async () => {
    const shot = await shotPng(180, 140, 11);
    const body = chatBody([shot]);
    const { server: upstream, sizes, bodies } = makeGatedUpstream(64 * MiB);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    process.env.BILI_IMAGE_LOSSY_BYTES = String(5 * MiB);
    const { proxy, port } = await startProxy(upstreamPort, 1_000_000);
    try {
        const out = await post(port, upstreamPort, body);
        assert.equal(out.status, 200);
        assert.equal(sizes[0], Buffer.byteLength(body), "a body under the budget is sent untouched");
        const images = bodies[0].match(/data:image\/png;base64,/g) ?? [];
        assert.equal(images.length, 1, "the PNG is still a PNG");
    } finally {
        delete process.env.BILI_IMAGE_LOSSY_BYTES;
        proxy.close();
        upstream.close();
    }
});

test("wiring: the kill switch (BILI_IMAGE_LOSSY_BYTES=0) sends the oversized body unchanged", async () => {
    const shot = await shotPng(300, 240, 13);
    const body = chatBody([shot, shot]);
    const bytes = Buffer.byteLength(body);
    const { server: upstream, bodies } = makeGatedUpstream(64 * MiB);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    process.env.BILI_IMAGE_LOSSY_BYTES = "0";
    const { proxy, port } = await startProxy(upstreamPort, 1_000_000);
    try {
        const out = await post(port, upstreamPort, body);
        assert.equal(out.status, 200);
        assert.equal(Buffer.byteLength(bodies[0]), bytes, "the knob disables the whole rung");
        assert.equal((bodies[0].match(/data:image\/png;base64,/g) ?? []).length, 2);
    } finally {
        delete process.env.BILI_IMAGE_LOSSY_BYTES;
        proxy.close();
        upstream.close();
    }
});

// A pre-response socket reset on a multi-MiB body is observable: the upstream
// accepted the connection, took the request head, and closed in a few hundred
// milliseconds. What it is NOT is proof of WHY (the request may simply have been
// dropped) — so bili must REPORT the measurement and never act on it: no
// shedding, no extra send, no request mutation. Diagnosis only.
//
// Observed shape that motivated this: 6 screenshots at 1264x805 (<= the 1600px
// rescale gate, so the normal image pass correctly leaves them alone), 4.88MiB
// of PNG that only grow ~16% when re-encoded losslessly, a 7.0MiB body, and a
// reset 0.4s in. Every attempt of that size died; every request under ~6MiB
// succeeded. The user only ever saw `502 "acp-proxy failure"`.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { buildProxyFailureResponse, payloadResetNote, withUpstreamFailure } from "../src/upstream-fail.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const MiB = 1024 * 1024;

// --- the note is an observation, and only for the observed shape -------------

test("payload reset note: names the measured upload and the elapsed time", () => {
    const note = payloadResetNote("upstream-reset", 7 * MiB, 420);
    assert.ok(note !== null, "a reset 420ms into a 7MiB upload is reportable");
    assert.match(note!, /7\.0 MiB/);
    assert.match(note!, /420ms/);
    assert.match(note!, /payload size/i, "states the hypothesis, in hypothesis words");
    assert.doesNotMatch(note!, /^(confirmed|proven)/i, "never claims the cause was proven");
});

test("payload reset note: a proxy reset counts too", () => {
    assert.ok(payloadResetNote("proxy-reset", 6 * MiB, 300) !== null);
});

test("payload reset note: small bodies say nothing (negative)", () => {
    assert.equal(payloadResetNote("upstream-reset", 200 * 1024, 300), null);
    assert.equal(payloadResetNote("upstream-reset", 0, 300), null);
});

test("payload reset note: slow failures say nothing (negative)", () => {
    // A blackhole/stall also ends in a reset; it took seconds, which is not the
    // observed size-verdict shape. Reporting it as one would mislead.
    assert.equal(payloadResetNote("upstream-reset", 7 * MiB, 5000), null);
});

test("payload reset note: non-reset kinds say nothing (negative)", () => {
    const nonResets = ["dns", "connect-refused", "connect-timeout", "upstream-timeout", "tls", "unknown"] as const;
    for (const kind of nonResets) {
        assert.equal(payloadResetNote(kind, 7 * MiB, 300), null, `${kind} is not a reset`);
    }
});

// --- the egress body exposes the measurement, additively ---------------------

test("egress: measured upload size/elapsed ride the structured diag without touching `error`", () => {
    const err = withUpstreamFailure(new Error("upstream request failed"), {
        kind: "upstream-reset",
        code: "ECONNRESET",
        host: "api.example.com:443",
        hint: "upstream reset before the response",
        outboundBytes: 7_340_032,
        attemptElapsedMs: 420,
    });
    const { status, body } = buildProxyFailureResponse(String(err), err);
    assert.equal(status, 502, "still a transport failure, not a payload verdict");
    const parsed = JSON.parse(body) as { error?: string; upstreamFailure?: Record<string, unknown> };
    assert.equal(parsed.upstreamFailure?.outboundBytes, 7_340_032);
    assert.equal(parsed.upstreamFailure?.attemptElapsedMs, 420);
    // The client-facing `error` string keeps its #4254 shape byte-for-byte.
    assert.equal(parsed.error, "acp-proxy failure: upstream-reset ECONNRESET api.example.com:443");
});

test("egress: an unmeasured failure keeps the legacy body byte-identical (negative)", () => {
    const err = withUpstreamFailure(new Error("upstream request failed"), { kind: "dns" });
    const parsed = JSON.parse(buildProxyFailureResponse(String(err), err).body) as { upstreamFailure?: Record<string, unknown> };
    assert.equal("outboundBytes" in (parsed.upstreamFailure ?? {}), false);
    assert.equal("attemptElapsedMs" in (parsed.upstreamFailure ?? {}), false);
});

// --- wiring: the relay measures what it actually sent ------------------------

/** Upstream that closes the socket (pre-response) above LIMIT, answers below. */
function makeGatedUpstream(limit: number) {
    const attempts: number[] = [];
    const server = http.createServer((req, res) => {
        const declared = Number(req.headers["content-length"] ?? "0");
        attempts.push(declared);
        if (declared > limit) {
            req.socket.destroy();
            return;
        }
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
        });
    });
    return { server, attempts };
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

test("e2e: a reset on a multi-MiB body reports the measured size — and sends nothing extra", async () => {
    const LIMIT = 3 * MiB;
    // Window sits above the fixture's local token estimate so preflight does not
    // fold the body before the wire (that would hide the byte shape entirely).
    const WINDOW = 6_000_000;
    const upstream = makeGatedUpstream(LIMIT);
    upstream.server.listen(0, "127.0.0.1");
    await once(upstream.server, "listening");
    const upstreamPort = (upstream.server.address() as { port: number }).port;
    const { proxy, port } = await startProxy(upstreamPort, WINDOW);

    try {
        const payload = "L".repeat(6 * 1024 * 1024);
        const body = JSON.stringify({ model: "gpt-relay", messages: [{ role: "user", content: payload }] });
        const r = await fetch(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "payload-reset-sess" },
            body,
        });
        assert.equal(r.status, 502, "a transport failure still answers 502 (never a guessed 413)");
        const parsed = JSON.parse(await r.text()) as { detail?: string; upstreamFailure?: Record<string, unknown> };
        const bytes = parsed.upstreamFailure?.outboundBytes;
        assert.ok(typeof bytes === "number" && bytes >= 6 * MiB, `diag carries the measured upload, got ${String(bytes)}`);
        assert.ok(typeof parsed.upstreamFailure?.attemptElapsedMs === "number", "diag carries the time it took to die");
        assert.match(String(parsed.detail), /payload size/i, "the detail names the hypothesis for the user");
        // Diagnosis must not change behaviour: the request was sent (and retried)
        // by the pre-existing transport policy only — no extra shrunken send.
        assert.ok(upstream.attempts.every((n) => n >= 6 * MiB), `every attempt is the same body (${upstream.attempts.join(", ")})`);
    } finally {
        proxy.close();
        upstream.server.close();
    }
});

test("e2e: a small body that resets reports no payload-size note (negative)", async () => {
    const upstream = makeGatedUpstream(0); // resets everything
    upstream.server.listen(0, "127.0.0.1");
    await once(upstream.server, "listening");
    const upstreamPort = (upstream.server.address() as { port: number }).port;
    const { proxy, port } = await startProxy(upstreamPort, 1_000_000);

    try {
        const body = JSON.stringify({ model: "gpt-relay", messages: [{ role: "user", content: "hi" }] });
        const r = await fetch(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "small-reset-sess" },
            body,
        });
        assert.equal(r.status, 502);
        const parsed = JSON.parse(await r.text()) as { detail?: string; upstreamFailure?: Record<string, unknown> };
        assert.doesNotMatch(String(parsed.detail), /payload size/i, "a tiny body is never blamed on payload size");
        assert.equal(parsed.upstreamFailure?.outboundBytes, undefined, "no measurement is claimed when the shape does not match");
    } finally {
        proxy.close();
        upstream.server.close();
    }
});

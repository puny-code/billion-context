import test from "node:test";
import assert from "node:assert/strict";
import { installNativeFetchIntercept, _resetForTest, type NativeInterceptState } from "../src/agent/native-intercept.ts";

test("DSH native posture bypasses takeover and oversized refusals on raw and routed requests", async () => {
    const saved = globalThis.fetch;
    const seen: string[] = [];
    const sentHeaders: Headers[] = [];
    _resetForTest();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        sentHeaders.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
        seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return new Response("native", { status: 200 });
    }) as typeof fetch;
    try {
        let native = true;
        const state: NativeInterceptState = {
            origin: "http://127.0.0.1:9999", ready: Promise.resolve("http://127.0.0.1:9999"),
            nativeBypass: () => native,
            takeoverGate: () => { if (native) throw new Error("must not consult attribution in native posture"); return true; },
            declaredWindowForDirect: () => 1,
        };
        installNativeFetchIntercept(state);
        for (const url of ["https://provider.test/v1/chat/completions", "http://127.0.0.1:9999/bili/https://provider.test/v1/chat/completions"]) {
            const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer provider-secret", "x-bili-plugin": "1", "x-bili-session-id": "private-session", "x-bili-resign": "1" }, body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(10000) }] }) });
            assert.equal(response.status, 200);
        }
        assert.deepEqual(seen, ["https://provider.test/v1/chat/completions", "https://provider.test/v1/chat/completions"]);
        for (const headers of sentHeaders) {
            assert.equal(headers.get("authorization"), "Bearer provider-secret");
            assert.equal(headers.get("x-bili-plugin"), null);
            assert.equal(headers.get("x-bili-session-id"), null);
            assert.equal(headers.get("x-bili-resign"), null);
        }
        native = false;
        state.nativeCompactionPassthrough = true;
        const stream = new ReadableStream<Uint8Array>({ start() { /* deliberately never closes */ } });
        const upload = new Request("https://upload.test/artifacts", { method: "POST", body: stream, duplex: "half" } as RequestInit);
        const uploading = fetch(upload);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(seen.at(-1), "https://upload.test/artifacts", "non-model streams dispatch without buffering to EOF");
        await uploading;
        const compaction = JSON.stringify({ messages: [{ role: "user", content: "You are now acting as a compaction engine for this AI coding assistant. Summarize." }] });
        for (const url of ["https://provider.test/v1/chat/completions", "http://127.0.0.1:9999/bili/https://provider.test/v1/chat/completions"]) {
            await fetch(url, { method: "POST", body: compaction });
            assert.equal(seen.at(-1), "https://provider.test/v1/chat/completions", "native compaction goes direct even while bili is healthy");
        }
        await fetch("https://provider.test/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "You are now acting as a compaction engine for this AI coding assistant" }, { role: "assistant", content: "quoted history" }, { role: "user", content: "Continue coding" }] }) });
        assert.equal(seen.at(-1), "http://127.0.0.1:9999/bili/https://provider.test/v1/chat/completions", "a historical quote is not a native compaction call");
        await fetch("https://provider.test/v1/chat/completions", { method: "POST", body: "{}" });
        assert.equal(seen.at(-1), "http://127.0.0.1:9999/bili/https://provider.test/v1/chat/completions", "healthy posture still routes through bili");
    } finally { _resetForTest(); globalThis.fetch = saved; }
});

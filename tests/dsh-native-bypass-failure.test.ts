import test from "node:test";
import assert from "node:assert/strict";
import { installNativeFetchIntercept, _resetForTest } from "../src/agent/native-intercept.ts";

test("proxy failure hands back before replay or bili oversize refusal", async () => {
    const saved = globalThis.fetch;
    _resetForTest();
    const sent: string[] = [];
    let native = false;
    let respawns = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        sent.push(url);
        if (url.startsWith("http://127.0.0.1")) { native = true; throw new TypeError("proxy died"); }
        return new Response("native");
    }) as typeof fetch;
    try {
        installNativeFetchIntercept({
            origin: "http://127.0.0.1:9999", ready: Promise.resolve("http://127.0.0.1:9999"),
            nativeBypass: () => native,
            declaredWindowForDirect: () => 1,
            respawn: async () => { respawns++; return undefined; },
        });
        const result = await fetch("https://provider.test/v1/chat/completions", { method: "POST", body: "x".repeat(10000) });
        assert.equal(result.status, 200);
        assert.equal(respawns, 0, "native fallback must not wait for background recovery");
        assert.deepEqual(sent, ["http://127.0.0.1:9999/bili/https://provider.test/v1/chat/completions", "https://provider.test/v1/chat/completions"]);
    } finally { _resetForTest(); globalThis.fetch = saved; }
});

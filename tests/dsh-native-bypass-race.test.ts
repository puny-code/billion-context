import test from "node:test";
import assert from "node:assert/strict";
import { installNativeFetchIntercept, _resetForTest } from "../src/agent/native-intercept.ts";

test("DSH hands back after async attribution changes readiness instead of returning bili 422", async () => {
    const saved = globalThis.fetch;
    _resetForTest();
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
        seen.push(input instanceof Request ? input.url : String(input));
        return new Response("native");
    }) as typeof fetch;
    let native = false;
    try {
        installNativeFetchIntercept({
            origin: "http://127.0.0.1:9999",
            ready: Promise.resolve("http://127.0.0.1:9999"),
            nativeBypass: () => native,
            takeoverGate: async () => { native = true; return "refuse-oversized" as const; },
        });
        for (const url of ["https://provider.test/v1/chat/completions", "http://127.0.0.1:9999/bili/https://provider.test/v1/chat/completions"]) {
            native = false;
            const response = await fetch(url, { method: "POST", body: "{}" });
            assert.equal(response.status, 200);
        }
        assert.deepEqual(seen, ["https://provider.test/v1/chat/completions", "https://provider.test/v1/chat/completions"]);
    } finally { _resetForTest(); globalThis.fetch = saved; }
});

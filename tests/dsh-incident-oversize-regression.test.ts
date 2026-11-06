import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, _nativeStateForTest, _resetRegisterForTest, _settleNativeForTest } from "../src/agent/dsh-native.ts";
import { installNativeFetchIntercept, _resetForTest } from "../src/agent/native-intercept.ts";

const origin = "http://127.0.0.1:9999";
const provider = "https://provider.test/v1/chat/completions";

test("DSH hands the exact oversized history back on degradation and resumes takeover", async () => {
    const savedFetch = globalThis.fetch;
    const savedEnv = { ...process.env };
    const home = mkdtempSync(join(tmpdir(), "bili-dsh-regression-"));
    const calls: string[] = [];
    let healthy = false;
    let failProxy = false;
    const base = JSON.stringify({ model: "test", messages: [{ role: "user", content: "" }] });
    const body = JSON.stringify({ model: "test", messages: [{ role: "user", content: "x".repeat(12_179_827 - Buffer.byteLength(base)) }] });
    assert.equal(Buffer.byteLength(body), 12_179_827);
    _resetForTest();
    process.env.DSH_HOME = home;
    process.env.XDG_STATE_HOME = home;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.BILLION_CONTEXT_PROXY = origin;
    delete process.env.BILLION_CONTEXT_ATTACH;
    delete process.env.BILI_PROVIDER_REWRITES;
    delete process.env.BILI_NATIVE_DSH;
    delete process.env.BILLION_CONTEXT_PLUGIN;
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/__bili/status")) return Response.json({ storage: { effective: healthy ? "full" : "legacy", degraded: !healthy } });
        if (url.includes("/__bili/plugin/manifest")) return Response.json({ version: "test", tools: [] });
        if (url.includes("/__bili/")) return Response.json({});
        calls.push(url);
        if (url.startsWith(origin) && failProxy) { healthy = false; failProxy = false; throw new TypeError("proxy died"); }
        return new Response(url === provider ? "direct" : "proxy");
    }) as typeof fetch;
    try {
        _resetRegisterForTest(origin, true);
        apply({ commands: { register: () => {} }, tools: { register: () => {} }, agents: { currentInitiator: () => ({ session: { id: "test" } }) } } as Parameters<typeof apply>[0]);
        const state = _nativeStateForTest();
        _resetRegisterForTest(origin, true);
        state.origin = origin;
        state.ready = Promise.resolve(origin);
        state.declaredWindowForDirect = () => 1_050_000;
        installNativeFetchIntercept(state);
        const send = async (expected: string) => {
            const response = await fetch(provider, { method: "POST", body });
            assert.notEqual(response.status, 422);
            assert.equal(response.status, 200);
            assert.equal(await response.text(), expected);
        };
        await send("direct");
        healthy = true;
        assert.equal(await state.nativeBypass?.(true), false);
        await send("proxy");
        failProxy = true;
        await send("direct");
        healthy = true;
        assert.equal(await state.nativeBypass?.(true), false);
        await send("proxy");
        assert.deepEqual(calls, [provider, `${origin}/bili/${provider}`, `${origin}/bili/${provider}`, provider, `${origin}/bili/${provider}`]);
    } finally {
        _resetForTest();
        await _settleNativeForTest();
        _resetRegisterForTest(undefined);
        globalThis.fetch = savedFetch;
        process.env = savedEnv;
        rmSync(home, { recursive: true, force: true });
    }
});

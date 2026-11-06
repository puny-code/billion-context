import test from "node:test";
import assert from "node:assert/strict";
import { fetchDshTakeoverReady } from "../src/agent/shared.ts";

test("DSH requires affirmative full, non-degraded storage before takeover", async () => {
    const saved = globalThis.fetch;
    try {
        for (const [storage, expected] of [
            [{ effective: "full", degraded: false }, true],
            [{ effective: "legacy", degraded: true }, false],
            [{ effective: "full", degraded: true }, false],
            [undefined, false],
        ] as const) {
            globalThis.fetch = (async () => Response.json({ version: "test", storage })) as typeof fetch;
            assert.equal(await fetchDshTakeoverReady("http://127.0.0.1:9999"), expected);
        }
    } finally { globalThis.fetch = saved; }
});

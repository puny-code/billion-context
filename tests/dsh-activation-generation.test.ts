import test from "node:test";
import assert from "node:assert/strict";
import * as dsh from "../src/agent/dsh-native.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.ts";

test("a superseded activation cannot start a queued spawn under its successor's generation", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-generation-"));
    const keys = ["BILLION_CONTEXT_PROXY", "BILLION_CONTEXT_ATTACH", "BILI_PROVIDER_REWRITES", "BILI_MITM_HOSTS", "DSH_HOME", "XDG_STATE_HOME", "BILLION_CONTEXT_PLUGIN", "BILI_NATIVE_DSH"];
    const saved = keys.map((key) => process.env[key]);
    for (const key of keys) delete process.env[key];
    process.env.DSH_HOME = home;
    process.env.XDG_STATE_HOME = home;
    let calls = 0;
    const ctx = (): Parameters<typeof dsh.apply>[0] => ({
        tools: { register: () => {} }, commands: { register: () => {} },
        agents: { currentInitiator: () => undefined }, inject: () => {},
    });
    try {
        dsh._resetRegisterForTest(undefined);
        dsh._setSpawnForTest(async () => { calls++; return undefined; });
        const first = ctx();
        dsh.apply(first);
        dsh.maybeRetryForTest(first);
        const second = ctx();
        dsh.apply(second);
        const respawn = dsh._stateRespawnForTest();
        assert.ok(respawn);
        await respawn();
        await dsh._settleNativeForTest();
        assert.equal(calls, 1, "only the current activation starts work; the stale queued microtask is cancelled");
    } finally {
        dsh._resetRegisterForTest(undefined);
        dsh._setSpawnForTest(undefined);
        keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
        rmrf(home);
    }
});

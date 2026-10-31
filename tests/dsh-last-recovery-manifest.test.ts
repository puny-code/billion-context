import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import * as dsh from "../src/agent/dsh-native.ts";
import { rmrf } from "./tmp-rm.ts";

test("idle timer retries the manifest after the last recovery outlives a timer tick", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-last-recovery-"));
    const overrides: Record<string, string | undefined> = {
        DSH_HOME: home,
        XDG_STATE_HOME: home,
        BILLION_CONTEXT_ATTACH: undefined,
        BILLION_CONTEXT_PROXY: undefined,
        BILI_PROVIDER_REWRITES: undefined,
        BILI_MITM_HOSTS: undefined,
        NODE_EXTRA_CA_CERTS: undefined,
        BILI_DSH_RECOVERY_INTERVAL_MS: "20",
        BILI_DSH_RETRY_INTERVAL_MS: "20",
    };
    const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    const realNow = Date.now;
    let wallNow = realNow();
    let recoveryNow = 0;
    let spawns = 0;
    let manifests = 0;
    let finishSpawn: ((origin: string | undefined) => void) | undefined;
    const registered: string[] = [];
    const ctx: Parameters<typeof dsh.apply>[0] = {
        tools: { register: (tool) => { registered.push(tool.name); } },
        commands: { register: () => {} },
        agents: { currentInitiator: () => undefined },
        inject: () => {},
    };
    const waitFor = async (condition: () => boolean, description: string): Promise<void> => {
        const deadline = realNow() + 5_000;
        while (!condition()) {
            assert.ok(realNow() < deadline, `timeout waiting for ${description}`);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    };
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            manifests += 1;
            if (manifests === 1) {
                res.writeHead(503);
                res.end("manifest temporarily unavailable");
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                version: "0.1.119",
                tools: { anthropic: [{ name: "compress", input_schema: { type: "object", properties: {} } }] },
            }));
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
    try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        for (const [key, value] of Object.entries(overrides)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        Date.now = () => wallNow;
        dsh._resetRegisterForTest(undefined);
        dsh._setRecoveryNowForTest(() => recoveryNow);
        dsh._setSpawnForTest(() => {
            spawns += 1;
            if (spawns !== 4) return Promise.resolve(undefined);
            return new Promise((resolve) => { finishSpawn = resolve; });
        });

        dsh.apply(ctx);
        await waitFor(() => spawns === 1, "initial failed spawn");
        await dsh._settleNativeForTest();
        wallNow += 20;
        dsh.maybeRetryForTest(ctx);
        await waitFor(() => spawns === 2, "first failed recovery");
        await dsh._settleNativeForTest();
        recoveryNow += 30_000;
        wallNow += 20;
        dsh.maybeRetryForTest(ctx);
        await waitFor(() => spawns === 3, "second failed recovery");
        await dsh._settleNativeForTest();
        recoveryNow += 30_000;
        wallNow += 20;
        dsh.maybeRetryForTest(ctx);
        await waitFor(() => spawns === 4, "pending last recovery");
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(dsh._registerStateForTest().base, undefined);
        assert.equal(manifests, 0);
        assert.equal(spawns, 4, "timer ticks must not start another spawn while the last recovery is pending");

        assert.ok(finishSpawn);
        finishSpawn(origin);
        await waitFor(() => dsh._registerStateForTest().failStreak === 1, "first manifest returning 503");
        assert.equal(dsh._registerStateForTest().toolsReady, false);
        assert.equal(dsh._registerStateForTest().base, origin);
        assert.equal(manifests, 1);
        assert.deepEqual(registered, []);
        wallNow += 20;
        await waitFor(() => dsh._registerStateForTest().toolsReady, "idle timer retrying the manifest successfully");
        assert.equal(manifests, 2);
        assert.deepEqual(registered, ["compress"]);
        assert.equal(dsh._registerStateForTest().failStreak, 0);
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(spawns, 4, "manifest recovery must not replenish the exhausted spawn budget");
        assert.equal(manifests, 2, "healthy idle ticks must not register tools again");
    } finally {
        finishSpawn?.(undefined);
        await dsh._settleNativeForTest();
        dsh._resetRegisterForTest(undefined);
        dsh._setSpawnForTest(undefined);
        dsh._setRecoveryNowForTest();
        Date.now = realNow;
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        rmrf(home);
    }
});

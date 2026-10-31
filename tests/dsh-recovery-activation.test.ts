import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import * as dsh from "../src/agent/dsh-native.ts";
import { rmrf } from "./tmp-rm.ts";

type Context = Parameters<typeof dsh.apply>[0];

function mockCtx(): Context {
    return {
        tools: { register: () => {} },
        commands: { register: () => {} },
        agents: { currentInitiator: () => undefined },
        inject: () => {},
    };
}

async function fixture(run: (ctx: Context, advance: (ms: number) => void) => Promise<void>): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-activation-"));
    const overrides: Record<string, string | undefined> = {
        DSH_HOME: home,
        XDG_STATE_HOME: home,
        BILLION_CONTEXT_ATTACH: undefined,
        BILLION_CONTEXT_PROXY: undefined,
        BILI_PROVIDER_REWRITES: undefined,
        BILI_MITM_HOSTS: undefined,
        NODE_EXTRA_CA_CERTS: undefined,
        BILI_DSH_RECOVERY_INTERVAL_MS: "60000",
        BILI_DSH_RETRY_INTERVAL_MS: "20",
    };
    const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    let now = 0;
    dsh._resetRegisterForTest(undefined);
    dsh._setRecoveryNowForTest(() => now);
    try {
        await run(mockCtx(), (ms) => { now += ms; });
    } finally {
        await dsh._settleNativeForTest();
        dsh._resetRegisterForTest(undefined);
        dsh._setSpawnForTest(undefined);
        dsh._setRecoveryNowForTest();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmrf(home);
    }
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
        assert.ok(Date.now() < deadline, `timeout waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test("activation entry shares one initial spawn and three 30-second recoveries across ticks and direct respawn", async () => {
    await fixture(async (ctx, advance) => {
        let calls = 0;
        dsh._setSpawnForTest(async () => { calls += 1; return undefined; });
        dsh.apply(ctx);
        await waitFor(() => calls === 1, "initial spawn");
        await dsh._settleNativeForTest();
        const respawn = dsh._stateRespawnForTest();
        assert.ok(respawn);
        await respawn();
        assert.equal(calls, 2, "the first recovery is available immediately after initial boot");
        for (let expected = 3; expected <= 4; expected += 1) {
            advance(29_999);
            await respawn();
            assert.equal(calls, expected - 1, "cooldown rejection does not spawn or spend a recovery");
            advance(1);
            await respawn();
            assert.equal(calls, expected, "the exact 30-second boundary allows one recovery");
        }
        advance(300_000);
        for (let tick = 0; tick < 5; tick += 1) {
            dsh.maybeRetryForTest(ctx);
            await respawn();
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(calls, 4, "timer ticks and direct calls cannot bypass the shared exhausted budget");
        dsh.apply(mockCtx());
        await waitFor(() => calls === 5, "a new apply gets a free initial attempt");
        await dsh._settleNativeForTest();
        dsh._resetRegisterForTest(undefined);
        dsh.apply(mockCtx());
        await waitFor(() => calls === 6, "an explicit reset also gets a free initial attempt");
    });
});

test("joining an in-flight activation spawn does not consume a recovery", async () => {
    await fixture(async (ctx, advance) => {
        let calls = 0;
        let finish: ((origin: string | undefined) => void) | undefined;
        dsh._setSpawnForTest(() => {
            calls += 1;
            if (calls > 1) return Promise.resolve(undefined);
            return new Promise((resolve) => { finish = resolve; });
        });
        dsh.apply(ctx);
        await waitFor(() => calls === 1, "pending initial spawn");
        const respawn = dsh._stateRespawnForTest();
        assert.ok(respawn);
        const joins = [respawn(), respawn(), respawn()];
        assert.equal(calls, 1);
        assert.ok(finish);
        dsh._setSpawnForTest(async () => { calls += 1; return undefined; });
        finish(undefined);
        await Promise.all(joins);
        await dsh._settleNativeForTest();
        for (let expected = 2; expected <= 4; expected += 1) {
            await respawn();
            assert.equal(calls, expected, "all three recoveries remain after joining the initial flight");
            advance(30_000);
        }
        await respawn();
        assert.equal(calls, 4);
    });
});

test("successful spawns and manifest registration do not replenish the activation recovery budget", async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.url === "/__bili/plugin/manifest"
            ? { version: "0.1.119", tools: { anthropic: [{ name: "compress", input_schema: { type: "object", properties: {} } }] } }
            : { ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
        await fixture(async (ctx, advance) => {
            let calls = 0;
            dsh._setSpawnForTest(async () => { calls += 1; return origin; });
            dsh.apply(ctx);
            await waitFor(() => dsh._registerStateForTest().toolsReady, "successful manifest registration");
            assert.equal(calls, 1);
            const respawn = dsh._stateRespawnForTest();
            assert.ok(respawn);
            for (let expected = 2; expected <= 4; expected += 1) {
                advance(30_000);
                assert.equal(await respawn(), origin);
                assert.equal(calls, expected);
            }
            advance(300_000);
            assert.equal(await respawn(), undefined);
            assert.equal(calls, 4, "success does not reset consumed recovery permits");
        });
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

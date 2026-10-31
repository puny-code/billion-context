import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LauncherDeps } from "../src/launcher.ts";
import type { ProxyInstanceFile } from "../src/instance.ts";

process.env.NODE_TEST_CONTEXT = "1";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-pending-"));
const previous = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = root;
const { ensureProxyRunning } = await import("../src/launcher.ts");
const { stateDir } = await import("../src/paths.ts");
const { entryScriptFingerprint } = await import("../src/instance.ts");
const pendingPath = path.join(stateDir(), "proxy-dsh-pending");
const script = path.join(root, "fixture.js");
fs.writeFileSync(script, "// fixture\n");
beforeEach(() => { fs.rmSync(pendingPath, { force: true }); });
after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
    let ticks = 0;
    let spawns = 0;
    let kills = 0;
    let alive = true;
    let token: string | undefined;
    let registered: ProxyInstanceFile | undefined;
    const pid = process.pid;
    const opts = { host: "127.0.0.1", port: 18928, passthrough: false, debug: false, lane: "dsh", parentPid: 999999, recoverDegradedDsh: true };
    const deps: LauncherDeps = {
        scriptPath: script, nodeRuntime: process.execPath,
        now: () => ticks, sleep: async (ms) => { ticks += ms; },
        // The child has published a pointer, but no full registry handshake.
        // This keeps the real startup poll running to its simulated deadline.
        readInstanceFile: () => registered ?? (token ? { origin: "http://127.0.0.1:18928", instanceId: "starting", pid, startedAt: 1, host: "127.0.0.1", port: 18928, passthrough: false, mitmDomains: [], modelWindows: {}, codeFingerprint: entryScriptFingerprint(script), lane: "dsh", launchToken: token } : undefined),
        listRegistryInstances: () => registered ? [registered] : [],
        fetchHealthInfo: async () => registered ? ({ ok: true, instanceId: registered.instanceId, pid, storage: { effective: "full", degraded: false }, watchdog: { armed: true, watchers: [999999] } }) : undefined,
        fetchImpl: async () => ({ ok: Boolean(registered) }),
        fetchDetailImpl: async () => ({ ok: false, detail: "ECONNREFUSED" }),
        isRecoveryPidAlive: () => alive,
        isConnectable: async () => false,
        requestInstanceShutdown: async () => { kills++; return true; },
        registerWatcher: async () => "ok", attachDiag: () => {},
        resolveAttachUrl: () => undefined, resolveAttachExternal: () => false,
        resolveAttachPolicy: () => "own-lane", attachLanePriority: () => [],
        spawnImpl: (_cmd, _args, options) => {
            spawns++;
            token = options.env?.BILI_LAUNCH_TOKEN;
            alive = true;
            return { pid, unref() {}, kill() { kills++; return true; } };
        },
    };
    return {
        deps, opts, counts: () => ({ spawns, kills }), die: () => { alive = false; token = undefined; }, 
        register: (wrongToken = false) => {
            registered = { origin: "http://127.0.0.1:18928", instanceId: "registered", pid, startedAt: 1, host: "127.0.0.1", port: 18928, passthrough: false, mitmDomains: [], modelWindows: {}, codeFingerprint: entryScriptFingerprint(script), lane: "dsh", launchToken: wrongToken ? "foreign" : token };
        },
    };
}

test("two sequential unknown-live cold starts spawn only once and never kill", async () => {
    const f = fixture();
    await assert.rejects(ensureProxyRunning(f.opts, f.deps), /readiness unknown after 60000ms/);
    assert.ok(fs.existsSync(pendingPath), "timeout must preserve owned child identity");
    await assert.rejects(ensureProxyRunning(f.opts, f.deps), /pending.*alive/);
    assert.deepEqual(f.counts(), { spawns: 1, kills: 0 });
});

test("confirmed dead pending child permits next spawn", async () => {
    const f = fixture();
    await assert.rejects(ensureProxyRunning(f.opts, f.deps));
    f.die();
    await assert.rejects(ensureProxyRunning(f.opts, f.deps));
    assert.deepEqual(f.counts(), { spawns: 2, kills: 0 });
});

test("full registered same-token child resolves pending without replacement", async () => {
    const f = fixture();
    await assert.rejects(ensureProxyRunning(f.opts, f.deps));
    f.register();
    assert.equal((await ensureProxyRunning(f.opts, f.deps)).attached, true);
    assert.equal(fs.existsSync(pendingPath), false);
    assert.deepEqual(f.counts(), { spawns: 1, kills: 0 });
});

test("malformed pending record is preserved and blocks startup", async () => {
    const f = fixture();
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(pendingPath, '{"pid":0,"launchToken":"unknown"}');
    await assert.rejects(ensureProxyRunning(f.opts, f.deps), /pending child record is invalid/);
    assert.equal(fs.readFileSync(pendingPath, "utf8"), '{"pid":0,"launchToken":"unknown"}');
    assert.deepEqual(f.counts(), { spawns: 0, kills: 0 });
});

test("same PID but foreign launch token never clears pending or kills", async () => {
    const f = fixture();
    await assert.rejects(ensureProxyRunning(f.opts, f.deps));
    f.register(true);
    await assert.rejects(ensureProxyRunning(f.opts, f.deps), /pending.*alive/);
    assert.ok(fs.existsSync(pendingPath));
    assert.deepEqual(f.counts(), { spawns: 1, kills: 0 });
});

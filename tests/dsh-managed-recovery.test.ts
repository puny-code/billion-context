import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { LauncherDeps } from "../src/launcher.ts";
import type { ProxyInstanceFile } from "../src/instance.ts";

process.env.NODE_TEST_CONTEXT = "1";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-recovery-"));
const prevState = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = root;
after(() => {
    if (prevState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevState;
    fs.rmSync(root, { recursive: true, force: true });
});
const { ensureProxyRunning } = await import("../src/launcher.ts");
const { stateDir } = await import("../src/paths.ts");
beforeEach(() => { fs.rmSync(path.join(stateDir(), "proxy-dsh-pending"), { force: true }); });
const { entryScriptFingerprint } = await import("../src/instance.ts");
const script = path.join(root, "entry.js");
fs.writeFileSync(script, "// fixture\n");
const origin = "http://127.0.0.1:18919";

function fixture(change: { degraded?: boolean; silent?: boolean; mismatch?: boolean; lane?: string; token?: boolean; watchers?: readonly number[]; neverExit?: boolean; refuse?: boolean; registered?: boolean; missingStorage?: boolean; pidMismatch?: boolean; unarmed?: boolean; effective?: string; successorDegraded?: boolean } = {}) {
    const inst: ProxyInstanceFile = {
        origin, instanceId: "resident", pid: process.pid, startedAt: 1,
        host: "127.0.0.1", port: 18919, passthrough: false, mitmDomains: [], modelWindows: {},
        codeFingerprint: entryScriptFingerprint(script), lane: change.lane ?? "dsh",
        ...(change.token === false ? {} : { launchToken: "managed-token" }),
    };
    let ticks = 0;
    let shutdowns = 0;
    let spawns = 0;
    let exited = false;
    let mine: ProxyInstanceFile | undefined;
    const deps: LauncherDeps = {
        scriptPath: script, nodeRuntime: process.execPath,
        now: () => ticks, sleep: async (ms) => { ticks += ms; if (shutdowns && !change.neverExit) exited = true; },
        readInstanceFile: () => mine ?? inst,
        listRegistryInstances: () => mine ? [mine] : change.registered === false ? [] : [inst],
        fetchHealthInfo: async () => mine ? ({ ok: true, instanceId: "successor", pid: 42471, storage: { effective: "full", degraded: change.successorDegraded ?? false }, watchdog: { armed: true, watchers: [999999] } }) : change.silent ? undefined : ({ ok: true, guardedShutdown: true, instanceId: change.mismatch ? "foreign" : "resident", pid: change.pidMismatch ? 123 : inst.pid, ...(change.missingStorage ? {} : { storage: { effective: change.effective ?? "full", degraded: change.degraded ?? true } }), watchdog: { armed: !change.unarmed, watchers: [...(change.watchers ?? [999999])] } }),
        fetchImpl: async () => ({ ok: true }),
        isConnectable: async () => true,
        isRecoveryPidAlive: () => !exited,
        requestInstanceShutdown: async () => { shutdowns++; return !change.refuse; },
        registerWatcher: async () => "ok",
        attachDiag: () => {},
        resolveAttachUrl: () => undefined, resolveAttachExternal: () => false,
        resolveAttachPolicy: () => "own-lane", attachLanePriority: () => [],
        spawnImpl: (_cmd, _args, options) => {
            spawns++;
            assert.equal(exited, true, "must confirm OS exit before spawning a successor");
            mine = { ...inst, instanceId: "successor", pid: 42471, launchToken: options.env?.BILI_LAUNCH_TOKEN };
            return { pid: 42471, unref() {} };
        },
    };
    const opts = { host: "127.0.0.1", port: 18919, passthrough: false, debug: false, lane: "dsh", parentPid: 999999, recoverDegradedDsh: true };
    return { deps, opts, counts: () => ({ shutdowns, spawns }) };
}

test("managed degraded DSH resident is drained, OS-exit-confirmed and replaced once", async () => {
    const f = fixture();
    const handle = await ensureProxyRunning(f.opts, f.deps);
    assert.equal(handle.child?.pid, 42471);
    assert.deepEqual(f.counts(), { shutdowns: 1, spawns: 1 });
});

test("default probe reads storage from status rather than assuming health implies readiness", async () => {
    const f = fixture();
    let statusReads = 0;
    const server = http.createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/__bili/status") {
            statusReads++;
            res.end(JSON.stringify({ storage: { degraded: true } }));
        } else {
            res.end(JSON.stringify({ ok: true, instanceId: "resident", pid: process.pid, watchdog: { armed: true, watchers: [888888] } }));
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    const local = `http://127.0.0.1:${addr.port}`;
    const inst = f.deps.readInstanceFile!();
    assert.ok(inst && "pid" in inst);
    f.deps.readInstanceFile = () => ({ ...inst, origin: local, port: addr.port });
    f.deps.listRegistryInstances = () => [{ ...inst, origin: local, port: addr.port }];
    delete f.deps.fetchHealthInfo;
    try {
        await assert.rejects(ensureProxyRunning({ ...f.opts, port: addr.port }, f.deps));
        assert.ok(statusReads > 0);
        assert.deepEqual(f.counts(), { shutdowns: 0, spawns: 0 });
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("healthy DSH resident remains attached without restart", async () => {
    const f = fixture({ degraded: false });
    const handle = await ensureProxyRunning(f.opts, f.deps);
    assert.equal(handle.attached, true);
    assert.deepEqual(f.counts(), { shutdowns: 0, spawns: 0 });
});

for (const [name, change] of [
    ["hung health", { silent: true }],
    ["mismatched identity", { mismatch: true }],
    ["foreign lane", { lane: "pi" }],
    ["unmanaged resident", { token: false }],
    ["another owner", { watchers: [999999, 888888] }],
    ["unregistered resident", { registered: false }],
    ["missing storage status", { missingStorage: true }],
    ["mismatched OS pid", { pidMismatch: true }],
    ["unarmed watchdog", { unarmed: true }],
    ["non-full storage without degradation", { effective: "shadow", degraded: false }],
] as const) {
    test(`${name} is never retired or blindly attached`, async () => {
        const f = fixture(change);
        await assert.rejects(ensureProxyRunning(f.opts, f.deps));
        assert.deepEqual(f.counts(), { shutdowns: 0, spawns: 0 });
    });
}

for (const [name, change] of [["shutdown refused", { refuse: true }], ["health disappears but OS process remains", { neverExit: true }]] as const) {
    test(`${name} does not allow a second writer`, async () => {
        const f = fixture(change);
        await assert.rejects(ensureProxyRunning(f.opts, f.deps));
        assert.deepEqual(f.counts(), { shutdowns: 1, spawns: 0 });
    });
}

test("a foreign recovery lock prevents uncoordinated replacement", async () => {
    const f = fixture();
    const { stateDir } = await import("../src/paths.ts");
    fs.mkdirSync(stateDir(), { recursive: true });
    const lock = path.join(stateDir(), "proxy-dsh-recovery");
    fs.writeFileSync(lock, "foreign coordinator");
    try {
        await assert.rejects(ensureProxyRunning(f.opts, f.deps));
        assert.deepEqual(f.counts(), { shutdowns: 0, spawns: 0 });
        assert.equal(fs.readFileSync(lock, "utf8"), "foreign coordinator");
    } finally {
        fs.unlinkSync(lock);
    }
});

test("degraded successor is not returned even when its health endpoint answers", async () => {
    const f = fixture({ successorDegraded: true });
    await assert.rejects(ensureProxyRunning(f.opts, f.deps), /not full-storage ready/);
    assert.deepEqual(f.counts(), { shutdowns: 1, spawns: 1 });
});

for (const lane of ["dsh", "pi"]) {
    test(`recovery remains opt-in and DSH-only (${lane})`, async () => {
        const f = fixture({ lane });
        const handle = await ensureProxyRunning({ ...f.opts, lane, recoverDegradedDsh: lane !== "dsh" }, f.deps);
        assert.equal(handle.attached, true);
        assert.deepEqual(f.counts(), { shutdowns: 0, spawns: 0 });
    });
}

for (const drift of ["none", "instanceId", "pid"]) {
    test(`default status readiness is bracketed by health identity (${drift})`, async () => {
        const f = fixture({ degraded: false });
        let statusReads = 0;
        let healthReads = 0;
        const server = http.createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/__bili/status") {
                statusReads++;
                res.end(JSON.stringify({ storage: { effective: "full", degraded: false } }));
            } else {
                healthReads++;
                res.end(JSON.stringify({ ok: true, instanceId: drift === "instanceId" && healthReads > 1 ? "changed" : "resident", pid: drift === "pid" && healthReads > 1 ? 123 : process.pid, watchdog: { armed: true, watchers: [999999] } }));
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address();
        assert.ok(addr && typeof addr !== "string");
        const inst = f.deps.readInstanceFile!();
        assert.ok(inst && "pid" in inst);
        const local = { ...inst, origin: `http://127.0.0.1:${addr.port}`, port: addr.port };
        f.deps.readInstanceFile = () => local;
        f.deps.listRegistryInstances = () => [local];
        delete f.deps.fetchHealthInfo;
        try {
            const result = ensureProxyRunning({ ...f.opts, port: addr.port }, f.deps);
            if (drift === "none") assert.equal((await result).attached, true);
            else await assert.rejects(result);
            assert.ok(statusReads > 0);
            assert.ok(healthReads >= 2);
            assert.deepEqual(f.counts(), { shutdowns: 0, spawns: 0 });
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
}

test("concurrent recovery callers share one replacement", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([ensureProxyRunning(f.opts, f.deps), ensureProxyRunning(f.opts, f.deps)]);
    assert.equal(a.origin, b.origin);
    assert.deepEqual(f.counts(), { shutdowns: 1, spawns: 1 });
});

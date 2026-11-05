// A wedged DSH resident (process alive, port + index.db held, health endpoint
// not answering) used to block every restart: bili refused to replace it, so the
// lane stayed on DIRECT sends for minutes and oversized turns failed with a
// local 422 (#4516). Reap is allowed ONLY when the resident is provably the SAME
// install AND completely unresponsive — a resident that still answers health,
// even in degraded storage, must never be killed here.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LauncherDeps } from "../src/launcher.ts";
import type { ProxyInstanceFile } from "../src/instance.ts";

process.env.NODE_TEST_CONTEXT = "1";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-reap-"));
const prevState = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = root;
after(() => {
    if (prevState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevState;
    fs.rmSync(root, { recursive: true, force: true });
});
const { ensureProxyRunning } = await import("../src/launcher.ts");
const { stateDir } = await import("../src/paths.ts");
const { entryScriptFingerprint } = await import("../src/instance.ts");
beforeEach(() => { fs.rmSync(path.join(stateDir(), "proxy-dsh-pending"), { force: true }); });

const script = path.join(root, "entry.js");
fs.writeFileSync(script, "// fixture\n");
const origin = "http://127.0.0.1:18931";

type Change = { responsive?: boolean; degraded?: boolean; fingerprint?: string };

function fixture(change: Change = {}) {
    const inst: ProxyInstanceFile = {
        origin, instanceId: "resident", pid: 999_998, startedAt: 1,
        host: "127.0.0.1", port: 18931, passthrough: false, mitmDomains: [], modelWindows: {},
        codeFingerprint: change.fingerprint ?? entryScriptFingerprint(script), lane: "dsh",
        launchToken: "managed-token",
    };
    let ticks = 0;
    let spawns = 0;
    const terminated: number[] = [];
    let residentAlive = true;
    let mine: ProxyInstanceFile | undefined;
    const deps: LauncherDeps = {
        scriptPath: script, nodeRuntime: process.execPath,
        now: () => ticks, sleep: async (ms) => { ticks += ms; },
        readInstanceFile: () => mine ?? inst,
        listRegistryInstances: () => mine ? [mine] : [inst],
        fetchHealthInfo: async () => {
            if (mine) return { ok: true, instanceId: "successor", pid: 42471, storage: { effective: "full", degraded: false }, watchdog: { armed: true, watchers: [999999] } };
            if (change.responsive === false) return undefined;
            return { ok: true, guardedShutdown: true, instanceId: "resident", pid: inst.pid, storage: { effective: "full", degraded: change.degraded ?? false }, watchdog: { armed: true, watchers: [999999] } };
        },
        fetchImpl: async () => ({ ok: true }),
        isConnectable: async () => true,
        isRecoveryPidAlive: () => residentAlive,
        terminatePid: (pid: number) => { terminated.push(pid); residentAlive = false; },
        requestInstanceShutdown: async () => false,
        registerWatcher: async () => "ok",
        attachDiag: () => {},
        resolveAttachUrl: () => undefined, resolveAttachExternal: () => false,
        resolveAttachPolicy: () => "own-lane", attachLanePriority: () => [],
        spawnImpl: (_cmd, _args, options) => {
            spawns++;
            mine = { ...inst, instanceId: "successor", pid: 42471, launchToken: options.env?.BILI_LAUNCH_TOKEN };
            residentAlive = false;
            return { pid: 42471, unref() {} };
        },
    };
    const opts = { host: "127.0.0.1", port: 18931, passthrough: false, debug: false, lane: "dsh", parentPid: 999999, recoverDegradedDsh: true };
    return { deps, opts, counts: () => ({ spawns, terminated: [...terminated] }) };
}

test("unresponsive resident of our own install is reaped and replaced exactly once", async () => {
    const f = fixture({ responsive: false });
    const handle = await ensureProxyRunning(f.opts, f.deps);
    assert.equal(handle.child?.pid, 42471);
    assert.deepEqual(f.counts(), { spawns: 1, terminated: [999_998] });
});

test("unresponsive resident from a DIFFERENT install is never killed", async () => {
    const f = fixture({ responsive: false, fingerprint: "a-different-build" });
    await assert.rejects(ensureProxyRunning(f.opts, f.deps), /refusing replacement/);
    assert.deepEqual(f.counts(), { spawns: 0, terminated: [] });
});

test("degraded but still-answering resident is never killed", async () => {
    const f = fixture({ responsive: true, degraded: true });
    await assert.rejects(ensureProxyRunning(f.opts, f.deps), /refusing replacement without proven exclusivity/);
    assert.deepEqual(f.counts(), { spawns: 0, terminated: [] });
});

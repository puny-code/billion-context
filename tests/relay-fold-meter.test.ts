// 2026-11-06 forward-stall forensics: two probes were added to the send path
// because the 20-minute stall had NO line after `invariant-judge` and no number
// saying which synchronous sweep owned the wall clock.
//
//   [send-chokepoint] — the pre-fetch seam block (whole-body re-read)
//   [compress-loop]   — one refold per compress tool-call the model emits
//                       (core.processTurn over the WHOLE original history)
//
// This file pins three things:
//   1. the level mapping (≥200ms warn, else debug) with an INJECTED clock, so
//      no assertion depends on real elapsed time;
//   2. the line shape, so a grep/incident query keeps working;
//   3. that the REAL forward path and the REAL fold round emit those lines with
//      the true wire bytes / message counts (wiring, not just the emitter).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import {
    _logCompressLoopRoundForTest,
    _logSendChokepointForTest,
    _setRelayCostClockForTest,
} from "../src/server/relay.ts";
import { muteStderrLeg, setLogCapture } from "../src/logger.ts";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";

process.env.NODE_ENV = "test";

// Isolation: never open the real state dirs (task requirement). The runner also
// exports these, this is the in-process belt to that suspenders.
const isolation = mkdtempSync(join(tmpdir(), "bili-fold-meter-"));
process.env.BILI_SESSIONS_DIR = join(isolation, "sessions");
process.env.XDG_STATE_HOME = join(isolation, "state");
process.env.XDG_DATA_HOME = join(isolation, "data");
process.env.XDG_CACHE_HOME = join(isolation, "cache");
process.env.XDG_CONFIG_HOME = join(isolation, "config");
test.after(() => rmSync(isolation, { recursive: true, force: true }));

// The probe lines only reach logger.log() when opts.log is on; muting the stderr
// leg keeps that readable (capture-only, like the launcher-spawned children).
muteStderrLeg();

type Line = { level: string; msg: string };
function captureLines(): { lines: Line[]; restore: () => void } {
    const lines: Line[] = [];
    setLogCapture((level, msg) => { lines.push({ level, msg }); });
    return { lines, restore: (): void => setLogCapture(null) };
}

function field(msg: string, name: string): number {
    const m = new RegExp(`${name}=(\\d+)`).exec(msg);
    assert.ok(m, `${name}= missing from ${msg}`);
    return Number(m[1]);
}

// ── 1. deterministic level mapping (injected clock / direct emitter call) ────
// The seam block and each fold round read time through one injectable clock and
// report through one emitter each; these tests exercise those exact functions.
test("[send-chokepoint] stays debug under 200ms and warns at/over it", () => {
    const calls: Line[] = [];
    const log = (level: string, msg: string): void => { calls.push({ level, msg }); };
    _logSendChokepointForTest(log, 199, 8650, 27_300_000, 12);
    _logSendChokepointForTest(log, 200, 8650, 27_300_000, 12);
    _logSendChokepointForTest(log, 250.4, 8650, 27_300_000, 12);
    assert.deepEqual(calls.map((c) => c.level), ["debug", "warn", "warn"]);
    // Shape: `[send-chokepoint] <ms>ms msgs=<n> inbound=<bytes> judge=<ms>ms`.
    assert.equal(calls[0]!.msg, "[send-chokepoint] 199ms msgs=8650 inbound=27300000 judge=12ms");
    // Rounding is display-only: the level is decided on the raw value, so 250.4
    // prints as 250ms and still warns.
    assert.equal(calls[2]!.msg, "[send-chokepoint] 250ms msgs=8650 inbound=27300000 judge=12ms");
});

test("[send-chokepoint] renders unknown counts as `?` instead of NaN", () => {
    const calls: Line[] = [];
    _logSendChokepointForTest((level, msg) => { calls.push({ level, msg }); }, 3, null, null, 0);
    assert.equal(calls[0]!.level, "debug");
    assert.equal(calls[0]!.msg, "[send-chokepoint] 3ms msgs=? inbound=? judge=0ms");
});

test("[compress-loop] refold rounds warn at/over 200ms and stay debug below", () => {
    const calls: Line[] = [];
    const log = (level: string, msg: string): void => { calls.push({ level, msg }); };
    _logCompressLoopRoundForTest(log, 1, 199, 8650);
    _logCompressLoopRoundForTest(log, 2, 200, 8650);
    _logCompressLoopRoundForTest(log, 3, 3600.6, 8650);
    assert.deepEqual(calls.map((c) => c.level), ["debug", "warn", "warn"]);
    assert.equal(calls[0]!.msg, "[compress-loop] round=1 refold=199ms msgs=8650");
    assert.equal(calls[2]!.msg, "[compress-loop] round=3 refold=3601ms msgs=8650");
});

// ── 2. wiring: the real forward path emits [send-chokepoint] ────────────────
const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};
const SSE = (res: http.ServerResponse): ((o: unknown) => void) => {
    const write = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    return write;
};
const CHUNK = (delta: unknown, finish: string | null, usage?: unknown): unknown => ({
    id: "c_test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, ...(finish === null ? {} : { finish_reason: finish }) }],
    ...(usage === undefined ? {} : { usage }),
});

async function withProxy(
    upstreamScript: (reqBody: string, seen: string[]) => (res: http.ServerResponse) => void,
    run: (base: string, seen: string[]) => Promise<void>,
): Promise<void> {
    const seen: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            seen.push(body);
            upstreamScript(body, seen)(res);
        });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({} as never);
    const ctx = 120 * 1024;
    const server = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upPort}`]: { models: { "deepseek-test": { context: ctx } } } },
        modelContextLimit: ctx, kernelConfig: defaultConfig(ctx),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        // The probe lines ride the request logger — enable it; stderr is muted.
        log: true, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as never as ProxyOptions);
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
        await run(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${upPort}`, seen);
    } finally {
        server.close(); server.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.();
        await Promise.allSettled([once(server, "close"), once(upstream, "close")]);
    }
}

const plainChat = (text: string) => (res: http.ServerResponse): void => {
    const line = SSE(res);
    line(CHUNK({ role: "assistant", content: text }, null));
    line(CHUNK({}, "stop", { prompt_tokens: 100, completion_tokens: 5 }));
    res.write("data: [DONE]\n\n");
    res.end();
};

test("the real forward path emits [send-chokepoint] with the bytes/messages it actually re-read", async () => {
    const { lines, restore } = captureLines();
    try {
        await withProxy((_body: string, _seen: string[]) => plainChat("ok."), async (base, seen) => {
            const messages = [
                { role: "system", content: "You are a coding agent. " + FILLER(1, 1) },
                { role: "user", content: "Turn 1: analyze module 1. " + FILLER(2, 1) },
                { role: "assistant", content: "Done. " + FILLER(3, 1) },
            ];
            const res = await fetch(`${base}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "meter-forward" },
                body: JSON.stringify({ model: "deepseek-test", stream: true, messages }),
            });
            assert.equal(res.status, 200, await res.clone().text());
            await res.text();
            assert.equal(seen.length, 1, "exactly one upstream send, so the probe describes it");

            const probe = lines.find((l) => l.msg.startsWith("[send-chokepoint]"));
            assert.ok(probe, `no [send-chokepoint] line captured (lines: ${lines.map((l) => l.msg).join(" | ")})`);
            assert.match(probe.msg, /^\[send-chokepoint\] \d+ms msgs=\d+ inbound=\d+ judge=\d+ms$/);
            assert.ok(probe.level === "debug" || probe.level === "warn", probe.level);
            // `inbound` is the byte size of the body the block re-read: it must be
            // the body upstream received, not a stale/other request's number.
            assert.equal(field(probe.msg, "inbound"), Buffer.byteLength(seen[0]!, "utf8"));
            // `msgs` is the outbound message count of that same wire body.
            const wire = JSON.parse(seen[0]!) as { messages?: unknown[] };
            assert.equal(field(probe.msg, "msgs"), (wire.messages ?? []).length);
        });
    } finally {
        restore();
    }
});

// ── 3. wiring: a real compress round emits [compress-loop] per refold ───────
const parseRefIds = (body: string): string[] => {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
};

test("a real fold round emits [compress-loop] with the injected clock's refold time (warn ≥200ms)", async () => {
    const { lines, restore } = captureLines();
    // Injected monotonic clock: every read advances 250ms, so the refold span is
    // deterministic (250ms ≥ 200ms → warn) and no assertion waits on real time.
    let now = 0;
    _setRelayCostClockForTest(() => (now += 250));
    let compressRounds = 0;
    try {
        await withProxy((reqBody) => {
            const refs = parseRefIds(reqBody);
            // Emit ONE compress tool-call (the first round only) with a wide,
            // valid range taken from the body's own message ids — the same shape
            // the #1592 fold tests use.
            if (compressRounds === 0 && refs.length >= 12) {
                compressRounds++;
                const startId = refs[2]!;
                const endId = refs[refs.length - 6]!;
                const args = JSON.stringify({
                    content: [{ startId, endId, topic: "meter fold", summary: `Fold summary covering ${startId}..${endId}: the pipeline ran cleanly.` }],
                });
                return (res) => {
                    const line = SSE(res);
                    line(CHUNK({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_cmp_1", type: "function", function: { name: "compress", arguments: args } }] }, null));
                    line(CHUNK({}, "tool_calls", { prompt_tokens: 100, completion_tokens: 2 }));
                    res.write("data: [DONE]\n\n");
                    res.end();
                };
            }
            return plainChat("ok.");
        }, async (base, seen) => {
            const messages: Array<Record<string, unknown>> = [
                { role: "system", content: "You are a coding agent. " + FILLER(1, 2) },
            ];
            for (let i = 1; i <= 14; i++) {
                messages.push({ role: "user", content: `Turn ${i}: analyze module ${i}. ` + FILLER(i, 2) });
                messages.push({ role: "assistant", content: `Reply ${i}. ` + FILLER(100 + i, 2) });
            }
            const res = await fetch(`${base}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "meter-fold" },
                body: JSON.stringify({ model: "deepseek-test", stream: true, messages }),
            });
            assert.equal(res.status, 200, await res.clone().text());
            await res.text();
            assert.ok(compressRounds >= 1, "the fake model emitted the compress tool-call");

            const rounds = lines.filter((l) => l.msg.startsWith("[compress-loop]"));
            assert.ok(rounds.length >= 1, `no [compress-loop] line (lines: ${lines.map((l) => l.msg).join(" | ")})`);
            const first = rounds[0]!;
            assert.match(first.msg, /^\[compress-loop\] round=\d+ refold=\d+ms msgs=\d+$/);
            // round numbering is per request and starts at 1
            assert.match(first.msg, /round=1 /);
            // the injected clock makes the refold span exactly one tick (250ms)
            // and 250 ≥ 200 → the slow fold must be warn-visible.
            assert.equal(field(first.msg, "refold"), 250);
            assert.equal(first.level, "warn", first.msg);
            // `msgs` counts the history this round re-folded (the whole original
            // history), so it tracks the client's message list — allow the one or
            // two slots prepare hoists out of `messages` (system / injected nudge)
            // so this stays a whole-history assertion rather than an exact-shape one.
            const foldedMsgs = field(first.msg, "msgs");
            assert.ok(Math.abs(foldedMsgs - messages.length) <= 2, `refold counted ${foldedMsgs} of ${messages.length} client messages: ${first.msg}`);
            assert.ok(seen.length >= 2, "the fold triggered a re-request upstream");
        });
    } finally {
        _setRelayCostClockForTest();
        restore();
    }
});

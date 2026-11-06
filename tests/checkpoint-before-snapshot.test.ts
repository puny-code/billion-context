import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { DSH_CHECKPOINT_PREAMBLE_PREFIX } from "../src/server/dsh-compaction-guard.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "shadow";
process.env.BILI_CONFIG_FILE = path.join(
  mkdtempSync(path.join(tmpdir(), "checkpoint-config-")),
  "absent.json",
);

const SUMMARY =
  "STALE_FOLD_MUST_NOT_REVIVE: earlier setup and implementation details summarized for the continuing conversation.";
const CHECKPOINT =
  DSH_CHECKPOINT_PREAMBLE_PREFIX +
  " of the conversation. CURRENT_CHECKPOINT_ONLY: continue with the retained tail.";
const history = Array.from({ length: 23 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user",
  content: `OLD_HISTORY_${i}_ ` + `WORK_${i}_content_`.repeat(88),
}));
type Protocol = "openai" | "anthropic" | "responses" | "google";

async function withRig(
  fn: (
    send: (protocol: Protocol, messages: typeof history) => Promise<string>,
    store: SessionStore,
  ) => Promise<void>,
  foldEnd = "m00009",
): Promise<void> {
  process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
  const dir = mkdtempSync(path.join(tmpdir(), "checkpoint-snapshot-"));
  const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
  _setStoreForTest(store);
  _resetSessionsForTest();
  setRegistryForTest({});
  let hits = 0;
  const bodies: string[] = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      hits++;
      if (hits === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const args = JSON.stringify({
          content: [{ startId: "m00001", endId: foldEnd, summary: SUMMARY }],
        });
        res.write(
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_fold", type: "function", function: { name: "compress", arguments: args } }] } }] })}\n\n`,
        );
        res.end(
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.includes("generateContent"))
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: { role: "model", parts: [{ text: "ok" }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 1000,
              candidatesTokenCount: 1,
              totalTokenCount: 1001,
            },
          }),
        );
      else if (req.url?.includes("/messages"))
        res.end(
          JSON.stringify({
            id: "msg1",
            type: "message",
            role: "assistant",
            model: "gpt-test",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1000, output_tokens: 1 },
          }),
        );
      else if (req.url?.includes("/responses"))
        res.end(
          JSON.stringify({
            id: "resp1",
            object: "response",
            status: "completed",
            output: [
              {
                type: "message",
                id: "m1",
                role: "assistant",
                content: [{ type: "output_text", text: "ok", annotations: [] }],
              },
            ],
            usage: { input_tokens: 1000, output_tokens: 1, total_tokens: 1001 },
          }),
        );
      else
        res.end(
          JSON.stringify({
            id: "c2",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 1,
              total_tokens: 1001,
            },
          }),
        );
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const proxy = await startServer({
    port: 0,
    host: "127.0.0.1",
    upstream: origin,
    routes: { [origin]: { models: { "gpt-test": { context: 30_000 } } } },
    modelContextLimit: 30_000,
    kernelConfig: defaultConfig(30_000),
    compress: { injectTool: true, injectNudge: false },
    promptCache: { routing: "auto" },
    sessionHeader: "x-acp-session",
    log: false,
    debug: false,
    passthrough: false,
    passthroughSource: null,
    autoUpdate: false,
    autoRestartOnUpdate: false,
    updateTag: "latest",
    advisoryCheck: false,
    releaseNotesCheck: false,
    compat: { roles: {} },
    streamErrorShape: "protocol",
    mitm: { enabled: false, domains: [] },
  } as unknown as ProxyOptions);
  await once(proxy, "listening");
  const root = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${origin}`;
  const send = async (
    protocol: Protocol,
    messages: typeof history,
  ): Promise<string> => {
    const route = {
      openai: "/v1/chat/completions",
      anthropic: "/v1/messages",
      responses: "/v1/responses",
      google: "/v1beta/models/gpt-test:generateContent",
    }[protocol];
    const payload =
      protocol === "responses"
        ? { model: "gpt-test", input: messages }
        : protocol === "google"
          ? {
              contents: messages.map((m) => ({
                role: m.role === "assistant" ? "model" : "user",
                parts: [{ text: m.content }],
              })),
            }
          : {
              model: "gpt-test",
              messages,
              max_tokens: 1024,
              ...(hits === 0 ? { stream: true } : {}),
            };
    const result = await fetch(root + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acp-session": "checkpoint-order",
        ...(getSession("checkpoint-order")?.metadata.pluginAgent === "dsh"
          ? {
              "x-bili-plugin": "dsh",
              "x-bili-plugin-conversation": "checkpoint-order",
              "x-bili-plugin-compression": "proxy",
            }
          : {}),
      },
      body: JSON.stringify(payload),
    });
    const text = await result.text();
    assert.equal(result.status, 200, text);
    return bodies.at(-1)!;
  };
  try {
    await fn(send, store);
  } finally {
    proxy.close();
    proxy.closeIdleConnections();
    await once(proxy, "close");
    upstream.close();
    upstream.closeIdleConnections();
    await once(upstream, "close");
    store.closeQuietly();
    delete process.env.BILI_ROLLOUT_SNAPSHOT_RENDER;
    await rmrf(dir);
  }
}

for (const protocol of [
  "openai",
  "anthropic",
  "responses",
  "google",
] as const) {
  for (const foldEnd of ["m00005", "m00009"]) {
    for (const authored of [false, true]) {
      test(`${protocol}: ${foldEnd} landed ${authored ? "authored" : "native"} checkpoint resets before snapshot render and never revives old content`, async () => {
        await withRig(async (send, store) => {
          await send("openai", history);
          const session = getSession("checkpoint-order")!;
          assert.ok(
            session.state.blocks.some((b) => b.active),
            "real model compress created the fold",
          );
          for (
            let i = 0;
            i < 200 && !store.unifiedTailSeqs(session.id)?.length;
            i++
          )
            await new Promise((r) => setTimeout(r, 25));
          assert.ok(
            store.unifiedTailSeqs(session.id)?.length,
            "real unified transcript is available",
          );
          const steady = await send("openai", history);
          assert.ok(
            steady.includes(SUMMARY),
            "negative control: normal replay retains the fold",
          );
          assert.ok(
            Number(session.metadata.snapshotRenderTurns) > 0,
            "D lane really activated before landing",
          );
          session.metadata.pluginAgent = "dsh";
          const checkpoint = authored
            ? '\x3cbili-snapshot v1 conv="checkpoint-order" seq="23" blocks="retired" /\x3e\nCURRENT_CHECKPOINT_ONLY: authored checkpoint'
            : CHECKPOINT;
          const compacted = [
            { role: "user", content: checkpoint },
            ...history.slice(-4),
          ];
          const landed = await send(protocol, compacted);
          assert.ok(
            !landed.includes("STALE_FOLD_MUST_NOT_REVIVE"),
            "landed checkpoint must not resurrect the old fold summary",
          );
          assert.ok(
            !landed.includes("OLD_HISTORY_10_"),
            "uncovered old server head must not resurrect either",
          );
          assert.ok(
            landed.includes("CURRENT_CHECKPOINT_ONLY"),
            "current checkpoint survives",
          );
          assert.ok(landed.includes("OLD_HISTORY_22_"), "retained tail survives");
          assert.equal(
            session.state.blocks.filter((b) => b.active).length,
            0,
            "native boundary retired old folds",
          );
          const next = await send(protocol, [
            ...compacted,
            { role: "assistant", content: "ok" },
            { role: "user", content: "Continue after native checkpoint" },
          ]);
          assert.ok(
            !next.includes("STALE_FOLD_MUST_NOT_REVIVE") &&
              !next.includes("OLD_HISTORY_10_"),
            "next turn cannot resurrect the retired prefix",
          );
        }, foldEnd);
      });
    }
  }

  test(`${protocol}: a fresh checkpoint replacing less than half the fold still lands`, async () => {
    await withRig(async (send) => {
      await send("openai", history);
      const session = getSession("checkpoint-order")!;
      session.metadata.pluginAgent = "dsh";
      const outbound = await send(protocol, [{ role: "user", content: CHECKPOINT }, ...history.slice(2)]);
      assert.ok(!outbound.includes(SUMMARY), "partial covered replacement cannot revive the old summary");
      assert.ok(outbound.includes("OLD_HISTORY_22_"), "retained history survives");
      assert.equal(session.state.blocks.filter((b) => b.active).length, 0);
    });
  });

  for (const kind of ["ordinary", "old-native", "old-authored", "quoted-native", "quoted-authored"] as const) {
    test(`${protocol}: ${kind} history loss is not a fresh checkpoint boundary`, async () => {
      await withRig(async (send) => {
        const authored = '\x3cbili-snapshot v1 conv="checkpoint-order" seq="23" blocks="retired" /\x3e';
        const marker = kind.endsWith("authored") ? authored : CHECKPOINT;
        const initial = history.map((m, i) => i === 12 && kind.startsWith("old-")
          ? { ...m, role: "user", content: marker }
          : m);
        await send("openai", initial);
        const session = getSession("checkpoint-order")!;
        session.metadata.pluginAgent = "dsh";
        const before = session.state.blocks.filter((b) => b.active).map((b) => b.blockId);
        assert.ok(before.length, "real fold exists before partial history loss");
        const replay = initial.slice(kind === "ordinary" ? 2 : 8);
        if (kind.startsWith("quoted-")) replay.push({ role: "user", content: `Review this quoted transcript, not a checkpoint:\n${marker}` });
        const outbound = await send(protocol, replay);
        assert.equal(session.metadata.nativeCompactionBoundary, undefined, "ordinary loss or quoted/old markers must not reset ACP state");
        assert.ok(session.state.blocks.some((b) => b.active && before.includes(b.blockId)), "the existing fold remains active");
        assert.ok(outbound.includes(SUMMARY), "normal snapshot replay retains the existing fold summary");
      });
    });
  }
}

# 超大历史会话通用恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"历史已经超过模型窗口"的会话**普遍**能被压缩并继续使用——不是修好某一个会话，而是让这一类会话在每个宿主压缩周期都能写出完整检查点，并让 bili 在压缩之前不再抢先拒绝。

**Architecture:** 这类会话的断点不在"折叠得不够"，而在"检查点写不出来"。DSH 的压缩器把收到的历史重放给上游，输出上限本是 65,536（`dsh-compaction-basic` 的 `maxTokens` 默认值）；但 provider 层用**未折叠**的历史算 `max(max_tokens, 1)` 式夹取，历史超窗时把上限压到 1，上游 200 却只写 1 个 token，宿主据此判定 `summarization truncated at the token cap (incomplete checkpoint)` 并丢弃检查点。bili 的 `planCompactionFit` 只重排 `messages`、把被压死的额度逐字带过去。修法分两层：**(1)** 在 fit 之后按窗口重算并写回回复额度（饿了要抬、过大要压），保证 `input + output ≤ window`；**(2)** 保住 pre-fold"先折叠、后裁决"的行为，使 bili 在任何压缩之前的超窗请求上不会抢先 413。因为 fit 能丢弃任意多的历史，这个修法与会话规模无关，适用于所有走宿主压缩的会话。

**Tech Stack:** TypeScript strict ESM、Node `node:test` + `tsx`、`tsup` 构建、bili 的 native-fetch 拦截层。

**Spec:** 无独立 spec 文件。依据是 2026-11-07 的实测日志（`bili.log` 与 DSH 会话日志）与代码证据，每处引用都写在任务里。历史计划 `2026-11-07-overflow-degradation.md` 及其审阅已废止，只作背景。

## Global Constraints

- 绝不打开、写入或迁移正在运行的 bili 数据库；不重启 DSH；不替换用户的安装目录。
- 测试一律用 `node --import tsx --test tests/<file>.test.ts`（裸 `node --test` 会 `ERR_MODULE_NOT_FOUND … src\agent\fetch-chain\index.js`）。
- 每个测试进程使用独立 `XDG_STATE_HOME`（`$env:TEMP` 下新建目录），串行执行。
- `npx tsc --noEmit -p tsconfig.json` 必须 exit 0。
- 提交在构建之前；`git status --porcelain` 为空时 `scripts/write-build-info.mjs` 才写出非 `-dirty` 的构建信息。
- 任何"已修复"的结论必须有测试或日志行支撑，不得只凭推理。
- 不改 `src/server/handle.ts:1373-1377` 的 DSH 压缩服务端直通——事故不走那条（见下方基线），改它等于改错车道。
- 修复不得依赖任何具体会话 id、消息条数或模型名。

## 事实基线（执行者先读，不要重新论证）

- 车道归属：事故日志前缀是 `[native-client] [compaction-fit]`，行内含 `hand-back → …/v1/chat/completions … accepted: 200`；同一时期 `bili.log` 里 `dsh native compaction — relaying verbatim` 出现 **0 次**。所以事故走客户端 hand-back，不是服务端直通。
- 额度被压死：同一条 hand-back 日志显示 `1,048,575 tok input budget (1,048,576 window − 1 reply reserve)`——fit 认为回复只值 1 个 token。
- 检查点被丢弃：紧随其后的 `compaction/end` 报 `summarization truncated at the token cap (incomplete checkpoint)`。
- 宿主会替换历史：`dsh-compaction-basic/lib/index.js:650-655` 追加一条 `user/message`，带 `surfaceOp: {op:"replace", startSeq, endSeq}`；`dsh-session/lib/index.js:1657-1660` 说明 surface 是派生历史的唯一来源，replace 删除被遮蔽的节点。成功先例：同一宿主日志里 `636,023 tok` 输入 → `3,589` tok / `15,779` 字符的检查点，`maxTokens 65,536`。
- 宿主判据宽松：`dsh-compaction-basic/lib/index.js:358-368` 只在 `error` / `aborted` / `max-tokens` 三种情况下拒绝；`:328` 只要 text 非空。没有最小长度、没有必填字段。
- 现有 `tests/compaction-oversize-fit.test.ts` 19 项全绿，其中两项**显式 pin 住** `max_tokens` 保持 8192（`:199`）与 512（`:313`），还有一项 pin 住 pretty-printed envelope 逐字节不变（`:289-315`）。新逻辑不得破坏它们。

## 覆盖范围（通用性声明）

**覆盖**：任何触发宿主压缩的会话。压缩重放无论多大，fit 都能靠丢弃前缀把它压进窗口，所以规模不设上限；额度重算与协议无关（只要 `protocolOf` 认得）。

**已支持的三种线**：`anthropic`（`messages` + `max_tokens`）、`openai`（`messages` + `max_tokens`/`max_completion_tokens`）、`responses`（`input` + `max_output_tokens`）。

**不覆盖（必须显式记录，不得静默）**：`protocolOf` 返回 `undefined` 的线（例如 google 的 `generationConfig.maxOutputTokens`）。这类请求今天完全不进 fit。本计划加一条 warn 让它在日志里可见，但**不实现** google 的 fit——没有现成解析器与测试样本，硬加是赌博。

**不覆盖（工作区外）**：宿主自己的 `maxTokens` 配置；若用户把压缩输出上限设得比本计划的恢复值还小，那是用户意图，bili 不覆盖。

## 文件结构

| 文件 | 责任 | 本次改动 |
|---|---|---|
| `src/agent/compaction-fit.ts` | 纯函数：把超窗的压缩报文裁成可发送的形状 | 新增额度识别/重算/写回、`outputTokens` 字段、不支持协议的探测函数 |
| `src/agent/native-intercept.ts` | 拦截宿主 fetch，负责 hand-back 与超长重试 | **用真实声明窗口做 fit**（不再抬到 1M）、按窗口算 fit floor、日志增加恢复后的额度；不做阻塞式流读取 |
| `src/server.ts` | 服务端车道与折叠后裁决 | 保留 pre-fold 防转发逻辑并加注释（工作区已有改动） |
| `tests/compaction-starved-output.test.ts` | 新建，覆盖核心行为 | 新建 |
| `tests/issue2490-ledger-floor-doomed-probe.test.ts` | pre-fold 守卫的既有 pin | 断言已按 post-fold 终局文案更新（工作区已完成），随 Task 3 一起提交 |

---

### Task 1: 按窗口重算并写回回复额度

**Files:**
- Modify: `src/agent/compaction-fit.ts:50-61`（常量区）、`:73-94`（`CompactionFitPlan` 接口）、`:109-115`（`declaredOutputTokens`）、`:291-296`（`protocolOf`）、`:304-419`（`planCompactionFit`）
- Modify: `src/agent/native-intercept.ts:1355`（`fitFloorBytes`）、`:1373-1393`（`compactionFitFor` 的窗口解析与调用）、`:1219` 附近（400 重试分类）
- Test: `tests/compaction-starved-output.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `declaredOutputTokens(parsed)`、`topLevelArraySpanOf`、`COMPACTION_FIT_OUTPUT_RESERVE_PCT`、`COMPACTION_FIT_TARGET_RATIO`、`isDshCompactionCall`、`DSH_COMPACTION_MARKER_SNIFF`。
- Produces:
  - `export const COMPACTION_FIT_STARVED_OUTPUT_MAX = 256;`
  - `export const COMPACTION_FIT_RESTORED_OUTPUT_TOKENS = 32768;`
  - `export const COMPACTION_FIT_OUTPUT_SAFETY_TOKENS = 2048;`
  - `export interface ReplyAllowanceRewrite { head: string; tail: string }`
  - `export function rewriteReplyAllowance(head: string, tail: string, value: number, declared: number | undefined): ReplyAllowanceRewrite | undefined`
  - `export function looksLikeHostCompaction(raw: string): boolean`
  - `CompactionFitPlan` 新增 `outputTokens: number`（0 = 报文原本没有该字段）

- [ ] **Step 1: 写失败的测试**

创建 `tests/compaction-starved-output.test.ts`：

```ts
// A compaction request whose reply allowance was clamped to ~1 token cannot
// produce a checkpoint: the provider answers 200 and writes one token, the host
// reads that as `summarization truncated at the token cap (incomplete
// checkpoint)` and throws the checkpoint away. These cases pin the restore, and
// pin that a healthy or deliberately small allowance is never touched.
import test from "node:test";
import assert from "node:assert/strict";

// These cases exercise pure functions only — no store, no state dir. Do NOT set
// XDG_STATE_HOME here: ESM hoists static imports above any assignment, so an
// in-file assignment would run after the module under test has loaded.

import {
    COMPACTION_FIT_RESTORED_OUTPUT_TOKENS,
    planCompactionFit,
    rewriteReplyAllowance,
} from "../src/agent/compaction-fit.ts";

const DIRECTIVE = "You are now acting as a compaction engine for this AI coding assistant. Summarize the conversation above.";
const TASK = "TASK: ship the API change without breaking callers.";

type Rec = Record<string, unknown>;

/** Anthropic-shaped replay: `pairs` user+assistant exchanges of `padChars` each.
 *  Alternating roles matter — a fixture of assistant-only turns gives the cut
 *  finder exactly one legal boundary, so every case collapses to a 682-byte
 *  body and proves nothing about a real replay. */
function anthropicBody(maxTokens: number | undefined, pairs = 40, padChars = 40_000): string {
    const messages: Rec[] = [{ role: "user", content: TASK }];
    for (let i = 0; i < pairs; i += 1) {
        messages.push({ role: "user", content: "u".repeat(padChars) });
        messages.push({ role: "assistant", content: "a".repeat(padChars) });
    }
    messages.push({ role: "user", content: DIRECTIVE });
    const envelope: Rec = { model: "deepseek-test", stream: true, system: "you are a coding agent", messages };
    if (maxTokens !== undefined) envelope.max_tokens = maxTokens;
    return JSON.stringify(envelope);
}

test("starved allowance (max_tokens: 1) is restored and the input budget shrinks with it", () => {
    const plan = planCompactionFit(anthropicBody(1), 100_000);
    assert.ok(plan, "the body is over the window and must be fitted");
    assert.equal(plan.outputTokens, COMPACTION_FIT_RESTORED_OUTPUT_TOKENS);
    assert.equal((JSON.parse(plan.body) as Rec).max_tokens, COMPACTION_FIT_RESTORED_OUTPUT_TOKENS);
    // One budget, not two: input + output must fit the window.
    assert.ok(plan.fittedTokens + plan.outputTokens <= plan.window,
        `fitted ${plan.fittedTokens} + output ${plan.outputTokens} must stay under ${plan.window}`);
    const messages = (JSON.parse(plan.body) as { messages: Rec[] }).messages;
    assert.equal(messages[0].content, TASK, "the opening instruction survives");
    assert.equal(messages.at(-1)!.content, DIRECTIVE, "the directive survives");
    assert.ok(plan.droppedMessages > 0, "history was dropped for size");
});

test("a healthy allowance is never touched", () => {
    const plan = planCompactionFit(anthropicBody(8192), 100_000);
    assert.ok(plan);
    assert.equal(plan.outputTokens, 8192);
    assert.equal((JSON.parse(plan.body) as Rec).max_tokens, 8192);
});

test("a deliberately small allowance (512) is not a collapse signature", () => {
    const plan = planCompactionFit(anthropicBody(512), 100_000);
    assert.ok(plan);
    assert.equal(plan.outputTokens, 512);
    assert.equal((JSON.parse(plan.body) as Rec).max_tokens, 512);
});

test("an allowance larger than the window leaves room for is reduced", () => {
    // 65,536 on a 100k window would make input + output exceed the window even
    // after the fit; the body must be rewritten DOWN, not left as asked.
    const plan = planCompactionFit(anthropicBody(65_536), 100_000);
    assert.ok(plan);
    assert.ok(plan.outputTokens < 65_536, "the declared allowance was reduced");
    assert.equal((JSON.parse(plan.body) as Rec).max_tokens, plan.outputTokens);
    assert.ok(plan.fittedTokens + plan.outputTokens <= plan.window);
});

test("an absent allowance stays absent — the fit does not invent a field", () => {
    const plan = planCompactionFit(anthropicBody(undefined), 100_000);
    assert.ok(plan);
    assert.equal((JSON.parse(plan.body) as Rec).max_tokens, undefined);
    assert.equal(plan.outputTokens, 0);
});

test("a bigger replay still lands inside the window (scale is not a parameter)", () => {
    // 120 user/assistant pairs × 40k chars ≈ 9.6 MB — the shape of a real runaway
    // session, three times the previous case.
    const plan = planCompactionFit(anthropicBody(1, 120, 40_000), 200_000);
    assert.ok(plan);
    assert.ok(plan.fittedTokens + plan.outputTokens <= plan.window);
    assert.ok(plan.droppedMessages >= 100, `dropped ${plan.droppedMessages} earlier messages`);
});

test("rewriteReplyAllowance refuses an ambiguous envelope instead of guessing", () => {
    // A nested object that also declares a NUMERIC `max_tokens` makes two
    // occurrences: the real allowance and the nested one. Must not guess.
    // (A schema entry like `"max_tokens":{"type":"number"}` would NOT match —
    // the regex needs a digit after the colon, so it only produces one hit.)
    const head = '{"model":"m","max_tokens":1,"metadata":{"max_tokens":1},';
    const tail = "}";
    assert.equal(rewriteReplyAllowance(head, tail, 32768, 1), undefined);
});

test("a small window never overruns after the allowance is rewritten", () => {
    // 8k window: rewriting `max_tokens` lengthens the field by a few bytes. An
    // implementation that measures only after the rewrite drops this cut and
    // sends the request verbatim — a guaranteed 400.
    const plan = planCompactionFit(anthropicBody(1, 20, 1_000), 8_192);
    assert.ok(plan, "a starved allowance on a small window still has to fit");
    assert.ok(plan.fittedTokens + plan.outputTokens + 2_048 <= 8_192,
        `fitted ${plan.fittedTokens} + output ${plan.outputTokens} + 2048 must stay under 8192`);
    assert.ok(plan.outputTokens >= 1);
});

test("an ambiguous envelope never ships max_tokens: 1", () => {
    // Two numeric occurrences (the real allowance and a nested one): the rewrite
    // refuses to guess, so the cut must be dropped rather than sent with the
    // 1-token clamp still in it.
    const head = '{"model":"m","max_tokens":1,"metadata":{"max_tokens":1},';
    const msgs = [
        { role: "user", content: "u".repeat(40_000) },
        { role: "assistant", content: "a".repeat(40_000) },
        { role: "user", content: DIRECTIVE },
    ];
    const plan = planCompactionFit(`${head}"messages":${JSON.stringify(msgs)}}`, 100_000);
    if (plan !== undefined) {
        assert.notEqual((JSON.parse(plan.body) as Rec).max_tokens, 1, "a 1-token plan must never be sent");
    }
});
test("rewriteReplyAllowance rewrites exactly one scalar and leaves every other byte", () => {
    const head = '{\n  "model": "m",\n  "max_tokens": 1,\n  "system": "s",';
    const tail = "\n}";
    const out = rewriteReplyAllowance(head, tail, 32768, 1);
    assert.ok(out);
    assert.equal(out.head, '{\n  "model": "m",\n  "max_tokens": 32768,\n  "system": "s",');
    assert.equal(out.tail, tail);
});

test("the same restore works on the openai and responses wires", () => {
    const openai = JSON.stringify({
        model: "m", max_tokens: 1, stream: true,
        messages: [
            { role: "user", content: TASK },
            ...Array.from({ length: 40 }, () => ({ role: "assistant", content: "x".repeat(40_000) })),
            { role: "user", content: DIRECTIVE },
        ],
    });
    const openaiPlan = planCompactionFit(openai, 100_000);
    assert.ok(openaiPlan);
    assert.equal(openaiPlan.outputTokens, COMPACTION_FIT_RESTORED_OUTPUT_TOKENS);

    const responses = JSON.stringify({
        model: "m", max_output_tokens: 1, stream: true,
        input: [
            { role: "user", content: [{ type: "input_text", text: TASK }] },
            ...Array.from({ length: 40 }, () => ({ role: "assistant", content: [{ type: "output_text", text: "x".repeat(40_000) }] })),
            { role: "user", content: [{ type: "input_text", text: DIRECTIVE }] },
        ],
    });
    const responsesPlan = planCompactionFit(responses, 100_000);
    assert.ok(responsesPlan);
    assert.equal(responsesPlan.outputTokens, COMPACTION_FIT_RESTORED_OUTPUT_TOKENS);
    assert.equal((JSON.parse(responsesPlan.body) as Rec).max_output_tokens, COMPACTION_FIT_RESTORED_OUTPUT_TOKENS);
});
```

- [ ] **Step 2: 运行测试，确认它失败**

Run: `$env:XDG_STATE_HOME = Join-Path $env:TEMP ("bili-starved-" + [guid]::NewGuid()); node --import tsx --test tests/compaction-starved-output.test.ts`
Expected: FAIL — `rewriteReplyAllowance` 不是函数 / `plan.outputTokens` 为 `undefined`。

- [ ] **Step 3: 添加常量**

在 `src/agent/compaction-fit.ts` 的 `COMPACTION_FIT_OUTPUT_RESERVE_PCT` 之后（约 `:61`）加入：

```ts
/** Below this a "reply allowance" is not a budget but a collapse artifact.
 *  The provider layer clamps with `max(1, window - inputEstimate - 4096)`, so a
 *  replay that is already over the window declares exactly 1 — and the upstream
 *  then writes a one-token "summary" the host discards as `summarization
 *  truncated at the token cap`. 256 leaves deliberate small budgets (512, 1024,
 *  8192) untouched while catching the clamp. */
export const COMPACTION_FIT_STARVED_OUTPUT_MAX = 256;

/** What a starved allowance is restored to. DSH's own summarizer cap defaults to
 *  65,536 output tokens; half of that (32k ≈ 128 KB of text) is several times
 *  the observed checkpoint size (3,589 tok / 15,779 chars on a 636k-token
 *  replay) and still finishes in minutes rather than tens of minutes. */
export const COMPACTION_FIT_RESTORED_OUTPUT_TOKENS = 32768;

/** Headroom kept between `input + output` and the window so a tokenizer that
 *  counts a little denser than `bytes / 4` cannot re-trip the ceiling. */
export const COMPACTION_FIT_OUTPUT_SAFETY_TOKENS = 2048;
```

- [ ] **Step 4: 添加 `rewriteReplyAllowance` 与 `looksLikeHostCompaction`**

放在 `declaredOutputTokens` 之后（约 `:116`）：

```ts
export interface ReplyAllowanceRewrite {
    head: string;
    tail: string;
}

/** Rewrite the top-level reply allowance of an already-spliced compaction body,
 *  touching ONLY that scalar. `head`/`tail` are the envelope fragments that sat
 *  before and after the replayed array.
 *
 *  Fail-safe by construction: the rewrite happens only when exactly one of the
 *  three known keys appears exactly once AND its value matches what the parsed
 *  envelope declared. A tool schema that also declares a `max_tokens` property
 *  makes the match ambiguous, and an ambiguous match returns undefined so the
 *  caller keeps today's behaviour instead of rewriting the wrong number. */
export function rewriteReplyAllowance(
    head: string,
    tail: string,
    value: number,
    declared: number | undefined,
): ReplyAllowanceRewrite | undefined {
    const KEYS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;
    const hits: Array<{ where: "head" | "tail"; index: number; length: number; key: string; num: number }> = [];
    const scan = (text: string, where: "head" | "tail"): void => {
        for (const key of KEYS) {
            const re = new RegExp(`(?<=[{,]\\s*)"${key}"\\s*:\\s*(\\d+)`, "g");
            for (const m of text.matchAll(re)) {
                hits.push({ where, index: m.index ?? 0, length: m[0].length, key, num: Number(m[1]) });
            }
        }
    };
    scan(head, "head");
    scan(tail, "tail");
    if (hits.length !== 1) return undefined;
    const hit = hits[0]!;
    if (declared !== undefined && hit.num !== declared) return undefined;
    const replacement = `"${hit.key}": ${value}`;
    if (hit.where === "head") {
        return { head: `${head.slice(0, hit.index)}${replacement}${head.slice(hit.index + hit.length)}`, tail };
    }
    return { head, tail: `${tail.slice(0, hit.index)}${replacement}${tail.slice(hit.index + hit.length)}` };
}

/** True when the body carries the host-compaction directive even though no
 *  protocol parser recognised it (today: google's `generationConfig`). Used only
 *  to log the gap loudly — a silent pass-through is how this class of failure
 *  went unnoticed for two rounds. */
export function looksLikeHostCompaction(raw: string): boolean {
    return raw.includes(DSH_COMPACTION_MARKER_SNIFF);
}
```

- [ ] **Step 5: 让 fit 用真实声明的窗口（不要抬到 1M）**

`src/agent/native-intercept.ts:1355` 的 `fitFloorBytes` 与 `:1386` 的 `fitWindow` 都套了 `MIN_ASSUMED_WINDOW_TOKENS`（`src/util.ts:30` = 1,000,000）。对 786,432 的模型这是错的：fit 会按 1,000,000 预算（967,232 输入 + 32,768 输出），算出的 body 真实窗口放不下，第一次 hand-back 必然 400，只能靠重试救回来；而 32k/16k 模型两次重试后仍然超窗，永远 400。

把 `:1386` 改为：

```ts
// A DECLARED window is the model's real ceiling — use it as-is. Lifting it to
// MIN_ASSUMED_WINDOW_TOKENS made the fit budget 967,232 input + 32,768 reply
// on a 786,432-token model: the "fitted" body was still ~7k tokens over the
// real window, so every first hand-back 400'd. An ABSENT window keeps today's
// behaviour (verbatim hand-back, undefined).
const fitWindow = declaredUsable ? Math.floor(declared as number) : undefined;
```

`fitFloorBytes`（`:1355`）改为按本次声明的窗口算。注意顺序：只把 `headerDeclared` 提到早退之前；`declared` / `declaredUsable` / `fitWindow` 仍留在 `:1385` 的 hook 那一行，**不要**提前调用 `declaredWindowForDirect()`（`:1365-1368` 的"普通流量只付字节计数"优化要保住）。用 header 的值做便宜门限，hook 留在原位：

```ts
const headerDeclared = declaredWindowFromHeaders(input, init);
// Cheap door: ordinary traffic pays one header read and one byte compare. The
// cached state hook (which may refresh model info) is still only consulted for
// bodies that clear this floor.
if (bytes !== undefined
    && bytes <= Math.ceil((headerDeclared ?? MIN_ASSUMED_WINDOW_TOKENS) * COMPACTION_FIT_TRIGGER_RATIO) * 4) return undefined;
```

后面 `:1385-1386` 一并改成：

```ts
const declared = headerDeclared ?? state.declaredWindowForDirect?.();
const declaredUsable = declared !== undefined && Number.isFinite(declared) && declared > 0;
const fitWindow = declaredUsable ? Math.floor(declared as number) : undefined;
```

并把 `:1374-1384` 那段 "lifted to the floor" 的旧注释删掉——它描述的正是本次要移除的行为。

（`fitFloorBytes` 是 `native-intercept.ts:1355` 函数内的 `const`，删它别去找模块级常量。残留：无 header 且 body 在 3.2–3.6 MB 时仍会被便宜门限跳过；这类 lane 本来也没有可信窗口，按原行为 verbatim，不算回归。）

验收：在 `tests/compaction-oversize-fit.test.ts` 的 `withIntercept` 夹具里加一个 786,432 窗口、`max_tokens: 1`、body ≈ 3.3 MB 的用例，断言 hand-back 的 body `max_tokens === 32768`、`fittedTokens + 32768 + 2048 <= 786_432`、且**没有发生 400**（第一次就 accepted）。这条是 P0 回归，必须存在。
- [ ] **Step 6: 让 `planCompactionFit` 重算额度**

把 `:344-346` 的三行：

```ts
const reserveCeiling = Math.floor(window * COMPACTION_FIT_OUTPUT_RESERVE_PCT);
const reserved = Math.min(declaredOutputTokens(parsed) ?? reserveCeiling, reserveCeiling);
const budget = Math.max(1, window - reserved);
```

替换为：

```ts
const reserveCeiling = Math.floor(window * COMPACTION_FIT_OUTPUT_RESERVE_PCT);
const declared = declaredOutputTokens(parsed);
// A starved allowance is a clamp artifact, not intent: budget the reply at a
// usable size so the checkpoint can be written, and let the input ceiling
// absorb the difference. The cap keeps a small-window model (e.g. 100k) from
// reserving a reply budget it cannot afford.
const starved = declared !== undefined && declared < COMPACTION_FIT_STARVED_OUTPUT_MAX;
const wantedReply = starved
    ? Math.min(COMPACTION_FIT_RESTORED_OUTPUT_TOKENS, Math.floor(window * 0.4))
    : (declared ?? reserveCeiling);
const reserved = Math.min(wantedReply, reserveCeiling);
const budget = Math.max(1, window - reserved);
```

- [ ] **Step 7: 写出额度并做后置不变量检查**

把 `:394` 的：

```ts
const body = `${raw.slice(0, span.start)}${JSON.stringify(next)}${raw.slice(span.end)}`;
```

替换为下面这一整段：

```ts
const head = raw.slice(0, span.start);
const tail = raw.slice(span.end);
const bodyWith = (value: number | undefined): { body: string; rewritten: boolean } => {
    if (value === undefined) return { body: `${head}${JSON.stringify(next)}${tail}`, rewritten: false };
    const rw = rewriteReplyAllowance(head, tail, value, declared);
    if (rw === undefined) return { body: `${head}${JSON.stringify(next)}${tail}`, rewritten: false };
    return { body: `${rw.head}${JSON.stringify(next)}${rw.tail}`, rewritten: true };
};
let outputTokens = declared ?? 0;
let built = bodyWith(undefined);
let body = built.body;
let fittedBytes = Buffer.byteLength(body);
let fittedTokens = Math.ceil(fittedBytes / 4);
// Keep the existing fail-open guard: a "fit" that does not actually shrink the
// body must never be sent.
if (fittedBytes >= originalBytes) continue;
const roomForReply = window - fittedTokens - COMPACTION_FIT_OUTPUT_SAFETY_TOKENS;
if (roomForReply <= 0) continue;
const wanted = starved ? wantedReply : (declared ?? 0);
if (starved || (declared !== undefined && declared > roomForReply)) {
    // Aim at the full allowance first: a blanket safety shave would turn 32,768
    // into 32,760 and make the restored value impossible to pin in a test. Only
    // shave when the rewrite itself (1 -> 32768 lengthens the field) pushes the
    // sum over the window.
    let target = Math.max(1, Math.min(wanted > 0 ? wanted : wantedReply, roomForReply));
    built = bodyWith(target);
    if (!built.rewritten) {
        // Ambiguous envelope: leaving `max_tokens: 1` in place guarantees a
        // truncated checkpoint, which is worse than a shallower cut.
        process.emitWarning(`[compaction-fit] reply allowance could not be rewritten (ambiguous envelope); trying a shallower cut (window ${window}, fitted ~${fittedTokens} tok)`);
        continue;
    }
    fittedTokens = Math.ceil(Buffer.byteLength(built.body) / 4);
    const overflow = fittedTokens + target + COMPACTION_FIT_OUTPUT_SAFETY_TOKENS - window;
    if (overflow > 0) {
        target = Math.max(1, target - overflow);
        built = bodyWith(target);
        if (!built.rewritten) continue;
        fittedTokens = Math.ceil(Buffer.byteLength(built.body) / 4);
    }
    body = built.body;
    fittedBytes = Buffer.byteLength(body);
    outputTokens = target;
}
if (fittedTokens > ceiling * COMPACTION_FIT_TARGET_RATIO) continue;
if (fittedTokens + outputTokens + COMPACTION_FIT_OUTPUT_SAFETY_TOKENS > window) continue;
```
然后把紧随其后的原 `const fittedBytes = …` / `const fittedTokens = …` 两行删掉（已在上方定义），并把 `return` 里的 `fittedBytes`/`fittedTokens` 改为这两个 `let` 值。

在 `CompactionFitPlan` 接口（`:73-94`）里加字段：

```ts
    /** Reply allowance the fitted body actually declares. 0 when the envelope
     *  carries no allowance field at all. Recomputed against the window so
     *  `fittedTokens + outputTokens + safety <= window` always holds. */
    outputTokens: number;
```

把返回对象里的 `budget: ceiling,` 改为 `budget: Math.max(1, window - outputTokens),`（接口注释承诺的就是“实际使用的输入上限 = window − 回复额度”），并加 `outputTokens,`。

- [ ] **Step 8: 对不支持的线发出可见告警**

在 `planCompactionFit` 的 `const wire = protocolOf(parsed); if (wire === undefined) return undefined;`（`:354-355`）处改成：

```ts
const wire = protocolOf(parsed);
if (wire === undefined) {
    if (looksLikeHostCompaction(raw)) {
        process.emitWarning("[compaction-fit] recognised a host compaction on a wire this build cannot fit (e.g. google generationConfig) — the request is left as-is and may be rejected for size");
    }
    return undefined;
}
```

- [ ] **Step 8b: provider 输出上限的降额重试**

`sendFittedCompaction` 现有的 400 重试只缩输入预算。若 provider 的最大输出小于恢复值（`src/side-request.ts:374-380` 记录了 32K 会在 `maxOutputTokens < 32K` 的 provider 上直接 400），这个 400 会被当作尺寸拒绝，重试只会继续缩输入，永远收敛不到可接受的 `max_tokens`。

给 `planCompactionFit` 加可选第四参 `outputCeiling?: number`，`wantedReply` 取 `Math.min(COMPACTION_FIT_RESTORED_OUTPUT_TOKENS, Math.floor(window * 0.4), outputCeiling)`（`outputCeiling` 缺省时等于恢复值）。

`sendFittedCompaction` 的重试里，正文同时命中 `/max_(?:output_)?tokens?|max_completion_tokens/i` 与 `/too large|exceed/i` 时，用原始 body 重新 `planCompactionFit(raw, window, undefined, Math.max(4096, Math.floor(current.outputTokens / 2)))` 并重发。

两个必须注意的点：① cap 重规划会把输入预算放宽（output 变小），body 反而可能变大，所以这条分支必须**绕过** `:1252` 的 `next.fittedBytes >= current.fittedBytes` 早退守卫，否则第一次 cap 拒绝就直接放弃；② cap 重试要有自己的次数（至少 3 次），不能和尺寸重试共用那 2 次——输出上限 8,192 的 provider 需要 32,768 → 16,384 → 8,192 才收敛。

同时把 `src/agent/native-intercept.ts:1434-1437` 的 `restoredBody !== undefined` 分支也接到 `sendFittedCompaction`（把 `withRestoredBody(directInput, directInit, body)` 作为 `send` 的包装传入），否则增量还原车道仍然没有 400 重切，三种 wire 的通用性不成立。

验收：在 `tests/compaction-oversize-fit.test.ts` 的 `withIntercept` 夹具里加一个用例——第一次返回 400 `max_tokens too large`，断言第二次请求的 `max_tokens` 更小且最终 accepted。

- [ ] **Step 9: 运行新测试，确认通过**

Run: `$env:XDG_STATE_HOME = Join-Path $env:TEMP ("bili-starved-" + [guid]::NewGuid()); node --import tsx --test tests/compaction-starved-output.test.ts`
Expected: PASS，11 tests（9 个协议/额度用例 + 2 个新增：8k 小窗口不因数字增长溢出、歧义报文在 starved 时绝不发出 max_tokens=1）。786k 与 cap 降额的用例在 `tests/compaction-oversize-fit.test.ts`，不在本文件。

- [ ] **Step 10: 运行既有回归**

Run: `$env:XDG_STATE_HOME = Join-Path $env:TEMP ("bili-cfit-" + [guid]::NewGuid()); node --import tsx --test tests/compaction-oversize-fit.test.ts`
Expected: 21 tests / 21 pass（原 19 项含 `:199` 的 8192、`:313` 的 512、`:289-315` 的逐字节用例，加 786,432 窗口回归 + cap 降额重试各 1 项）。

- [ ] **Step 11: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0。

- [ ] **Step 12: 提交**

```bash
git add src/agent/compaction-fit.ts tests/compaction-starved-output.test.ts
git commit -m "fix(compaction): size the reply allowance to the window so the host checkpoint can be written"
```

---

### Task 2: 让 Hand-back 日志能证明恢复生效

**Files:**
- Modify: `src/agent/native-intercept.ts:1211-1213`（`describe`）
- Test: `tests/compaction-starved-output.test.ts`（追加）

**Interfaces:**
- Consumes: `CompactionFitPlan.outputTokens`、`.budget`、`.window`、`.fittedTokens`、`.fittedBytes`、`.droppedMessages`、`.keptMessages`。
- Produces: `export function _formatHandBackLineForTest(plan: Pick<CompactionFitPlan, "window" | "budget" | "outputTokens" | "fittedBytes" | "fittedTokens" | "droppedMessages" | "keptMessages">): string`

**注意**：`tests/compaction-oversize-fit.test.ts:537` 有一条既有正则匹配旧日志文案。新文案必须保留 `hand-back → <url>, <n> B, dropped …` 这段前缀，只在其后追加额度信息，否则那条测试会红。

- [ ] **Step 1: 写失败的测试**

在 `tests/compaction-starved-output.test.ts` 末尾追加：

```ts
test("the hand-back log names the declared allowance and the real input ceiling", async () => {
    const { _formatHandBackLineForTest } = await import("../src/agent/native-intercept.ts");
    const line = _formatHandBackLineForTest({
        window: 786_432,
        budget: 753_664,
        outputTokens: 32_768,
        fittedBytes: 2_406_701,
        fittedTokens: 601_676,
        droppedMessages: 4_190,
        keptMessages: 3_811,
    });
    // Wording is pinned because this line is the operator's only proof, in
    // production, that the allowance was restored rather than left clamped.
    assert.match(line, /2,406,701 B, dropped 4,190\/8,001 msg/);
    assert.match(line, /est ~601,676 tok against a 753,664 tok ceiling \(input budget\)/);
    assert.match(line, /output 32,768 tok of a 786,432 tok window/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --import tsx --test tests/compaction-starved-output.test.ts`
Expected: FAIL — `_formatHandBackLineForTest is not a function`。

- [ ] **Step 3: 抽出可测的格式化函数**

在 `sendFittedCompaction` 之前（约 `:1197`）加：

```ts
/** Exported for the wording test only: the hand-back line is the operator's
 *  proof that an allowance was restored, so it must not be inlined and drift
 *  silently. The leading `B, dropped …` shape is kept because existing tests
 *  and rollback notes match on it. */
export function _formatHandBackLineForTest(plan: Pick<CompactionFitPlan,
    "window" | "budget" | "outputTokens" | "fittedBytes" | "fittedTokens" | "droppedMessages" | "keptMessages">): string {
    return `${plan.fittedBytes.toLocaleString("en-US")} B, dropped ${plan.droppedMessages.toLocaleString("en-US")}/${(plan.droppedMessages + plan.keptMessages).toLocaleString("en-US")} msg, est ~${plan.fittedTokens.toLocaleString("en-US")} tok against a ${plan.budget.toLocaleString("en-US")} tok ceiling (input budget), output ${plan.outputTokens.toLocaleString("en-US")} tok of a ${plan.window.toLocaleString("en-US")} tok window`;
}
```

把 `describe`（`:1212`）的长模板替换为：

```ts
const describe = (level: "info" | "warn" | "error", status: number | string, extra: string): void => {
    logHostEvent(level, "[native-client]", `[compaction-fit] hand-back → ${maskUrlForLog(target)}, ${_formatHandBackLineForTest(current)} — ${extra}: ${status}`);
};
```

- [ ] **Step 4: 运行新测试与既有日志测试**

Run: `node --import tsx --test tests/compaction-starved-output.test.ts`
Expected: PASS，12 tests（11 + 本 Task 新增的日志文案用例）。

Run: `node --import tsx --test tests/compaction-oversize-fit.test.ts`
Expected: 21/21 pass（`:537` 的旧正则仍然命中；含 Task 1 加的 786k 回归与 cap 降额两项）。

- [ ] **Step 5: 提交**

```bash
git add src/agent/native-intercept.ts tests/compaction-starved-output.test.ts
git commit -m "fix(compaction): log the declared allowance on hand-back"
```

---

### Task 3: 保住 pre-fold 守卫（只补注释，不改行为）

**Files:**
- Modify: `src/server.ts:3626` 附近（工作区已有 `unfoldedDoomed` 改动）
- Test: `tests/issue2490-ledger-floor-doomed-probe.test.ts`（**别再改它**：断言已在工作区按 post-fold 终局文案更新，本 Task 只负责把它一起提交）

**Interfaces:**
- Consumes: 现有 `unfoldedDoomed`、`noteLocalRefusal`（`:4119` 仍调用）。
- Produces: 无新符号。

**为什么保留 `unfoldedDoomed`：** 它在 `:3632` 阻止一个已判定必超窗的原始 body 进入 forward-once。删掉会重新打开"把 27MB 原文发给上游"的路径。**为什么 pre-fold 不再写 `noteLocalRefusal`：** pre-fold 不再返回 413，就没有"本地拒绝"可记录；真实终局 413 仍由 `:4119` 记录，`localRefusalCovers` 语义不变。

**不要动测试断言**：该文件基线 9/9 全绿，用例 `:284` 的计数器叫 `calls`，且 `seedStuckMeter` 先发了一次 seed，所以 `calls.length === 1`（`:300` 已有断言）。任何 `calls.length === 0` 的写法都会失败。

- [ ] **Step 1: 补注释**

在 `src/server.ts` 的 `unfoldedDoomed = true;`（约 `:3626`）上方加：

```ts
// A payload that trips BOTH doom bars is not forwarded as-is: folding runs
// first and the post-fold verdict decides. The flag still suppresses the
// forward-once escape below, because re-sending the untouched 27 MB body is
// exactly the guaranteed-400 request this guard exists to stop (#301/#4185).
// No noteLocalRefusal here: nothing was refused yet — the terminal 413 later
// in this function owns that record (#3846).
unfoldedDoomed = true;
```

- [ ] **Step 2: 运行该文件的既有测试**

Run: `$env:XDG_STATE_HOME = Join-Path $env:TEMP ("bili-2490-" + [guid]::NewGuid()); node --import tsx --test tests/issue2490-ledger-floor-doomed-probe.test.ts`
Expected: 9 tests / 9 pass（约 20 s）。

- [ ] **Step 3: 提交**

```bash
git add src/server.ts tests/issue2490-ledger-floor-doomed-probe.test.ts
git commit -m "docs(preflight): explain why the pre-fold guard still suppresses forward-once"
```

---

### Task 4: 全量回归

**Files:**
- 不修改源码。

- [ ] **Step 1: 先提交设计文档，否则下面的干净检查必然失败**

```bash
git add docs/superpowers
git commit -m "docs: add the oversized-session recovery plan"
git status --porcelain
```

Expected: 无输出。（`scripts/write-build-info.mjs` 用 `git status --porcelain` 判定 `-dirty`，未跟踪的 `docs/` 会让构建必然带脏标记。）

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0。

- [ ] **Step 3: 逐文件回归（串行，独立状态目录）**

```powershell
$files = @(
  "tests/compaction-starved-output.test.ts",
  "tests/compaction-oversize-fit.test.ts",
  "tests/issue2490-ledger-floor-doomed-probe.test.ts",
  "tests/preflight-emergency-fold.test.ts",
  "tests/preflight-hold.test.ts",
  "tests/preflight-client-abort.test.ts",
  "tests/issue5630-preflight-fold-unit.test.ts",
  "tests/preflight-dead-ranges.test.ts",
  "tests/native-intercept-selfheal.test.ts",
  "tests/issue1993-preflight-400.test.ts"
)
foreach ($f in $files) {
  $env:XDG_STATE_HOME = Join-Path $env:TEMP ("bili-reg-" + [guid]::NewGuid())
  node --import tsx --test $f
}
```

Expected: 全部 PASS（基线：`compaction-oversize-fit` 19，Task 1 后应为 21，勿按 19 校验；`issue2490` 9、`preflight-emergency-fold` 7、`preflight-hold` 4、`preflight-client-abort` 9、`issue5630` 9、`native-intercept-selfheal` 22）。

- [ ] **Step 4: 记录已知红灯（不改它们）**

以下三个文件在干净 HEAD 上就失败，与本计划无关，**不得**放宽断言转绿，也**不在本计划内修改**：

- `tests/preflight-round-budget.test.ts`（2 fail）
- `tests/issue3918-preflight-progress-verdict.test.ts`（1 fail）
- `tests/preflight-target-stability.test.ts`（1 fail）

在提交说明里记录它们的失败输出与"非本计划引入"的依据（三者都不走过 `src/server.ts` 的 pre-fold 分支；`preflight-target-stability.test.ts` 只 import `src/preflight.ts`）。

- [ ] **Step 5: 提交回归记录**

若 `git status --porcelain` 非空（例如新增了笔记文件），提交它；否则跳过。

---

### Task 5: 发布 v1.4.6

**Files:**
- Modify: `package.json`、`package-lock.json`（版本号）；`bili-ops/ROLLBACK.md`（仓库外，手工追加）
- Create: `<repo>/.release-notes-v1.4.6.md`（绝对路径见 Step 3；不要用相对路径，发布步骤可能在不同 cwd 下执行）

- [ ] **Step 1: 升版本并构建**

```bash
npm version 1.4.6 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v1.4.6"
git status --porcelain   # 必须为空
npm run build
```

Expected: `dist/` 生成，`build-info` 不含 `-dirty`。

- [ ] **Step 2: 打包并记录哈希**

```powershell
$out = Join-Path $env:TEMP "bili-release-1.4.6"
New-Item -ItemType Directory -Force -Path $out | Out-Null
npm pack --pack-destination $out
Get-ChildItem "$out\*.tgz" | ForEach-Object { "{0} {1} bytes" -f $_.Name, $_.Length }
Get-FileHash "$out\billion-context-1.4.6.tgz" -Algorithm SHA256
```

- [ ] **Step 3: 写 release notes**

创建 `$notesPath = Join-Path $repo ".release-notes-v1.4.6.md"`（与 ROLLBACK 一样放在仓库外的 `bili-ops` 更稳；无论放哪，后续步骤一律用这个绝对路径），内容至少包含：修了什么（回复额度按窗口重算、pre-fold 先折叠后裁决）、影响面（所有走宿主压缩的超大会话）、升级方式、回滚方式。**不要**把 #5630 列为 v1.4.6 的新修复——它已在 v1.4.5 里。

- [ ] **Step 4: 打 tag 并推送**

```bash
git tag v1.4.6
git remote -v
# 仅当上面的输出里没有 github 时才执行下一行
git remote add github https://github.com/puny-code/billion-context.git
git push github HEAD:main --tags
```

Expected: `git ls-remote --tags github v1.4.6` 能查到该 tag。

- [ ] **Step 5: 建 Release 并上传资产**

```powershell
# token 只在内存里；去掉 git credential 输出里可能带的 \r
$cred = ("protocol=https`nhost=github.com`n`n" | git credential fill)
$token = (($cred -split "`n" | Where-Object { $_ -like "password=*" }) -replace "`r", "").Substring(9)
$headers = @{ Authorization = "Bearer $token"; Accept = "application/vnd.github+json"; "X-GitHub-Api-Version" = "2022-11-28" }

git ls-remote --tags github v1.4.6   # 必须先有输出，release create 不会替你建 tag
if (Test-Path $notesPath) {
  $notes = @{ tag_name = "v1.4.6"; name = "v1.4.6"; body = (Get-Content $notesPath -Raw); draft = $false; prerelease = $false } | ConvertTo-Json
  $rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/puny-code/billion-context/releases" -Headers $headers -Body $notes -ContentType "application/json"
  curl.exe -sS -X POST -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" `
    -H "Content-Type: application/gzip" --data-binary "@$out/billion-context-1.4.6.tgz" `
    "https://uploads.github.com/repos/puny-code/billion-context/releases/$($rel.id)/assets?name=billion-context-1.4.6.tgz"
  $rel.html_url
} else {
  throw "$notesPath missing — create it before creating the release"
}
```

Expected: `https://github.com/puny-code/billion-context/releases/tag/v1.4.6`，资产大小与 Step 2 一致。

- [ ] **Step 6: 追加回滚记录**

在 `C:\Users\LIU\Documents\deepseek-harness\default-workspace\bili-ops\ROLLBACK.md` 追加 v1.4.6 的版本号、tgz 字节数、sha256、release URL。

---

## 上线后的通用验收（用户执行，不在本计划内自动执行）

安装 `billion-context-1.4.6.tgz`、重启 DSH，然后：

1. **bili 侧**：`C:\Users\LIU\.local\state\billion-context\bili.log` 出现
   `[compaction-fit] hand-back → … output <n> tok of a <window> tok window`，且 `n` 明显大于 1。
2. **bili 侧**：同一条 hand-back 的 `ceiling (input budget)` 与 `output` 之和不超过 `window`。
3. **DSH 侧**：会话日志新增 `compaction/summary`，紧接一条 `user/message`，其 `source.kind = compact-checkpoint`、`surfaceOp.op = replace`（这是"历史真的被替换"的唯一证据；只看"没有 truncation"不算）。
4. **下一轮**：再触发一次压缩，`bili.log` 的 `[compaction-fit] host compaction request ~<n> tok` 里 `<n>` 应比本次的 ~1.97M 小一个数量级（<150,000）。这是 native direct 车道唯一可靠的收缩证据——`[acp-usage] input=` 只在 relay/plugin 车道出现，`native-intercept.ts` 不写它；`bili.log` 里也没有 `lastInputTokens` 字段。

第 1、3、4 条同时成立，才算"这一类会话可以被正确处理并继续"。

## 明确不做的事（YAGNI）

- **不实现 google `generationConfig` 的 fit**：没有现成解析器与测试样本；只加一条 warn 让它可见。
- **不实现轮内 digest 回退**：它要改 `preflight.ts` 的轮状态机，风险远大于收益。若上线验收第 4 条未达成（宿主压缩成功但下一轮仍超窗），再作为独立计划评估。
- **不实现摘要缓存**：折叠块已由 `src/persist.ts` 冷加载复用（日志 `13 block(s) (13 active)` 即证据）。
- **不做阻塞式 `response.clone()` 读完成原因**：SSE 会等到流关闭才返回；第 1 条验收已提供等效证据。
- **不改 `restoreOutputBudget`（`src/server/side-request.ts:491`）**：那是服务端车道，本次事故走客户端 hand-back，两者不重叠。
- **不修改三个既有失败测试**。

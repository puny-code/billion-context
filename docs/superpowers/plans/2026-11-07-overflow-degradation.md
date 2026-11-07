# bili 超长会话恢复与降级实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让超长 DSH 会话复用已提交折叠，优先压缩/裁剪过早历史，在摘要失败时确定性降级，避免可预防的 400/413 和五分钟无进展。

**Architecture:** 保留现有 preflight、持久化块和原生 compaction-fit 车道，只补齐“折叠前误判”“摘要输出不足”“失败时确定性兜底”“真实报错分类”。不另建持久化缓存系统；只有测试证明同一摘要被重复请求时才加进程内内容哈希缓存。

**Tech Stack:** TypeScript strict ESM、Node.js built-in test runner、tsx、现有 acp-kernel、现有 tsup 构建。

**Spec:** `docs/superpowers/specs/2026-11-07-overflow-degradation-design.md`

## Global Constraints

- 数据安全第一；不打开或改写正在运行的 bili 数据库，不自动安装或重启 DSH。
- 不裁掉系统提示、当前用户任务或工具定义；不转发已知必然超窗的原始报文。
- 模型摘要优先，失败时使用现有确定性摘要；原文仍可恢复。
- 不新增配置项或数据库表；避免与故障无关的架构重构。
- 每个任务先写失败测试，再写最小实现；不把既有失败伪装成本次回归。
- 每个测试文件使用独立 `XDG_STATE_HOME`，串行运行，避免共享状态污染。
- 完成声明必须对应刚运行的测试输出；未在真实事故会话验证的内容只能标为“代码与测试通过”。

## File Map

- `src/server.ts`：pre-fold 触发、折叠后窗口裁决、保活入口。
- `src/preflight.ts`：折叠单元、摘要调用、确定性摘要兜底、可选摘要缓存。
- `src/agent/compaction-fit.ts`：原生 DSH 压缩的历史裁剪与输出预算计算。
- `src/agent/native-intercept.ts`：原生压缩响应完成原因检查和重裁。
- `src/util.ts`：超长报错识别与窗口/用量提取。
- `tests/issue2490-ledger-floor-doomed-probe.test.ts`：pre-fold 先折叠、post-fold 再裁决。
- `tests/compaction-oversize-fit.test.ts`：原生压缩预算与重试。
- `tests/preflight-emergency-fold.test.ts`、`tests/preflight-client-abort.test.ts`：确定性折叠和中断恢复。
- `tests/issue5630-preflight-fold-unit.test.ts`：合并边界与真实入口。
- `docs/superpowers/specs/2026-11-07-overflow-degradation-design.md`：设计与事实边界。

---

### Task 1: 让 pre-fold 超窗先进入折叠，而不是提前拒绝

**Files:**
- Modify: `src/server.ts:3586-3630`
- Test: `tests/issue2490-ledger-floor-doomed-probe.test.ts:281-303`

**Interfaces:**
- Consumes: 现有 `probeForEvidence`、`estimateCoreMessagesUpperBytes`、`localRefusalCovers`。
- Produces: 局部 `unfoldedDoomed: boolean`；不向其他模块导出接口。

- [ ] **Step 1: 固化失败测试**

在现有 e2e 测试增加“未折叠 payload 超字节阈值，但存在可折叠历史”的用例：请求不得直接 413，必须至少出现一次摘要调用；最终响应由折叠后的窗口决定。保留“绝不转发未折叠超大报文”的断言。

```ts
assert.ok(summaries.length > 0, "must attempt folding before refusal");
assert.equal(calls.filter((c) => c.raw.includes('"stream":true')).length, 0);
```

- [ ] **Step 2: 运行并确认失败**

```powershell
$env:XDG_STATE_HOME = Join-Path $env:TEMP 'bili-plan-task1-red'
node --import tsx --test tests/issue2490-ledger-floor-doomed-probe.test.ts
```

预期：旧守卫在折叠前返回 413，摘要调用数为 0。

- [ ] **Step 3: 完成最小实现**

工作区已有半成品：`unfoldedDoomed` 声明、pre-fold 不再 fail-fast、跳过 forward-once。保留该方向，并确保 post-fold 分支仍负责最终窗口判断。

```ts
let unfoldedDoomed = false;
// 超阈值：不转发，不提前 413；进入现有 fold walk。
unfoldedDoomed = true;
// forward-once 仅在 !unfoldedDoomed 时可用。
```

- [ ] **Step 4: 验证**

运行同一测试文件及 `tests/issue5630-preflight-fold-unit.test.ts`。预期两个文件全部通过；不得仅删除字节数断言来转绿。

- [ ] **Step 5: 提交**

```powershell
git add src/server.ts tests/issue2490-ledger-floor-doomed-probe.test.ts
git commit -m "fix(preflight): fold before rejecting oversized history"
```

---

### Task 2: 修复原生 DSH 压缩的输出预算与截断成功误判

**Files:**
- Modify: `src/agent/compaction-fit.ts:304-449`
- Modify: `src/agent/native-intercept.ts:1197-1260`
- Test: `tests/compaction-oversize-fit.test.ts`

**Interfaces:**
- Consumes: `planCompactionFit(raw, declaredWindow, targetTokens?)`、`sendFittedCompaction(...)`。
- Produces: `readCompletionLimitReason(response): Promise<string | undefined>`（模块内部辅助函数，克隆响应后读取，不消耗原响应）。

- [ ] **Step 1: 写失败测试**

增加两类测试：

```ts
// A: 输入裁剪后，max_tokens 不得仍为 1；应恢复为预算允许值并封顶。
// B: HTTP 200 + finish_reason="length" 不得记为 accepted；应触发有界重裁。
assert.ok(outputBudget > 1);
assert.equal(retryCount, 1);
```

覆盖 `max_tokens`、`max_completion_tokens`、`max_output_tokens` 三种字段，以及非流式 JSON 和 SSE。

- [ ] **Step 2: 运行并确认失败**

```powershell
$env:XDG_STATE_HOME = Join-Path $env:TEMP 'bili-plan-task2-red'
node --import tsx --test tests/compaction-oversize-fit.test.ts
```

预期：当前 200 被视为成功，或输出预算仍为 1。

- [ ] **Step 3: 最小实现**

在裁剪后的同一 body 上重算输出预算，不改变其他字段；若剩余额度不足以产生最小摘要，则继续缩小输入目标。`sendFittedCompaction` 对 2xx 克隆读取完成原因，`length`/`max_tokens` 走现有有界重裁，不无限重试。

- [ ] **Step 4: 验证**

重跑 `compaction-oversize-fit`；再跑 `native-intercept-selfheal`，确认不破坏原生 fetch 链。

- [ ] **Step 5: 提交**

```powershell
git add src/agent/compaction-fit.ts src/agent/native-intercept.ts tests/compaction-oversize-fit.test.ts
git commit -m "fix(native): retry truncated host compaction summaries"
```

---

### Task 3: 摘要不健康时使用已有确定性折叠，避免整轮失败

**Files:**
- Modify: `src/preflight.ts:3270-3520`
- Test: `tests/preflight-emergency-fold.test.ts`
- Test: `tests/preflight-client-abort.test.ts`

**Interfaces:**
- Consumes: 现有 `deterministicDigest`、`commitFold`、`summaryBudget`、abort signal。
- Produces: 不新增导出接口；摘要失败分支可返回已提交的确定性折叠结果。

- [ ] **Step 1: 写失败测试**

模拟摘要返回空文本、HTTP 400、超时各一次；断言该区间改走确定性摘要、产生持久块，而不是放弃整轮。断线时保留已提交块，下一次从剩余区间继续。

```ts
assert.ok(result.compressedRanges > 0);
assert.ok(session.state.blocks.length > beforeBlocks);
```

- [ ] **Step 2: 运行并确认失败**

```powershell
$env:XDG_STATE_HOME = Join-Path $env:TEMP 'bili-plan-task3-red'
node --import tsx --test tests/preflight-emergency-fold.test.ts tests/preflight-client-abort.test.ts
```

- [ ] **Step 3: 最小实现**

只在摘要明确失败或耗尽当前区间重试后调用 `deterministicDigest`；沿用 `commitFold`，不绕过完整性、死区间和工具配对检查。客户端 abort 时不发起新摘要，但保留已提交块。

- [ ] **Step 4: 验证**

重跑上述两个文件及 `preflight-dead-ranges`、`issue5630-preflight-fold-unit`，全部通过才算完成。

- [ ] **Step 5: 提交**

```powershell
git add src/preflight.ts tests/preflight-emergency-fold.test.ts tests/preflight-client-abort.test.ts
git commit -m "fix(preflight): fall back to deterministic folds"
```

---

### Task 4: 验证并补齐保活覆盖，不重复造 SSE 机制

**Files:**
- Modify: `src/server/handle.ts:2564-2619`（仅当测试证明入口未覆盖）
- Modify: `src/server.ts:3054-3093`（仅当测试证明保活有缺口）
- Test: `tests/preflight-hold.test.ts`

**Interfaces:**
- Consumes: 已有 `beginPreflightHold`、`beginStreamKeepalive`。
- Produces: 无新增公共接口。

- [ ] **Step 1: 写失败测试**

让摘要调用超过保活宽限期，断言流式客户端持续收到 `: bili-preflight`，且折叠完成后能收到真实上游事件；非流式响应发送合法 JSON 空白保活。

- [ ] **Step 2: 先运行**

```powershell
$env:XDG_STATE_HOME = Join-Path $env:TEMP 'bili-plan-task4'
node --import tsx --test tests/preflight-hold.test.ts
```

若已通过，记录“保活已覆盖 HTTP 车道”，不修改生产代码；原生 fetch 车道按 Task 3 的快速降级处理。

- [ ] **Step 3: 仅修测试证明的缺口**

若入口太晚，移动现有 `beginPreflightHold` 的安装/停止位置；不新增第二套计时器或响应 writer。

- [ ] **Step 4: 提交（仅有生产改动时）**

```powershell
git add src/server.ts src/server/handle.ts tests/preflight-hold.test.ts
git commit -m "test(preflight): cover long-fold client hold"
```

---

### Task 5: 识别真实超长报错，并隔离明确参数错误

**Files:**
- Modify: `src/util.ts:320-540`
- Test: `tests/issue3900-overflow-teaches-calibration.test.ts`
- Test: `tests/issue1993-preflight-400.test.ts`

**Interfaces:**
- Consumes: 现有 `inspectContextOverflow`、`parseOverflowWindow`、`parseOverflowCounts`、`isMarkerlessOverflowReject`。
- Produces: 同样的返回结构，不新增字段；仅补充 `window` 和 `counts` 的解析来源。

- [ ] **Step 1: 写真实文本测试**

```ts
const tooLong = 'Upstream request failed: [InvalidParameter] Input too long: input exceeds the context limit trace_id: x';
assert.equal(inspectContextOverflow(400, tooLong).isOverflow, true);
const counts = 'model limit 1048576 tokens, requested 1972866 tokens';
assert.equal(inspectContextOverflow(400, counts).window, 1048576);
assert.equal(inspectContextOverflow(400, counts).counts?.total, 1972866);
assert.equal(isMarkerlessOverflowReject(400, 'claude-opus-5-5 requires adaptive thinking'), false);
```

- [ ] **Step 2: 运行并确认旧实现失败**

```powershell
$env:XDG_STATE_HOME = Join-Path $env:TEMP 'bili-plan-task5-red'
node --import tsx --test tests/issue3900-overflow-teaches-calibration.test.ts
```

- [ ] **Step 3: 最小实现**

补充精确正则，不使用单独的 `too long` 或 `exceeded` 作为超长证据；参数错误有直接原因时直接排除无标记超长分支。

- [ ] **Step 4: 验证并提交**

```powershell
node --import tsx --test tests/issue3900-overflow-teaches-calibration.test.ts tests/issue1993-preflight-400.test.ts
git add src/util.ts tests/issue3900-overflow-teaches-calibration.test.ts tests/issue1993-preflight-400.test.ts
git commit -m "fix(relay): recognize real overflow wording"
```

---

### Task 6: 只针对“重复摘要”增加可选进程内缓存

**Files:**
- Modify: `src/preflight.ts:1452-1493`（仅当本任务测试证明需要）
- Test: `tests/preflight-client-abort.test.ts`

**Interfaces:**
- Consumes: `summarizeRange` 的 `deps.model`、任务 system、content、长度预算。
- Produces: 模块私有 `readSummaryCache/writeSummaryCache`；不导出、不持久化。

- [ ] **Step 1: 先测复用现状**

提交一个区间后模拟中断，再发起同内容请求；统计上游摘要调用。若已提交块使调用数为 0，则记录“现有增量已满足”，不增加缓存。

- [ ] **Step 2: 只有重复调用确实存在才写缓存测试**

键为 `model + system + content + lengthBudget` 的 SHA-256；只缓存成功且未截断摘要，容量上限 32 项，LRU 淘汰；失败、abort、空摘要不得写入。

- [ ] **Step 3: 验证**

同内容同预算第二次调用命中；内容或模型变化不得命中；进程重启不依赖缓存。通过后才允许实现。

- [ ] **Step 4: 提交（确有缓存实现时）**

```powershell
git add src/preflight.ts tests/preflight-client-abort.test.ts
git commit -m "perf(preflight): reuse successful identical summaries"
```

---

### Task 7: 验证、审计和发布 v1.4.6

**Files:**
- Modify: `package.json` 版本号、`bili-ops/ROLLBACK.md`（工作区运维副本）。
- Test: 本计划涉及的全部测试文件。

- [ ] **Step 1: 类型检查与目标测试**

```powershell
npx tsc --noEmit -p tsconfig.json
node --import tsx --test tests/issue2490-ledger-floor-doomed-probe.test.ts
node --import tsx --test tests/compaction-oversize-fit.test.ts
node --import tsx --test tests/preflight-emergency-fold.test.ts
node --import tsx --test tests/preflight-client-abort.test.ts
node --import tsx --test tests/preflight-hold.test.ts
node --import tsx --test tests/issue5630-preflight-fold-unit.test.ts
```

每个文件使用独立状态目录并串行执行。已知既有失败单独列出，不混入本次通过统计。

- [ ] **Step 2: 安全审查**

确认日志不含未脱敏 URL、密钥或完整用户正文；缓存不跨会话、不持久化；没有改变原始 DSH 历史；没有修改运行中安装目录。

- [ ] **Step 3: 构建与打包**

先提交源码和版本号，再 `npm run build`，确认 build-info 不带 `-dirty`；创建已存在的打包目录后执行 `npm pack --pack-destination <dir>`。

- [ ] **Step 4: 发布**

推送分支和 `v1.4.6` tag，创建 GitHub Release，上传 tgz，核对 size 与 sha256。发布说明必须列出：已修复代码、测试证据、真实事故会话尚未验收、安装与回滚命令。

- [ ] **Step 5: 交付用户验收**

提供 Release 页面和安装代码块；由用户安装并重启 DSH。重启后只读运行 `bili-ops/verify-after-restart.mjs`，并收集 `coalesced`、`preflight round`、`compaction-fit` 三类日志判断真实收敛。

## Self-Review

- 覆盖四个原始问题：Task 2 处理摘要截断；Task 1/3/4 处理超时与预压缩；Task 5 处理错误识别和误报；Task 3/6 处理增量恢复与必要缓存。
- 覆盖“不主动拒绝”选择：Task 1 去掉可折叠 payload 的 pre-fold 413；Task 3 提供确定性降级；不承诺对不可缩小的系统/工具/当前任务也能成功。
- 无占位步骤；所有生产改动均有对应测试和命令。
- 接口名称与现有代码一致；缓存只在重复调用被证实时实现。
- 既有失败文件不得通过简单放宽断言转绿；若其断言已被 Task 1/3 的新行为合法改变，必须单独说明行为差异并保留核心安全断言。

# 实施计划审阅：2026-11-07-overflow-degradation

## 结论

存在阻断性问题：Task 2 的技术前提与代码不符（`planCompactionFit` 根本不管输出预算），Task 1 / Task 5 的验证断言按现写法必然失败（前者把"摘要调用 > 0"写在一个恒定 0 次摘要调用的 fixture 上，后者断言了不存在的 `counts` 字段），且计划没有任何一步消除事故形态下的终局 502/413 —— 需修订后执行。

审阅基线：HEAD `6f45ba42`（#5630 coalesce advertised ranges），工作区有 `M src/server.ts`、`M tests/issue2490-ledger-floor-doomed-probe.test.ts` 两处未提交改动（`git diff --stat`：2 files changed, 13 insertions(+), 6 deletions(-)）。

---

## 逐项核实

### 1. Task 1：pre-fold 先折叠、后裁决

- **判定：部分属实。** 四个符号都在，工作区改动确实把"折叠前 413"改成了"折叠前只记录"，但 `unfoldedDoomed` 是个**死变量**，没有参与任何 post-fold 裁决；"先折叠"成立，"后裁决"没实现。

- **证据：**

  `src/server.ts:3586`（`probeForEvidence` 与 `unfoldedDoomed` 两个符号在此；`localRefusalCovers` 在 3049，`estimateCoreMessagesUpperBytes` 在 `src/preflight.ts:549`）：

  ```ts
  const probeForEvidence = !growthArmed && !unknownBaseline && session.stats.lastInputTokens > 0 && baselineFloor <= 0 && prepared.processedMessages.length > 0;
  let unfoldedDoomed = false;
  ```

  `src/server.ts:3605-3606`（字节闸）：

  ```ts
  const coreTextBytes = estimateCoreMessagesUpperBytes(prepared.processedMessages);
  if (coreTextBytes > Math.max(DOOMED_PROBE_ABSOLUTE_BYTES, limit * DOOMED_PROBE_BYTES_PER_TOKEN)) {
  ```

  工作区 diff 把原来的 fail-fast 换成（`git diff -- src/server.ts`）：

  ```diff
  -            log("error", `[${session.id}] preflight fail-fast 413 (retryable=false): ${doomedMessage}`);
  -            noteLocalRefusal(session, currentOrigin, model, limit);
  -            return { failFast: true, status: 413, message: doomedMessage, retryable: false, respond: !res.writableEnded };
  +            log("warn", `[${session.id}] unfolded payload core text ~${coreTextBytes} bytes exceeds both doom bars — NOT forwarding; folding first, the post-fold check decides ...`);
  +            unfoldedDoomed = true;
  ```

  `src/server.ts:3632`（抑制 #2313 的 forward-once，这是让改动生效的关键一行，**不在计划标称的 3586-3630 区间内**）：

  ```ts
  } else if (!unfoldedDoomed) {
  ```

  全文件搜 `unfoldedDoomed` 只有 3587 / 3626 / 3632 三处，**没有任何读取它做最终裁决的代码**。真正兜底的是 `src/server.ts:4069`：

  ```ts
  if ((unknownBaseline || noUpstreamEvidence || nativeFitAfterClamp) && !growthArmed) {
      ...
      if (doomBytes > Math.max(DOOMED_PROBE_ABSOLUTE_BYTES, limit * DOOMED_PROBE_BYTES_PER_TOKEN)) {
          return { failFast: true, status: 413, ... };
  ```

  事故会话是 usage-baseline（`lastInputTokens = 187 万`），`unknownBaseline` 为假；`noUpstreamEvidence` 要求 `lastInputTokens <= 0`（`src/server.ts:4056`）；`nativeFitAfterClamp` 要求 outbound 预算 + 折叠后估算 ≤ 原生窗口（`4067-4068`）。三者都不成立 → **不进入 4069 分支** → 直接落到 `src/server.ts:4108`：

  ```ts
  const status = f?.kind === "upstream" && f.status === 429 ? 503 : f?.kind === "exhausted" && f.deterministic && !payloadFitsWindow ? 413 : 502;
  ```

  其它 helper 确实存在：`localRefusalCovers` 在 `src/server.ts:3049-3052`；`estimateCoreMessagesUpperBytes` 在 `src/preflight.ts:549-553`（**只累加 `m.text` 字节，不含 system / tools**，所以它量的是"可折叠文本"，不是报文总长）。

  **遗漏路径（未折叠的超大报文仍可能出站）：**

  - `src/server.ts:3674-3676`：image arbitration，`(prepared.nudge?.compressibleRanges ?? []).length === 0` 时直接 `return prepared`。如果一条 5MB 的纯文本 payload 因为全部落在保护区而没有 compressible range，这里会原样转发。
  - `src/server.ts:3552`：`if (limit <= 0 || !model || !triggerFires) return prepared;` —— 窗口未知时不折叠、直接转发。
  - `src/server.ts:3736-3738`：`if (payloadFitsWindow) return prepared;` —— 有估算护栏，安全。
  - `src/server.ts:4087`：`return outbound;` —— 折叠后仍超窗、但字节没到 doom bar 时，**以"让上游仲裁"的名义转发超窗报文**（#3146/#4185 的既有设计）。这是"先折叠后仍可能转发"的真实出口，计划没有提。
  - `src/server/relay.ts:752-775`：egress fuse 用同一套 bar 对 `prepared.processedMessages` 再算一遍，超限写 `413 {code:"egress_window_fuse", retryable:false}`。**Task 1 不触及这条路径**，即使 `src/server.ts` 全改对，出口处仍可能 413。

  **副作用：** diff 删掉了 `noteLocalRefusal(session, currentOrigin, model, limit);`（原 3620 行附近）。这条记录是 #3846 用来钉死"该 origin+model 已被本地拒绝"的证据（`src/server.ts:3032-3042` 写入、`3049-3052` 读取）。删掉后，doomed 场景不再写本地拒绝记录，下一轮 `localRefusalHere` 可能为 false，重新打开估算型 forward-once 的分支。计划没有讨论这个回归。

- **影响与建议：** 改动方向正确且是本次事故的直接止血点（01:59 那条请求死于"任何折叠轮次之前"），但 `unfoldedDoomed` 目前只是日志开关。建议把它变成真正的不变量：fold walk 结束后 `if (unfoldedDoomed && !result.fitsWindow) → 走 egress/413`，或更彻底：把 4069 的条件去掉 `(unknownBaseline || noUpstreamEvidence || nativeFitAfterClamp) && !growthArmed` 这层过滤，让"折叠后仍超窗"一律进入 doom 判定。同时保留 `noteLocalRefusal`，并在计划里显式覆盖 `relay.ts` 的 egress fuse。

---

### 2. Task 2：原生压缩的输出预算与截断误判

- **判定：不属实（核心前提错误）。** `planCompactionFit` 不控制、也控制不了 `max_tokens` / `max_completion_tokens` / `max_output_tokens`；"裁剪后 max_tokens 仍为 1"在压缩车道没有任何依据。

- **证据：**

  `src/agent/compaction-fit.ts:304`：

  ```ts
  export function planCompactionFit(raw: string, declaredWindow: number | undefined, targetTokens?: number): CompactionFitPlan | undefined
  ```

  `targetTokens` 的定义在 `307-313`，是"**输入**的绝对上限（bytes/4 单位）"，不是输出预算；预算计算在 `344-346`：

  ```ts
  const reserveCeiling = window * 0.25;
  const reserved = Math.min(declaredOutputTokens(parsed) ?? reserveCeiling, reserveCeiling);
  const budget = Math.max(1, window - reserved);
  ```

  `budget` 是"输入 + 输出总和不能超窗"反推出来的**输入**额度。模块头 `22-25` 明确只 splice `messages` / `input` 数组，其余字段 byte-identical；测试也 pin 了这一点（`tests/compaction-oversize-fit.test.ts:199`、`313` 断言 `max_tokens` 原样保留 8192 / 512）。

  全仓搜 `max_tokens: 1` 只命中 **cache-keepalive 的空闲 ping**（`src/cache-keepalive.ts:5`："rewriting only max_tokens=1 and stream=false"；`src/config.ts:151` 同义），那是刻意的 1-token 探测请求，与压缩无关。`src/agent/native-intercept.ts` 里 grep `max_tokens|max_completion_tokens|max_output_tokens` **零命中** —— 压缩车道从不读写这三个字段。`src/budget.ts:300` 在 `cap < OUTPUT_CLAMP_FLOOR` 时 `return undefined`，即"不改写"，也不会产生 1。

  `sendFittedCompaction` 确实把 2xx 一律当成功（`src/agent/native-intercept.ts:1219-1221`）：

  ```ts
  if (status < 400) {
      describe("info", String(status), attempt === 0 ? "accepted" : ...);
      return response;
  }
  ```

  **插入点可行**：`1225` 已经在用 `response.clone()` 读错误体，克隆不消耗原响应；函数把原始 `Response` 返回给调用方，所以在 `1219` 分支里读克隆不会破坏下游流。

- **影响与建议：**
  1. "重算输出预算"没有落点：bili 从不设置这三个字段，`declaredOutputTokens` 读的是**客户端声明的值**。要"恢复为预算允许值"就必须改写 `messages` 之外的字段，直接违反该模块的 byte-identical 契约，也可能打掉 prompt cache。正确做法只有两条：把 `max_tokens` 抬到 `window - fittedTokens`（需要新增字段写入并说明理由），或要求摘要更短（降低 `lengthBudget`）。
  2. `finish_reason="length"` 是**输出**预算耗尽，**再裁输入不可能让它变长**。计划 Step 3 写"若剩余额度不足以产生最小摘要，则继续缩小输入目标"，逻辑上是反的：`budget = window - reserved`（`src/agent/compaction-fit.ts:346`）算出来的是**输入**额度，缩输入只会让这个数变大；真正的输出额度是 `reserved`（`345` 行，来自客户端声明或 `window*0.25` 的封顶），与输入大小无关。所以缩输入对 `length` 没有作用，要动的是 `reserved`（抬 `max_tokens`）或要求摘要更短。
  3. `readCompletionLimitReason` 可行，但必须按协议分辨三种 wire：Anthropic `message_delta.delta.stop_reason === "max_tokens"`、OpenAI `choices[0].finish_reason === "length"`、Responses `response.incomplete_details.reason === "max_output_tokens"`。计划只写"非流式 JSON 和 SSE 两种形态"，把"传输形态"当成了"协议"。另外 SSE 的结束原因在尾帧，克隆必须**读到流结束**才可能判定，这在 200 路径上会引入一次完整缓冲（摘要通常几十 KB，可接受，但要写明）。
  4. 现有 `tests/compaction-oversize-fit.test.ts:436` 已经断言"200 `{}` 被接受"，Task 2 会改这条语义，计划没有把它列进需要改的断言。

---

### 3. Task 3：摘要不健康 → 确定性折叠

- **判定：部分属实。** 三个符号都在，但 `summaryBudget` 不是函数；3270-3520 只覆盖"失败分支"，不覆盖 `commitFold`(2602-2661) 和 `deterministicDigest`(1776)；且该任务对事故形态几乎不生效。

- **证据：**

  - `deterministicDigest(entries, startRef, endRef, opts)`：`src/preflight.ts:1776`（**已导出**，`fits()` 在 1796-1797 同时校验 `countText(form) <= shrinkBound` 和 `maxSummary`）。
  - `commitFold`：`src/preflight.ts:2602-2661`，是 `preflightCompress` 内的 local const；`2604 deps.core.applyCompression(...)`、`2633 applyRanges(fold, ctx, {loopTracking:false})`、`2651 currentTokens = max(0, currentTokens - folded + countText(summary))`。
  - `summaryBudget`：**不是函数**，是 `src/preflight.ts:2016` 的 local const `Math.min(16*2, Math.max(16, Math.ceil(16 * overshootRatio)))`，与 `roundBudget`(2017) 并列。计划把它列进 "Consumes" 的接口清单里，措辞像外部 API。
  - 失败分支：`3345-3482`。`3426 catch (err)` → UpstreamHttpError 时 `3434` 置 `failure = {kind:"upstream", status, retryable, ...}`；`3458` 只有 `(err.status===400||413) && !transient && ce>cs && spanUnits>=floorUnits` 才 `pushSpanHalves` 后 continue；其余 `3481 break;`。`3514 if (failure || budgetHit) break;`。终局 `3578-3579` 的 `budgetHit` 或 `3583` 的 deterministic exhausted → `4069/4108` 出 413/502。
  - 计划标称的 `3270-3520` **确实覆盖** `3300` / `3309` 的 `if (emergencyFold) entries.push(...)` 与整个 catch，但 **`entries` 只在 `emergencyFold` 时收集**（`2033 entryOvershoot > 19.2`）。若只在 catch 里接 `deterministicDigest` 而不改 3300/3309，digest 会拿到 `0 message(s)`，产出空摘要后走 `3484 summary === null` → skip。

- **会不会绕过完整性/死区间/工具配对：不会。** digest 结果仍走同一条 `3510 commitFold(...)` → `2604 applyCompression` → `2633 applyRanges`，kernel 侧的覆盖回归与工具配对检查照旧执行；死区间过滤发生在候选生成阶段（`2393` / `2488` 的 `filterDeadRanges`），digest 拿到的已经是过滤后的区间。这一点计划写对了。

- **影响与建议：**
  1. 必须同时改 `3300/3309`（无条件收集 entries，或不依赖 `emergencyFold` 重建 entries），否则新分支是空转。
  2. **与既有测试直接冲突**：`tests/issue1993-preflight-400.test.ts:156-214` pin 的是"系统性硬 400 → 502 + retryable:false + 连续两次一样 + 不转发 + 摘要调用 2..16 次"。Task 3 的 digest 回退会把它变成 200 + 摘要调用 0 次。计划把 issue1993 放在 Task 5/Task 7 的"必须通过"清单里（`225-226`、`258`），却没列进 Task 3 的改动清单——两者不可能同时成立。
  3. **覆盖不到事故形态**：`emergencyFold` 的门槛是 19.2× 窗口；事故是 1.77M/786K ≈ 2.25×，走的是慢速 LLM 摘要路径。真正会在事故里发生的是 `budgetHit`（3578，32 次摘要耗尽）与轮次上限（3596），而这两条分支**不受 Task 3 影响**。这是"消除可预防拒绝"目标的最大缺口（见第 9 条）。

---

### 4. Task 4：验证保活

- **判定：部分属实。** 两个函数都存在，但调用位置写错了一个，测试也已存在且全绿——本任务按现写法几乎没有交付物。

- **证据：**

  - `beginPreflightHold(res, prepared, log)`：`src/server.ts:3063-3093`。`3064` 对 `headersSent || destroyed || writableEnded` 直接返回；stream 分支 `writeHead(200, {..., "x-bili-preflight": "compressing"})` + `": bili-preflight\n\n"`；非 stream 分支 200 + 单个空格；`setInterval(..., PREFLIGHT_KEEPALIVE_MS)`。
  - **唯一调用点**：`src/server.ts:3783-3786`：

    ```ts
    const holdTimer = setTimeout(() => {
        stopHold = beginPreflightHold(res, prepared, log);
    }, preflightHoldGraceMs());
    holdTimer.unref();
    ```

    收尾在 `3834-3836` 的 `finally { clearTimeout(holdTimer); stopHold?.(); }`。
  - `beginStreamKeepalive(res, sid, log)`：`src/server.ts:3114` 起；**唯一调用点**是 `src/server/relay.ts:1844-1849`，条件是 `prepared?.stream === true && upstream content-type includes "text/event-stream"` —— 即**上游 2xx 之后**的流式阶段，完全不覆盖 preflight。计划把它列为 "Consumes"，容易被误读成"preflight 已有两级保活"。
  - `src/server/handle.ts:2564-2619` **不是保活**：那是 `preflightCompressIfNeeded(...)` 的调用与 fail-fast 写出（`2591 if (respondFailFast && outcome.respond && !res.destroyed)`；`2615 res.writeHead(outcome.status, ...)`）。计划把这里标成 `Modify`，执行者按图索骥会改错文件。
  - `tests/preflight-hold.test.ts` **已存在**（383 行），4 个用例全部覆盖计划 Step 1 想写的东西：`122` "stream + slow preflight → early 200 + SSE keep-alive, then the real stream"（`181` 断言 `": bili-preflight"`，`182-183` 断言真实 `text_delta` / `message_stop`）、`201` 429 内联、`256` Responses 协议内联、`306` 非流式空白保活 + 合法 JSON。
  - 保活不是本次新增：`git log -S beginPreflightHold -- src/server.ts` 只有 `19f0fbb4 (#568)`，且 `git show v1.4.4:src/server.ts` 已含 `function beginPreflightHold` 与 `PREFLIGHT_KEEPALIVE_MS`。

- **影响与建议：** 计划说"保活已存在、只需验证"本身**正确**（Step 2 已写"若已通过，记录…不修改生产代码"），但需要改写的是：删掉 `handle.ts:2564-2619` 这个错误锚点；明确 `beginStreamKeepalive` 与 preflight 无关；并补上真正缺失的东西——**preflight 没有全局墙钟上限**。现有预算只有每 chunk 的 `BILI_PREFLIGHT_FOLD_CHUNK_MS`（默认 1200ms，`src/preflight.ts:101-126`）与每轮摘要数，32 轮 × 每次 30-60s 可以轻松跑过 30 分钟。保活只防"HTTP 层超时"，不防"用户等半小时"。

---

### 5. Task 5：真实超长报错识别

- **判定：部分属实。** 要补的三条正则确实缺失（这条属实），但 `counts` 字段不存在、`isMarkerlessOverflowReject` 的设想不可行，而且它只影响一行日志。

- **证据：**

  - `CONTEXT_OVERFLOW_PATTERNS`：`src/util.ts:320-376`，含 `context_length_exceeded`、`context_window_exceeded`、`prompt is too long`、`request_too_large`、`exceed_context_size`、`exceeds the maximum number of tokens`、`context_limit`（下划线）与多条 CJK 正则；**没有** `Input too long`、**没有**带空格的 `context limit`、**没有** `input exceeds the context limit`。
  - 实测（直接 import `src/util.ts`）：

    ```
    inspectContextOverflow(400,'Upstream request failed: [InvalidParameter] Input too long: input exceeds the context limit trace_id: x')
      → {"isOverflow":false}
    ```
  - `parseOverflowWindow`：`src/util.ts:427-462`，支持 "> N maximum"、llama.cpp 括号、Gemini `allowed(N)`、`maximum context length is N`、`limit of N token`、CJK `上限`；**不支持 `model limit N tokens`**。实测：即使先加 marker 让 `isOverflow` 为 true，`context_length_exceeded: model limit 1048576 tokens, requested 1972866 tokens` 仍然 `window: undefined, requestedTotal: undefined`。
  - `parseOverflowCounts`：`src/util.ts:468-494`，支持 OpenAI `requested N tokens (M in the messages, K in the completion)`、Anthropic `prompt is too long: N tokens >`、Gemini `input token count (N) exceeds`、CJK `请求…N tokens，超过`；**不支持 `model limit N tokens, requested M tokens`**。
  - `inspectContextOverflow`：`src/util.ts:502-528`，返回 `ContextOverflowInfo`（interface 在 `285-315`）：`{ isOverflow, window?, requestedTotal?, requestedMessages?, requestedCompletion?, imageCountCap?, imageCountSeen?, message }` —— **没有 `counts` 字段**。计划 `plans:230` 写"同样的返回结构，不新增字段"，`plans:239` 又断言 `.counts?.total` —— 自相矛盾；且 `tsconfig.json` 的 include 含 `tests/**/*.ts`（当前 `npx tsc --noEmit -p tsconfig.json` exit 0），这条测试一旦落盘就是 TS2339。
  - `isMarkerlessOverflowReject`：`src/util.ts:540-542`：

    ```ts
    export function isMarkerlessOverflowReject(status: number, bodyText: string): boolean {
        return (status === 400 || status === 413) && !CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(bodyText));
    }
    ```

    实测 `isMarkerlessOverflowReject(400, "claude-opus-5-5 requires adaptive thinking")` → `true`（计划要求 `false`）。判据是"400/413 且**没有任何**超长 pattern"——这是一个**补集**判定，任何参数错误只要不带 marker 都会被算成"疑似被网关洗掉的超长"。计划说"参数错误有直接原因时直接排除"，但函数签名只有一个 `bodyText`，**拿不到"直接原因"**（结构化 error.type / code）。要在不破坏补集语义的前提下排除，只能新增一个"已知参数错误 pattern"列表并取反，或把函数改成只对 413 生效——两者都会改变 #4452 的日志语义。
  - **影响力**：唯一调用点是 `src/server/relay.ts:1709`，而且只在一个 `log("warn", ...)` 分支里（#4452 的可诊断日志）。改它**不改变任何请求结果**，只改变日志是否打印。

- **影响与建议：** 声称"识别真实超长报错"是有价值的（它决定 `isOverflow` → 是否进入 overflow self-heal），但计划把两件事混在一个任务里：真正影响行为的是 `CONTEXT_OVERFLOW_PATTERNS` + `parseOverflowWindow` + `parseOverflowCounts`；`isMarkerlessOverflowReject` 只是日志。建议：测试断言改为 `window === 1048576` 与 `requestedTotal === 1972866`（现有字段），不要用 `counts`；`isMarkerless` 若要按计划工作，得先定义"已知参数错误"白名单并明确它只影响日志，否则删掉这条断言。

---

### 6. Task 6：可选摘要缓存

- **判定：不属实（必要性未证明，且门槛按现有代码注定为 0）。** 跨请求复用已经实现；这个任务大概率自我取消。

- **证据：**

  - `src/persist.ts:1433`：

    ```ts
    `[persist] ${id} cold-loaded ${...}: ${refs} ref(s), ${blocks} block(s) (${active} active), baseline ...`
    ```

    与事故日志 `13 block(s) (13 active)` 逐字对应 —— 已提交的折叠块在**新进程**里被重新载入，不会被重新摘要。计划 Step 1 的门槛"若已提交块使调用数为 0，则记录'现有增量已满足'"因此会命中：块在 `session.state.blocks` 里，`preflightCompress` 只对未覆盖区间调用 `summarizeRange`。
  - `summarizeRange(deps, content, startRef, endRef, lengthBudget?, systemOverride?)`：`src/preflight.ts:1452-1536`。system 由 `1460-1462` 拼出且**包含 startRef/endRef**，所以 `model + system + content + lengthBudget` 作为键在技术上够用（`summaryPayload` 912 用固定的 `MAX_SUMMARY_OUTPUT_TOKENS = 32768`，`summaryOutputCapFor` 893 按模型已知上限收敛）。
  - 门槛本身可执行（跑一次测试、数调用数），但结论可预判为 0，所以 Task 6 实际上是一次"验证后删除"的空任务。它也不覆盖真正的重复来源：同一区间在**同一轮内**被重切后重复摘要（`pushSpanHalves` 的 halving 路径），那由 Task 3 的 digest 兜底解决。

- **影响与建议：** 保留"先证明再实现"的纪律是对的，但应把它降级为"观察项"，不要写进 File Map 与 Self-Review 的覆盖清单（`plans:333` 声称 Task 3/6 一起处理"增量恢复与必要缓存"，实际增量恢复由 persist 已有能力提供，不是本计划交付的）。若真要防重复，值得缓存的是"同一 `content` 在 halving 后的重复调用"，键应含 `lengthBudget` 与 summary 协议（`summaryPayload` 的 `protocol`），这一点计划没写。

---

### 7. Task 7：测试文件与发布

- **判定：测试文件全部存在（属实）；发布步骤不可执行（不属实）。**

- **证据（逐个核对，10/10 存在）：**

  | 文件 | 存在 | 备注 |
  |---|---|---|
  | `tests/issue2490-ledger-floor-doomed-probe.test.ts` | ✅ | 378 行，9 个 test |
  | `tests/compaction-oversize-fit.test.ts` | ✅ | 19 个 test |
  | `tests/preflight-emergency-fold.test.ts` | ✅ | 7 个 test |
  | `tests/preflight-client-abort.test.ts` | ✅ | 含"已提交折叠在取消后存活"(121) 与"取消后不转发"(158-162) |
  | `tests/preflight-hold.test.ts` | ✅ | 383 行，4 个 test |
  | `tests/issue5630-preflight-fold-unit.test.ts` | ✅ | 9 个 test |
  | `tests/issue3900-overflow-teaches-calibration.test.ts` | ✅ | |
  | `tests/issue1993-preflight-400.test.ts` | ✅ | 与前文 Task 3 冲突 |
  | `tests/preflight-dead-ranges.test.ts` | ✅ | 170 行，`preflightCompress` 单测 |
  | `tests/native-intercept-selfheal.test.ts` | ✅ | 22 个 test |

  **发布步骤的问题：**

  - `scripts/write-build-info.mjs` 用 `git rev-parse --short HEAD` + `git status --porcelain`，**只要工作区有任何未跟踪文件**就写 `${commit}-dirty`。当前 `docs/superpowers/` 就是未跟踪的（`git status` 里的 `?? docs/superpowers/`），而 Task 1/2/3/5 的所有 `git add` 都不含它 → Step 3"确认 build-info 不带 `-dirty`"必然失败。
  - `bili-ops/ROLLBACK.md` **不在仓库里**（仓库根目录没有 `bili-ops/`）；它在 `C:\Users\LIU\Documents\deepseek-harness\default-workspace\bili-ops\`。`plans:298` 已经注明"工作区运维副本"，但 Files 表把它和 `package.json` 并列，执行者会以为它在仓库内。
  - `git remote -v` 只有 `origin`（本地目录 `.../default-workspace/billion-context/.`）与 `atier`（`file://` 本地）。**没有 GitHub remote**，Step 4 的"推送分支和 v1.4.6 tag、创建 GitHub Release"无法按字面执行。版本发布的真实地址是 `https://github.com/puny-code/billion-context/releases/download/v1.4.5/...`（见 ROLLBACK.md），需要先 `git remote add` 并确认 `gh` 已登录。

- **影响与建议：** 把 `docs/superpowers/**` 加进提交（或加进 `.gitignore` 并改 build-info 的判据），Step 4 前置"配置 GitHub remote + `gh auth status`"，Files 表把 `bili-ops/ROLLBACK.md` 标注为仓库外文件。

---

### 8. 既有失败：三个测试文件的归因

- **判定：部分属实（"失败"属实，"与本次改动无关"这个隐含结论也成立，但计划对它们的处置不成立）。**

- **证据（实测，三个文件各自独立 `XDG_STATE_HOME`，串行）：**

  - `tests/preflight-round-budget.test.ts` → `# tests 2 / # pass 0 / # fail 2`

    ```
    not ok 1 - e2e preflight: a payload that needs more folds than one round allows is still brought under the window
      error: 'this payload needs a deeper fold than one round allows, got 5 summary call(s)'
    not ok 2 - e2e preflight: beyond the round budget the fail-fast reports the post-fold state
      expected: 502  actual: 200
    ```

    （断言在 `tests/preflight-round-budget.test.ts:135` `summaries.length > 8`、`:179` `resp.status === 502`。）

  - `tests/issue3918-preflight-progress-verdict.test.ts` → `# tests 2 / # pass 1 / # fail 1`。失败的 1 号用例期望"budget variant"，实际文案是 `… futile round: folding compressible raw messages plus tier distillation (0 summary call(s), net ~0 tokens saved) … — the distillation summary was unavailable.` 即走了 `3583` 的 relaxed/deterministic 分支而不是 `3578` 的 budget 分支。

  - `tests/preflight-target-stability.test.ts` → `# tests 9 / # pass 8 / # fail 1`，失败项 `summary target stability during batch-unchanged`。

  **与工作区改动无关的证据：**

  - `git diff --stat` 只动了 `src/server.ts` 与 `tests/issue2490-…`。
  - 三个测试都**没有 seed `lastInputTokens`**（grep `lastInputTokens` 在两个 server-importing 文件里零命中），首个请求时 `lastInputTokens = 0` → `probeForEvidence` 恒为 false（`src/server.ts:3586` 要求 `> 0`）→ 工作区新增的 `unfoldedDoomed` 分支根本不执行。
  - `tests/preflight-target-stability.test.ts` 只 import `../src/preflight.ts`（`1-13` 行），**完全不 import `server.ts`**，结构上不可能受该 diff 影响。

  **真实根因**：已提交的 `#5630`（HEAD）把碎片合并成 fold-sized units，每折变大 → 相同 fixture 下摘要调用数从 >8 掉到 5，原本"折不完"的 payload 现在折完并转发（502 → 200），文案也从 budget 变成 distillation。

- **影响与建议：** 计划 `plans:313` 说"已知既有失败单独列出，不混入本次通过统计"，`plans:337` 又说"既有失败文件不得通过简单放宽断言转绿；若断言已被 Task 1/3 的新行为合法改变，必须单独说明"。这两句放在一起，执行者无法判断"到底要不要修"。**这三个文件是 preflight 行为的 pin，Task 1/3 会继续改变同样这三条行为**，因此必须在本计划内更新，并写明新语义（例如 round-budget 的 `>8` 改成 `>3`、502 断言改成"要么 200 且真的转发、要么 502 且 retryable=true"）。否则 Task 7 的"全部测试通过"永远达不成，"完成声明"就会变成空话。

---

### 9. 目标覆盖：是否真的消除可预防的拒绝

- **判定：不属实。** Task 1 消掉的是"**折叠前**的 413"（本次事故的直接死因，价值很高），但计划没有任何一步消掉"**折叠后**的 413/502"，而后者在事故量级下才是常态终局。

- **证据：**

  - `src/server.ts:4108` 的终局仍返回 413 或 502；`4123` 的 `retryable` 对 deterministic exhaustion 是 `false`。
  - `3578-3579` 的 `budgetHit` 返回 `{kind:"exhausted"}`（`deterministic` 未置位）→ `4108` 走 **502**，`progressContinues`（`4115`）为 true 时 `retryable: true`。这算"可续压"，但对客户端仍是一次**失败的请求**；而每轮 32 次上游摘要、每次 30-60s，用户要连续吃 2-3 次 502 才能收敛。
  - `3583` 的 `relaxed && compressedRanges > 0` 在 `lastUnusableDetail === undefined` 时置 `deterministic: true` → `4108` 直接 **413 retryable:false** —— 这是"已经折完所有可折区间仍超窗"的硬拒绝，计划完全没有触及。
  - `src/server/relay.ts:752-775` 的 egress fuse 是第二道 413，同样没有触及。
  - Task 3 的 digest 回退只在 `entryOvershoot > 19.2`（`src/preflight.ts:2033`）时启用，事故是 2.25× → 走不到。
  - 计划 `plans:334` 自我声明"不承诺对不可缩小的系统/工具/当前任务也能成功"——这个边界合理，但**事故恰恰是可缩小的**（1.97M 的历史，13 块已证明可折），所以用这条免责挡不住"仍然拒绝"的批评。

- **更符合目标的改法（按性价比排序）：**

  1. **把 `budgetHit` 变成降级点而不是终局**：`3578` 之后若 `budgetHit && currentTokens >= limit`，对剩余区间调用 `deterministicDigest`（每折可覆盖 ~0.6×window，`EMERGENCY_ROUND_CAP=512` 足够），再走 `commitFold`；一次请求内收敛，不需要第二轮 502。
  2. **把 `3583` 的 deterministic 413 改成"返回已折叠 + `retryable: true` + 续压提示"**：只有当 `compressedRanges === 0`（真的一点都折不动）时才允许 413。
  3. **给 post-fold 裁决一个统一不变量**：`if (!result.fitsWindow && result.compressedRanges > 0) → 不 413`（要么续压，要么 502 retryable）。
  4. **加墙钟预算 + 进度落盘**：每折提交后写 `session.state`，超过 `BILI_PREFLIGHT_WALL_MS`（例如 120s）就带着"已折叠 N 块、还差 M tok"返回可续压结果，而不是让用户等 30 分钟。
  5. 这三条做完，`unfoldedDoomed` 才有意义（它应当表达"这一轮无论如何不能转发原始报文"，而不是"我记了一笔"）。

---

### 10. 可执行性

- **判定：部分属实。** 命令和文件路径大多真实，但 4 个 Task 的"失败测试"是伪代码或与 fixture 不符，1 个 Task 的锚点文件错误，发布步骤缺前置条件。

- **证据：**

  - `plans:53-54`（Task 1 Step 1）：

    ```ts
    assert.ok(summaries.length > 0, "must attempt folding before refusal");
    assert.equal(calls.filter((c) => c.raw.includes('"stream":true')).length, 0);
    ```

    两条都不成立：该 fixture（`tests/issue2490-…:283-304`，`bigMessages(500,4400)` ≈ 2.2MB vs `WINDOW = 20_000`，约 27.5× > `EMERGENCY_FOLD_COVERAGE` 19.2）走的是 deterministic digest，`calls.length === 1`（seed turn），**摘要调用恒为 0**；而 seed 请求本身由 `post()`（`149-154`）发出，body 里就有 `"stream":true`，所以第二条断言**现在就是 1 不是 0**。
  - `plans:108-109`（Task 2）：`assert.ok(outputBudget > 1); assert.equal(retryCount, 1);` —— `outputBudget` / `retryCount` 在任何测试里都不存在，也没有 fixture、没有文件名、没有 wire 说明。这不是"真实代码"。
  - `plans:156-157`（Task 3）：`result.compressedRanges` / `session.state.blocks` 同样没有 fixture 与调用方式；`preflightCompress` 的签名需要 `deps`、`ctx`、`signal`，计划没给。
  - `plans:187`（Task 4）：`src/server/handle.ts:2564-2619` 是 fail-fast 写出，不是保活入口（见第 4 条）。
  - `plans:239`（Task 5）：`.counts?.total` 编译不过（见第 5 条）。
  - `plans:276`（Task 6）：门槛可执行，但结论可预判为 0。
  - **顺序依赖**：Task 1 与 Task 2 无依赖（不同车道）；Task 3 应当**排在 Task 1 之后**——否则事故形态下 pre-fold 413 仍然先发生，T3 的降级路径永远看不到；Task 6 依赖 Task 3 的最终形态；Task 7 必须最后。计划没有写这些依赖。
  - **回滚**：只有 Task 7 的版本回滚（ROLLBACK.md），没有任何 per-task 的 `git revert <sha>` 说明。每个 Task 都是独立 commit（这点写得好），建议在 Task 末尾加一句"若验证失败：`git revert --no-edit <sha>`"。
  - **缺失的测试**：没有一条端到端测试覆盖"1.97M 的消息量 + 786K 窗口"这个形态（现有 fixture 最大 400×200 行、几十万 token）；没有一条测试检查 `relay.ts` 的 egress fuse；没有一条测试覆盖 `budgetHit` 后的行为。

---

## 阻断性问题（必须修）

1. **Task 2 的技术前提是错的，必须重写。**
   `planCompactionFit(raw, declaredWindow, targetTokens?)` 的第三个参数是输入上限（`src/agent/compaction-fit.ts:307-313`），不是输出预算；该模块只 splice `messages`/`input`（`22-25`），全仓没有"把 max_tokens 裁剪成 1"的代码——唯一的 `max_tokens=1` 是 cache-keepalive 的空闲 ping（`src/cache-keepalive.ts:5`），压缩车道 `native-intercept.ts` 里 grep 三个字段零命中。
   **改法**：Task 2 只保留"完成原因检查"这一半——在 `src/agent/native-intercept.ts:1219` 的 `status < 400` 分支里先 `const probe = response.clone()`，按三种 wire（anthropic `stop_reason=max_tokens` / openai `finish_reason=length` / responses `incomplete_details.reason=max_output_tokens`）判定；命中则走 `refitCompactionBody(original, plan, smallerTarget)` 的有界重试（`COMPACTION_FIT_RETRY_LIMIT=2`）。"提高输出预算"要么明确写"改写 `max_tokens` 字段并放弃 byte-identical 契约"，要么删掉。

2. **Task 1 的失败测试断言与 fixture 不可能同时成立，必须换 fixture 或换断言。**
   `plans:53` 的 `summaries.length > 0` 在 `tests/issue2490-…:283-304` 上恒为假（digest 形态，0 次摘要）；`plans:54` 的 `"stream":true` 计数恒为 1（seed 请求就是 stream）。
   **改法**：新写一个"超字节阈值但 overshoot < 19.2×"的 fixture（例如 ~3× window、文本总量 > 2MB 但可折区间充足），断言 `session.state.blocks.length` 增加、`calls.length`（非 seed）≥ 1、且响应不是 413；或者断言 `deterministicDigest` 产物出现在下一次转发的 body 里（`collapsed` / `ref(s) folded` 标记）。"不转发未折叠报文"的断言要落在**上游是否收到原始 FILLER 文本**上，而不是字节数。

3. **Task 5 的 `counts` 字段不存在，断言必然 TS2339；`isMarkerlessOverflowReject` 的设想不可行。**
   `ContextOverflowInfo`（`src/util.ts:285-315`）没有 `counts`；`plans:230` 自己写"不新增字段"。
   **改法**：断言改为 `inspectContextOverflow(400, counts).window === 1048576` 与 `.requestedTotal === 1972866`（现有字段，且需要同时补 `parseOverflowWindow` 与 `parseOverflowCounts` 的 `model limit N tokens, requested M tokens` 正则）。`isMarkerless` 要么删掉这条断言，要么改成"已知参数错误白名单"并注明它只影响 #4452 的日志（`src/server/relay.ts:1709`），不改变请求结果。

4. **计划没有消除事故形态下的终局拒绝，"目标覆盖"不成立。**
   Task 1 之后，1.97M/786K 的会话会走完 32 轮摘要，然后落到 `src/server.ts:4108`：`budgetHit` → 502（`retryable: true`，但仍是失败请求），`relaxed && compressedRanges > 0` → 413 `retryable: false`（`3583` + `4108`）。Task 3 的 digest 只在 19.2× 以上启用，事故是 2.25×，覆盖不到。
   **改法**：在 `src/preflight.ts:3578` 的 `budgetHit` 分支后增加"剩余区间 deterministicDigest 降级"（复用 `commitFold`，`EMERGENCY_ROUND_CAP=512` 足够），并把 `3583` 的 deterministic 413 收窄到 `compressedRanges === 0`；再加一条端到端测试：给定 1.97M/786K 形态，断言**单次请求内** `result.fitsWindow === true` 且响应 200。

5. **Task 3 与 `tests/issue1993-preflight-400.test.ts` 的 pinned 语义直接冲突，计划没有裁决。**
   `issue1993:156-214` 断言"系统性硬 400 → 502 + retryable:false + 两次一致 + 不转发 + 摘要调用 2..16 次"；digest 回退会把它变成 200 / 0 次调用。计划把 issue1993 放进 Task 5 与 Task 7 的"必须通过"清单（`plans:225`、`258`），却把它的改动排除在 Task 3 之外。
   **改法**：明确二选一——(a) 保留 issue1993 的终局（硬 400 仍 502），digest 只对"超时 / 空摘要 / 5xx / transport"生效，不覆盖 4xx；(b) 接受行为变更，把 issue1993 的断言改成新的 200 语义并写明理由。推荐 (a)：400 是"请求本身不被接受"，用 digest 硬折会把一个签名问题伪装成成功。

---

## 建议修订（不阻断）

1. Task 1 保留 `noteLocalRefusal(session, currentOrigin, model, limit)` —— 工作区 diff 删掉了它，等于放弃 #3846 的本地拒绝记录；应改成"记录 + 继续折叠"。
2. Task 1 的 Modify 区间从 `3586-3630` 改成 `3586-3634`：决定行为的 `} else if (!unfoldedDoomed)` 在 3632，按现区间改的人会漏掉它。
3. 让 `unfoldedDoomed` 参与裁决，而不是只写日志；同时把 `src/server/relay.ts:752-775` 的 egress fuse 纳入 Task 1 的验证范围（至少加一条测试证明"fold 后仍会被 egress fuse 拦"是预期行为）。
4. Task 4 删掉 `src/server/handle.ts:2564-2619` 这个锚点；改为"在 `src/server.ts:3783-3786` 的 hold 安装点附近补一个全局墙钟参数（复用现有 knob 体系，不新增配置项可先用常量），超时后停止折叠并返回可续压结果"。
5. Task 6 降级为"观察项"，从 File Map 与 Self-Review 的覆盖声明里移除；若保留，键里补 `protocol`。
6. Task 7 增加前置步骤：`git remote add github https://github.com/puny-code/billion-context.git` + `gh auth status`；提交时把 `docs/superpowers/**` 一并 `git add`（否则 `scripts/write-build-info.mjs` 必写 `-dirty`）；Files 表注明 `bili-ops/ROLLBACK.md` 在仓库外。
7. 三个既有失败文件纳入 Task 3 的改动清单，并写明新语义（不要只写"单独列出"）。
8. Task 2 的 `readCompletionLimitReason` 明确"只读 clone、读到流尾、按三协议解析"，并给出"命中后重试一次"的上限（现有 `COMPACTION_FIT_RETRY_LIMIT=2` 可直接复用）。
9. 每个 Task 末尾加回滚命令（`git revert --no-edit <sha>`），并在 Task 7 明确"若 v1.4.6 装坏，回退到 v1.4.5 的 tgz"。

---

## 计划遗漏

1. **没有任何"折叠收益"度量**。事故的关键不是"折没折"，而是"每折省多少 vs 缺口多大"：13 折只省 201,699 tok（1,973,434 → 1,771,735），折叠后仍超窗约 985K tok（窗口按 786,432 计）。计划没有一处计算 `savedTokens / rounds`，也没有"若连续 N 轮净收益 < X 就切 digest"的判据。`src/preflight.ts:3601` 已有 `result.savedTokens = Math.max(0, startTokens - currentTokens)`，可直接用。
2. **没有全局墙钟 / 轮次预算**。只有 per-chunk 1200ms（`src/preflight.ts:101-126`）与每轮摘要数上限；32 轮 × 30-60s 可以跑过 30 分钟。`bili-ops/ROLLBACK.md` 里 v1.4.4 的"仍会压五分钟然后 413"说明这个问题已经发生过一次。
3. **egress fuse 未覆盖**（`src/server/relay.ts:752-775`）。它是与 pre-fold 完全独立的第二道 413，计划通篇未提。
4. **`budgetHit` 分支没有降级**（`src/preflight.ts:3578`），而这是事故形态最可能命中的终局。
5. **`retryable` 语义与文案矛盾**：`src/server.ts:4123` 对 deterministic exhaustion 返回 false，但 `4125-4127` 的文案又说"next attempt starts from a smaller baseline"。计划没有修这个矛盾。
6. **客户端断线的真因没有诊断**。保活在 v1.4.4 就存在（`git show v1.4.4:src/server.ts` 命中 `beginPreflightHold`），00:57 仍然断开，说明断线可能来自客户端/宿主侧超时或进程重启，而不是 HTTP 保活缺口。Task 4 只"验证"，没有要求查 `bili.log` 与 DSH 会话日志里的断线时间点。
7. **没有"折不动"的用户可见出口**。当 `compressedRanges === 0`（真的只剩 system/tools/当前任务）时，计划没有定义应该给用户什么（现在的 413 文案是"Remove or trim the oversized content"，可以保留，但要有测试 pin 住它只在真的不可折时出现）。
8. **spec 与 plan 的事实边界不一致**：spec 已经记载"13 block(s) (13 active) 冷加载"这一事实，plan 的 Task 6 却把"是否存在重复摘要"当成未知；建议先跑一次 Task 6 Step 1，用结果决定是否保留该任务。

---

## 实测记录

所有测试串行执行，每个文件使用独立的 `XDG_STATE_HOME`（`$env:TEMP` 下新建的 GUID 目录）。工作区未做任何修改（`git status` 仍为 `M src/server.ts`、`M tests/issue2490-ledger-floor-doomed-probe.test.ts`、`?? docs/superpowers/`）。

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | exit 0（当前工作区类型干净） |
| `node --import tsx --test tests/preflight-round-budget.test.ts` | **2 tests / 0 pass / 2 fail**：`got 5 summary call(s)`（期望 >8）；`expected 502, actual 200` |
| `node --import tsx --test tests/issue3918-preflight-progress-verdict.test.ts` | **2 tests / 1 pass / 1 fail**：文案是 `the distillation summary was unavailable`，不是期望的 budget variant |
| `node --import tsx --test tests/preflight-target-stability.test.ts` | **9 tests / 8 pass / 1 fail**：`summary target stability during batch-unchanged` |
| `node --import tsx --test tests/issue2490-ledger-floor-doomed-probe.test.ts` | 9 tests / 9 pass（未提交改动的放宽版断言通过） |
| `node --import tsx --test tests/compaction-oversize-fit.test.ts` | 19 tests / 19 pass |
| `node --import tsx --test tests/preflight-emergency-fold.test.ts` | 7 tests / 7 pass |
| `node --import tsx --test tests/preflight-hold.test.ts` | 4 tests / 4 pass |
| `node --import tsx --test tests/issue5630-preflight-fold-unit.test.ts` | 9 tests / 9 pass |
| `node --import tsx --test tests/native-intercept-selfheal.test.ts` | 22 tests / 22 pass |
| `node --import tsx --test tests/context-overflow.test.ts tests/issue4452-markerless-reject.test.ts` | 44 tests / 44 pass / 0 skipped |
| `node --import tsx -e "…inspectContextOverflow…"` | `'Input too long: input exceeds the context limit'` → `isOverflow:false`；`'model limit 1048576 tokens, requested 1972866 tokens'` → `isOverflow:false`，加 marker 后仍 `window: undefined`；`isMarkerlessOverflowReject(400,'claude-opus-5-5 requires adaptive thinking')` → `true`；`'counts' in info` → `false` |
| `git show v1.4.4:src/server.ts \| Select-String beginPreflightHold` | 命中（v1.4.4 已带保活） |
| `git remote -v` | 仅 `origin`（本地目录）与 `atier`（`file://`），无 GitHub remote |

**未运行**：真实的 1.97M/786K 事故会话回放（需要事故会话数据，按硬性约束不打开 bili 数据库，也不重启 DSH）。

---

# 修订方案 v2（执行版）

本节把审阅暴露的五个阻断问题、九条建议与八项遗漏，重写成一份可直接执行的计划。**以本节为准，原 `2026-11-07-overflow-degradation.md` 的 Task 2 / Task 4 / Task 6 作废。**

## 0. 用户决策与三条不变量

用户 2026-11-07 的两项决策：

- **refusal_policy = 继续降级处理**：继续截断超大工具结果/可省略内容，保留最近任务；仍无法保证时不主动重试原始超大请求。
- **history_loss = 摘要优先，必要时确定性裁剪**：优先模型摘要，失败/超时用本地摘要并保留关键决策，原文仍在 bili 库可检索恢复。

由此得出三条不变量。**所有改动都必须在测试里 pin 住这三条**：

| 编号 | 内容 | 落点 |
|---|---|---|
| **I1** | 折动过就不拒绝：`compressedRanges > 0` 时不得返回 `retryable:false` 的 413 | `src/server.ts:4108-4123` |
| **I2** | 折尽了才判死：只有 `compressedRanges === 0` 或 `rangesRemaining === 0` 时，才允许结构性 413 | 同上 |
| **I3** | 单请求有墙钟：折叠总时长上限 120s，超时走降级车道而不是失败 | `src/preflight.ts:2268` 轮循环 |

### 0.1 终局判定表（改造后必须逐格成立）

| compressedRanges | rangesRemaining | payloadFitsWindow | status | retryable | 语义 |
|---|---|---|---|---|---|
| 0 | any | false | **413** | false | 真的一格都折不动，唯一诚实的判死 |
| >0 | >0 | false | **502** | **true** | 还有可折的头寸，下一次重试从更小基线继续 |
| >0 | 0 | false | **413** | false | 折尽了仍放不下 |
| any | any | true | — | — | 不进入 fail-fast，正常转发 |

现有代码只有第 1、4 行成立；第 2 行现在被写成 413/`retryable:false`（#3918 已经为它开了一半口子，`progressContinues` 要求 `!f.deterministic`，把 deterministic 的 exhausted 又推回 413），第 3 行没有区分（`rangesRemaining` 根本没参与 `status` 的判定）。

## 1. 变更总览

| 新 Task | 原 Task | 动作 | 主要文件 |
|---|---|---|---|
| T1 | 1 | 删掉死变量，pre-fold 语义定稿 | `src/server.ts` |
| T2 | 3（前置） | 把 `entries` 构造从 emergency 闸门里解耦，抽成可复用 helper | `src/preflight.ts` |
| T3 | 3 | `budgetHit` / `relaxed` / 轮次上限 → 一次确定性 digest 清扫 | `src/preflight.ts` |
| T4 | 3 | digest 清扫的预算、终止与幂等保证 | `src/preflight.ts` |
| T5 | 1 | 终局裁决改为不变量的单一函数 + egress fuse 对齐 | `src/server.ts`、`src/server/relay.ts`（只测） |
| T6 | 4 | 全局墙钟 120s，超时复用降级路径 | `src/preflight.ts` |
| T7 | 5 + 2 | 超长文案识别（真问题）＋ 原生压缩完成原因（降级为只做检查） | `src/util.ts`、`src/agent/native-intercept.ts` |
| T8 | 7 | 测试与发布（含三个既有失败文件重基线、build-info 脏标记、GitHub remote） | `tests/*`、`.gitignore`、发布脚本 |

依赖：T2 → T3 → T4 → T6（都在 `preflight.ts` 内，顺序不能反）；T1、T5 独立；T7 独立；T8 最后。

## 2. Task 明细

### T1 — pre-fold 语义定稿（去掉死变量）

**目标**：pre-fold 字节闸只负责"记录警告"，不再决定拒绝；拒绝只在折叠之后由 T5 统一裁决。

**锚点**：`src/server.ts:3586-3632`（工作区已改，但 `unfoldedDoomed` 写完没人读）。

**事实**：`unfoldedDoomed` 在 3587 声明、3626 赋值、3632 读取，**唯一用途是跳过 forward-once 分支**。它不参与任何终局裁决，改个名字也还是同一个东西；真正让 pre-fold 不再 413 的是"把那个 `return { failFast: true, status: 413 }` 删掉"这件事本身。

**步骤**：

1. 删掉 `let unfoldedDoomed = false;`（3587）与 `unfoldedDoomed = true;`（3626），把 3632 的 `} else if (!unfoldedDoomed) {` 改回 `} else {`。
   理由：pre-fold 既然不拒绝，就没有"已判死所以不要 forward-once"这个状态；保留一个永远为 false 的变量只会让下一个读代码的人误以为存在裁决。
2. 保留 3620 附近的 `log("warn", ...)`，文案改成明确的两段式：
   `payload core text ~${coreTextBytes} bytes exceeds both doom bars — NOT refusing here; folding first, the post-fold verdict decides (I1/I2)`。
3. **`noteLocalRefusal` 保持删除**，但在 3621 补一行注释说明为什么：
   `pre-fold no longer refuses, so there is nothing to record here; the terminal 413 at the end of this function still calls noteLocalRefusal (#3846 preserved).`
   验收依据：`src/server.ts:4119` 仍在 `status === 413` 时调用 `noteLocalRefusal`，`localRefusalCovers` 的语义没有被削弱——它现在只由**真实发生过的**终局 413 写入，而不是由"预判"。这比原来更强，不是更弱。
4. 不要碰 `src/server.ts:3552`（窗口未知直接转发）：那条路径本来就是"不拒绝"，符合目标。
5. 不要碰"0 可折叠区间时提前 `return prepared`"的分支：同理。但 T4 完成后要复检——如果 digest 清扫已经把 `rangesRemaining` 打到 0，这条分支不应该再被走到。

**验收**：

- `tests/issue2490-ledger-floor-doomed-probe.test.ts` 的 b 用例改为断言"日志里有 `folding first`、且**没有** `preflight fail-fast 413`"。**不要**用 `summaries.length > 0`（该 fixture 是 27.5× overshoot，走 digest，摘要调用恒 0，见审阅 §1）。
- `grep -n unfoldedDoomed src/server.ts` 返回空。

**风险**：低。行为变化只有"以前立刻 413 的请求现在会先折叠"，最坏是多花一次折叠时间，而 T6 的墙钟兜住。

---

### T2 — 把 digest 的 `entries` 构造解耦（T3 的前置）

**目标**：让"给定一个 range，算出 digest 摘要"成为可复用函数，供批量 digest 路径与新的清扫路径共用。

**锚点**：

- `src/preflight.ts:1750-1754` `interface DigestEntry { ref; label; text }`
- `src/preflight.ts:2962-2999` 批量路径里现成的 entries 构造（含 nested block 展开）
- `src/preflight.ts:3279-3300` 单区间路径，`if (emergencyFold) entries.push(...)` —— **这就是事故走不到的闸门**
- `src/preflight.ts:3408-3420`（approx）`if (emergencyFold)` 分支调用 `deterministicDigest`

**为什么必须改**：`entries` 只在 `emergencyFold`（`entryOvershoot > 19.2`，`src/preflight.ts:2033`）时收集。事故是 2.25×，永远走不到；直接调用 `deterministicDigest([])` 会得到 `0 message(s)` 的空壳摘要，等于把内容删了。

**步骤**：

1. 在 `deterministicDigest` 附近新增：

```ts
interface DigestPlan {
    summary: string;
    directMessageIds: readonly string[];
    effectiveMessageIds: readonly string[];
    targetKey: string;
}

/**
 * Build the digest input for ONE range from the CURRENT view and return the
 * finished summary. Used by the batch digest path and by the budget-hit
 * sweep, so both agree byte-for-byte on what a deterministic fold of a given
 * span contains (#2383 semantics preserved).
 */
function digestForRange(range: { startRef: string; endRef: string }): DigestPlan | undefined
```

2. 实现直接搬 `2962-2999`：`applyCompression` 用占位摘要（`"x".repeat(max(MIN_SUMMARY_CHARS, minSummaryLength))`，与 2743 同款）→ 找新 block → 从 `block.directMessageIds` 构建 entries → 从 `block.directBlockIds` 补 nested 摘要 → `deterministicDigest(entries, startRef, endRef, { maxSummary, minSummaryLength, shrinkBound: max(minSummaryLength, floor(spanUnits / NET_SHRINK_TOLERANCE)), countText })`。
3. 把 `3279-3300` 的单区间路径改成调用它（`emergencyFold` 时），把 `2962-2999` 的批量路径也改成调用它。**这一步是纯重构，必须零行为变化**：先跑 `tests/preflight-emergency-fold.test.ts`（7 项）与 `tests/issue2383*`（若存在）确认全绿，再进 T3。
4. `shrinkBound` 用 `spanUnits = block.compressedTokens`（baselineKnown）否则 `charMass`，与 2993 一致。

**验收**：`tests/preflight-emergency-fold.test.ts` 7/7；`tests/preflight-dead-ranges.test.ts` 全绿；`npx tsc --noEmit` exit 0。

**风险**：中。这是纯重构但动的是折叠核心，必须先绿再往上叠。

---

### T3 — `budgetHit` / `relaxed` 变成降级点（主收敛手段）

**目标**：摘要预算耗尽、轮次用尽、可折区间折尽——这三种"预压缩走不下去"的情形，一律先用**零上游调用**的确定性 digest 把还能折的区间折掉，再一次请求内收敛。

**锚点**：

- `src/preflight.ts:1955` `let budgetHit = false;`
- `src/preflight.ts:3357` `budgetHit = true;`（摘要预算耗尽处）
- `src/preflight.ts:3569-3597` 终局 verdict 分支
- `src/preflight.ts:3580-3583` `relaxed && result.compressedRanges > 0`
- `src/preflight.ts:159` `NET_SHRINK_TOLERANCE = 1.05`（digest 输出 ≤ span 的 95%，不设"必须缩多少"的下限，所以能一步缩到 `maxSummaryLength`）
- `src/config.ts:27` `maxSummaryLength: 20000`（默认 20k 字符 ≈ 5k token，对 47 万 token 的 unit 是 ~99% 的净压缩）

**为什么这条能收敛而 v1.4.5 不能**：事故的 505 个碎片合并后是 3 个 unit（cap = 0.6 × 786432 ≈ 472k tok）。每个 unit 折一次 → ≤5k tok，三次就把 1.1M 的缺口抹平，且**不产生任何上游调用**。原计划的 `maxFoldsPerRound = 1` + 轮次上限是"用 LLM 摘要一点点啃"，本质上啃不完。

**步骤**：

1. 在 `preflightCompress` 内、`3569` 之前插入清扫调用（作用域里 `ranges` 是本轮 coalesce 后的 unit 列表，`skipSet` 记录已失败的 key）：

```ts
// #XXXX (new): a walk that ran out of budget/rounds/headroom is not a
// terminal verdict while a zero-call deterministic digest can still fold.
// Every unit here is CPU-only and idempotent, so this cannot spend the
// relay's patience or produce a different answer on retry.
const sweep = (currentTokens >= limit && (!failure || failure.kind === "exhausted"))
    ? digestSweep()
    : { folded: 0, saved: 0 };
if (sweep.folded > 0) {
    deps.log("info", `[preflight] budget-hit digest sweep folded ${sweep.folded} unit(s), net ~${sweep.saved} tok — payload now ~${Math.round(result.payloadEstimate)} tok vs window ${limit}`);
}
```

2. `digestSweep()` 与常量一起放在函数外（便于单测），签名：

```ts
const DIGEST_SWEEP_MAX_UNITS = 8;

function digestSweep(args: {
    ranges: readonly FoldRange[];
    currentTokens: number;
    limit: number;
    digest: (range: FoldRange) => DigestPlan | undefined;
    commit: (plan: DigestPlan, range: FoldRange) => number;   // 返回本块净收益
}): { folded: number; saved: number; tokens: number }
```

实现：按 `tokens` 降序，最多 `DIGEST_SWEEP_MAX_UNITS` 块；每块 `digest()` → `commit()`；`tokens <= limit` 立即停；单块净收益 `<= 0` 记一次空转，连续 2 次空转就停（防止"折了但没变小"的死循环）。

3. **不要**把 `emergencyFold` 的判定改掉。它仍然控制"整条链路从一开始就走 digest"，那是对 19.2× 以上payload 的保护；新 sweep 只是给普通路径补一个**兜底**。两者可以同时存在，互不干扰。
4. 与 `issue1993` 的冲突按这条化解：`failure.kind === "upstream" && failure.status < 500` 时**不跑** sweep（保留"硬 400 → 502 + retryable:false"的 pinned 语义）。只有 `exhausted`（预算/轮次/无头寸）才降级。
5. 清扫后**必须更新** `result.compressedRanges` / `result.savedTokens` / `result.payloadEstimate`，否则 T5 的判定读到旧值。`currentTokens` 由 `commit()` 的返回值串起来。

**验收**（新文件 `tests/preflight-budget-hit-digest-sweep.test.ts`）：

1. 构造 payload：`limit = 20000`，payload ≈ 60000 tok（3×），`maxSummaryLength` 默认，摘要调用全部返回 usable 但只缩 5%（迫使 `budgetHit`）→ 断言 `fitsWindow === true`、`compressedRanges > 0`、`result.failure === undefined`、上游摘要调用次数 ≤ 原有预算（不新增）。
2. 同上但把 digest 的 `maxSummary` 设成 0（unbounded）→ 断言仍收敛（防止有人把 `maxSummaryLength` 当必要条件）。
3. `failure.kind === "upstream" && status === 400` 时 sweep 不跑：断言 `summaries.length` 与改造前一致、`status` 映射不变。
4. 清扫幂等：同一输入跑两次，`compressedRanges` 第二次为 0，且第二次不向上游发任何请求。

**风险**：中高。这是行为改变最大的一条。防线是"只在 exhausted 时触发"+"单块净收益 ≤0 就停"+"最多 8 块"。

---

### T4 — digest 清扫的终止保证

**目标**：证明清扫一定停，且不会把 payload 折成"全是摘要没有内容"。

**步骤**：

1. 三个硬上限：`DIGEST_SWEEP_MAX_UNITS = 8`、单块 `maxSummaryLength`、连续 2 次零收益即停。
2. 清扫**只折 `ranges` 里已有的 unit**，不递归折刚生成的 block。这样 8 块就是 8 块，不构成嵌套放大。
3. 每次 `commit()` 后 `deps.signal?.aborted` 检查，中止就停（客户端断开优先于一切）。
4. 摘要必须保留可检索线索：`deterministicDigest` 已经在头部写 `[deterministic digest startRef:endRef] N message(s)`，且 `entries` 的 label 会聚合成 `Structure: 178×bash` 这类统计行（见 `1766-1774`）。**不要**为了压得更小而砍掉这行——它是 `search_context` 能定位到原文的唯一线索。

**验收**：在 T3 的测试 1 里追加断言：摘要文本里含 `[deterministic digest ` 前缀、含 `message(s)`、长度 ≤ `maxSummaryLength`。

**风险**：低。

---

### T5 — 终局裁决改成不变量的单一函数

**目标**：把 §0.1 的判定表写成一个有名字、有单测的函数，让"折动过却返回 413"在类型/测试层面不可能出现。

**锚点**：

- `src/server.ts:4108` `const status = f?.kind === "upstream" && f.status === 429 ? 503 : f?.kind === "exhausted" && f.deterministic && !payloadFitsWindow ? 413 : 502;`
- `src/server.ts:4115` `const progressContinues = f?.kind === "exhausted" && !f.deterministic && result.compressedRanges > 0;`
- `src/server.ts:4123` `const retryable = progressContinues ? true : ...`
- `src/server/relay.ts:764-772` egress window fuse（第二道 413）

**步骤**：

1. 新增纯函数（放 `src/server.ts` 顶部或 `src/upstream-fail.ts`，便于单测）：

```ts
export interface TerminalInput {
    compressedRanges: number;
    rangesRemaining: number;
    payloadFitsWindow: boolean;
    failure?: { kind: string; status?: number; deterministic?: boolean };
}

/** I1/I2 in one place: a payload this walk actually shrank is never answered
 *  with a non-retryable 413 unless nothing foldable is left. */
export function terminalStatus(input: TerminalInput): { status: 413 | 502 | 503; retryable: boolean } {
    const f = input.failure;
    if (f?.kind === "upstream" && f.status === 429) return { status: 503, retryable: true };
    const exhausted = f?.kind === "exhausted";
    const nothingFolded = input.compressedRanges === 0;
    const nothingLeft = input.rangesRemaining === 0;
    if (exhausted && f?.deterministic && !input.payloadFitsWindow && (nothingFolded || nothingLeft)) {
        return { status: 413, retryable: false };
    }
    const progressContinues = exhausted && !nothingFolded;
    return { status: 502, retryable: progressContinues ? true : (f?.status !== undefined && f.status >= 500) };
}
```

2. 4108-4123 改为调用它，保留原有的两条注释（#3461 / #3918），把判定逻辑的注释搬到函数上。
3. **保留** `if (status === 413) noteLocalRefusal(...)`（4119）。
4. egress fuse（`relay.ts:764`）：**不改代码**，加一条测试断言它在"折叠后仍超 2MB 但已 fit window"时不再触发。fuse 用的是 `estimateCoreMessagesUpperBytes(fuseMsgs)` 与 `max(DOOMED_PROBE_ABSOLUTE_BYTES, fuseWindow * 7.5)`；只要 T3 把 core text 压到 2MB 以下，它自然不响。若测试证明它仍会响，则把它的输入从 `prepared.processedMessages` 改成"已折叠的 outbound 视图"，并在同一条 PR 里注明。

**验收**：

- 新文件 `tests/preflight-terminal-status.test.ts`，把 §0.1 的四行判定表逐格 pin 成用例（4-6 个）。
- 复用 `tests/issue3918-preflight-progress-verdict.test.ts` 的 fixture 验证：`compressedRanges > 0 && rangesRemaining > 0` → 502 + `retryable === true`。

**风险**：中。`retryable` 的语义被放宽会让某些宿主更积极地重试；用"必须有可折头寸"兜底，重试才有意义。

---

### T6 — 全局墙钟 120s

**目标**：预压缩总时长不超过 120s，超时进入 T3 的降级车道，而不是让主机等 300s 后 idle timeout。

**锚点**：`src/preflight.ts:2268` `for (let round = 0; round < effectiveRoundCap; round++) {`；现有只有 `BILI_PREFLIGHT_FOLD_CHUNK_MS` 的**每块**预算（`src/preflight.ts:123`，默认 1200ms），没有全局量。

**步骤**：

1. 常量：

```ts
// A preflight walk that outlives the host's patience is worse than a
// shallower fold: the client drops the connection and the work is lost.
// 120s leaves margin under the ~300s stream idle timeout observed live.
const PREFLIGHT_WALL_BUDGET_MS = 120_000;
```

2. 轮循环外 `const wallStart = Date.now();`；循环内每轮开头：

```ts
if (Date.now() - wallStart > PREFLIGHT_WALL_BUDGET_MS) {
    deps.log("warn", `[preflight] wall budget ${PREFLIGHT_WALL_BUDGET_MS}ms exhausted after ${round} round(s)/${result.compressedRanges} fold(s) — handing the remainder to the deterministic digest sweep`);
    budgetHit = true;
    break;
}
```

3. `budgetHit = true` 是关键：它让 3578 的分支自然落到 T3 的 sweep，**不需要新的状态变量**。这也是选择复用它而不是新加 `wallHit` 的原因。
4. `PREFLIGHT_WALL_BUDGET_MS` 允许 `BILI_PREFLIGHT_WALL_MS` 覆盖（测试要把它设成 1 来强制走这条路径），但**不写进**面向用户的配置文件。

**验收**：新文件 `tests/preflight-wall-clock.test.ts`：两个用例——(a) 把墙钟设 1ms + 摘要每次 sleep 50ms → 断言 round 数远小于 `effectiveRoundCap`、且 `fitsWindow === true`（sweep 接住了）；(b) 墙钟 0（关闭）→ 行为与改造前一致。

**风险**：低。

---

### T7 — 超长文案识别（真问题）＋ 原生压缩完成原因（降级为只做检查）

#### T7a 识别上游的超长文案

**事实**（审阅实测）：`inspectContextOverflow('Input too long: input exceeds the context limit')` → `isOverflow:false`；`'model limit 1048576 tokens, requested 1972866 tokens'` → `isOverflow:false`。也就是说 DSH 归一出 `CONTEXT_WINDOW_EXCEEDED` 的那条报错，bili 自己**认不出来**。

**锚点**：`src/util.ts:285` `interface ContextOverflowInfo`（字段 `isOverflow / window? / requestedTotal? / requestedMessages? / requestedCompletion? / imageCountCap? / imageCountSeen? / message`，**没有 `counts`**）、`src/util.ts:427` `parseOverflowWindow`、`src/util.ts:540` `isMarkerlessOverflowReject`。

**步骤**：

1. 在 `CONTEXT_OVERFLOW_PATTERNS` 增加（注意大小写与可选空格）：
   - `/input\s+(?:is\s+)?too\s+long/i`
   - `/input\s+exceeds?\s+the\s+(?:model'?s\s+)?(?:token\s+)?context\s+limit/i`
   - `/exceeds?\s+the\s+(?:model'?s\s+)?(?:token\s+)?context\s+limit/i`
2. `parseOverflowWindow` 增加 `/model\s+limit\s+(\d+)\s*tokens?/i`；`requestedTotal` 增加 `/model\s+limit\s+\d+\s*tokens?,?\s*requested\s+(\d+)\s*tokens?/i`。
3. 用**已有字段**断言，绝不写 `.counts?.total`（会 TS2339）。验收断言：`info.window === 1048576 && info.requestedTotal === 1972866`。
4. `isMarkerlessOverflowReject` 现在对 `claude-opus-5-5 requires adaptive thinking` 返回 `true`（它是"400/413 且无任何 marker"的补集判定）。加一个已知参数错误 denylist：

```ts
const NON_OVERFLOW_PARAM_REJECT = [
    /requires?\s+adaptive\s+thinking/i,
    /omit\s+thinking/i,
    /output_config\.effort/i,
    /(?:unsupported|invalid)[_ ](?:parameter|value|request)/i,
];
```

判据改成 `(status === 400 || status === 413) && !任何 overflow pattern && !任何 param pattern`。
5. **明确记录它的影响面**：唯一调用点是 `src/server/relay.ts:1709`，只影响一行日志（"疑似超长"标注），不改请求结果。所以本 Task 的收益是**可观测性**，不是行为修复——计划里不要把它写成"解决了 413"。

#### T7b 原生压缩"200 但被截断"

**事实**（审阅）：`planCompactionFit` 的第三参是**输入**上限（`src/agent/compaction-fit.ts:307-313`），模块只 splice `messages`/`input`；`src/agent/native-intercept.ts` 里三个输出预算字段 grep 零命中；全仓唯一 `max_tokens=1` 是 `src/cache-keepalive.ts:5`。**原计划 Task 2 的"裁剪后恢复 max_tokens"不存在可改的对象，作废。**

**保留的部分**：`src/agent/native-intercept.ts:1219` 把所有 2xx 当成功；`1225` 已有 `response.clone()` 先例。加一个**只读检查**：

```ts
type LimitReason = "max_tokens" | "length" | "max_output_tokens";

function readTruncationReason(protocol: CompactionWireProtocol, body: unknown): LimitReason | undefined
// anthropic: stop_reason === "max_tokens"
// openai:    choices[0].finish_reason === "length"
// responses: incomplete_details.reason === "max_output_tokens"
```

在 `status < 400` 分支里 `response.clone()` 后按 `plan.protocol` / `plan.field` 解析（SSE 与 JSON 两种形态都走 `extractSummaryFromSse` 同款的逐行解析），命中就 `log("warn", "[compaction-fit] upstream accepted the fitted replay but truncated it (reason=%s) — the checkpoint will be incomplete")`。

**不做**：不试图减小输入（那会让摘要更差）、不重发、不改 max_tokens。**只记录**——因为下一版要靠 DSH 侧恢复输出额度，bili 改不了。

**验收**：`tests/native-intercept-selfheal.test.ts`（22 项）保持全绿；追加 3 个用例（三协议各一），构造带 `finish_reason: "length"` 的 200 响应，断言日志出现且返回给调用方的 `Response` 未被消费（`bodyUsed === false`）。

**风险**：低。只读 clone，不改返回对象。

---

### T8 — 测试与发布

#### T8a 三个既有失败文件必须在本计划内重基线

审阅已实测：`tests/preflight-round-budget.test.ts`（2 fail）、`tests/issue3918-preflight-progress-verdict.test.ts`（1 fail）、`tests/preflight-target-stability.test.ts`（1 fail）在**干净 HEAD 上同样失败**，且与工作区改动无关（都没 seed `lastInputTokens` → `probeForEvidence` 恒 false；`target-stability` 根本不 import `server.ts`），根因是已提交的 #5630（合并折叠单元）。

原计划里"单独列出不混入统计"与"不得放宽断言转绿"两句自相矛盾。**改成一条硬规则**：这三处失败是**行为 pin 过期**，必须在本计划内按新行为重写期望值，并在测试注释里写明依据（`#5630 coalesced fold units` + 本计划的 I1/I2）。判据是"新期望值能被代码解释"，不是"数字变小了"。

#### T8b 新增测试

| 文件 | 覆盖 |
|---|---|
| `tests/preflight-budget-hit-digest-sweep.test.ts` | T3 的 4 个用例 |
| `tests/preflight-terminal-status.test.ts` | §0.1 判定表逐格 |
| `tests/preflight-wall-clock.test.ts` | T6 的 2 个用例 |
| `tests/issueXXXX-preflight-2x-window.test.ts` | 端到端复现事故形态：`limit = 786432`、payload ≈ 1.97M tok、9000+ 条消息、单区间最大 ≤ 20k tok → 断言 coalesce 后 unit ≥ 400k tok、digest sweep ≤ 3 块收敛、`fitsWindow === true`、上游摘要调用 0 次 |

#### T8c 必跑清单（全绿才算完）

```
node --import tsx --test tests/preflight-budget-hit-digest-sweep.test.ts
node --import tsx --test tests/preflight-terminal-status.test.ts
node --import tsx --test tests/preflight-wall-clock.test.ts
node --import tsx --test tests/issueXXXX-preflight-2x-window.test.ts
node --import tsx --test tests/issue2490-ledger-floor-doomed-probe.test.ts
node --import tsx --test tests/compaction-oversize-fit.test.ts
node --import tsx --test tests/preflight-emergency-fold.test.ts
node --import tsx --test tests/issue5630-preflight-fold-unit.test.ts
node --import tsx --test tests/preflight-dead-ranges.test.ts
node --import tsx --test tests/preflight-hold.test.ts
node --import tsx --test tests/preflight-round-budget.test.ts
node --import tsx --test tests/issue3918-preflight-progress-verdict.test.ts
node --import tsx --test tests/preflight-target-stability.test.ts
node --import tsx --test tests/native-intercept-selfheal.test.ts
node --import tsx --test tests/context-overflow.test.ts tests/issue4452-markerless-reject.test.ts
node --import tsx --test tests/issue1993-preflight-400.test.ts
npx tsc --noEmit -p tsconfig.json
```

#### T8d 发布（修正原计划里不可执行的三处）

1. **build-info 脏标记**：`scripts/write-build-info.mjs` 用 `git status --porcelain`，未跟踪的 `docs/superpowers/` 会让每次构建都写 `-dirty`。**先在功能提交里把 `docs/superpowers/` 一起提交**（设计文档本来就该进仓库），或在 `.gitignore` 加一行。二选一，选提交——留档比忽略好。
2. **仓库没有 GitHub remote**：只有本地目录 `origin` 与 `file://` 的 `atier`。发布前执行
   `git remote add github https://github.com/puny-code/billion-context.git`，
   推送用 `https://puny-code:<token>@github.com/...`（token 从 `git credential fill` 取，不落盘）。
3. **Release 前置**：tag 必须先存在于远端，`release create` 才能挂；asset 用 `curl.exe --data-binary @file` 上传；`npm pack --pack-destination` 的目标目录必须**先创建**。
4. `bili-ops/ROLLBACK.md` 在仓库外（`C:\Users\LIU\Documents\deepseek-harness\default-workspace\bili-ops\`），发版后手工补一行 v1.4.6 的 sha256 与下载地址。

#### T8e 版本与提交顺序

```
1. 提交 docs/superpowers/（清掉未跟踪）
2. 提交源码改动（T1-T7）
3. 提交测试（T8a/T8b）
4. 全部测试 + tsc 绿
5. 提交版本号与 build-info（此时工作区必须干净）
6. 构建 → npm pack → 打 tag → push tag → release create → 上传 tgz
```

## 3. 五条阻断问题的处置对照

| 审阅阻断项 | 处置 |
|---|---|
| Task 2 前提错误（`planCompactionFit` 第三参是输入上限） | 原 Task 2 整条作废；T7b 降级为"只读完成原因检查"，并明确 bili 改不了输出额度 |
| Task 1 失败断言与 fixture 不可能同时成立 | T1 改用"日志出现 `folding first` 且无 `preflight fail-fast 413`"；T8b 另建 ~3× window 的 fixture 专门测 sweep |
| Task 5 编译不过（`.counts?.total`） | T7a 用 `info.window` / `info.requestedTotal`，不新增字段 |
| 目标未覆盖（折叠后终局仍 413/502） | T3 + T4 + T5 正面解决；§0.1 判定表与 `terminalStatus()` 单测是验收核心 |
| Task 3 与 issue1993 冲突 | T3 步骤 4：`upstream && status < 500` 不跑 sweep，硬 400 仍是 502 + `retryable:false` |

## 4. 其余建议与遗漏的落点

| 审阅意见 | 落点 |
|---|---|
| `unfoldedDoomed` 死变量 | T1 步骤 1 删除 |
| 删掉 `noteLocalRefusal` 破坏 #3846 | T1 步骤 3：pre-fold 不再拒绝故无需记录，终局 413 仍记录（4119），语义更强 |
| `relay.ts:752-775` egress fuse 未覆盖 | T5 步骤 4：不改代码，加测试证明折叠后不触发；必要时改输入视图 |
| `beginPreflightHold` / `handle.ts:2564-2619` 误判 | 从计划删除 Task 4；保活 v1.4.4 已有，`tests/preflight-hold.test.ts` 已绿 |
| 只有每块 1200ms、无全局墙钟 | T6 |
| `summaryBudget` 是 local const 不是函数 | T3 步骤 1 的 sweep 不需要它，改为 `budgetHit` 触发 |
| `entries` 只在 emergencyFold 收集 | T2 |
| 复用已由 `persist.ts:1433` cold-load 提供 | 原 Task 6 删除，改为一条**观察项**：发版后确认 `[persist] cold-loaded … 13 block(s)` 仍出现 |
| 三个既有失败是行为 pin 过期 | T8a |
| 缺端到端 1.97M/786K 测试 | T8b 最后一行 |

## 5. 明确不做的事

- 不恢复"裁剪后把 max_tokens 改回原值"——没有可改的对象，`native-intercept.ts` 不碰输出预算。
- 不新增 `counts` 字段——`ContextOverflowInfo` 保持现有形状。
- 不改 `lineage`/`atier` 两个非 GitHub remote，不重写历史。
- 不建 27MiB 摘要缓存——跨请求复用已由 persist cold-load 提供。
- 不改 `emergencyFold` 的 19.2× 阈值——T3 的 sweep 是它的**补充**，不是替代。
- 不加新的用户可见配置项（墙钟只开放环境变量给测试）。

## 6. 执行顺序

```
T2（纯重构，先绿）
 → T3（sweep）
 → T4（终止保证）
 → T6（墙钟，复用 budgetHit）
 → T5（终局判定 + 单测）
 → T1（清理死变量，随时可做）
 → T7a / T7b（独立）
 → T8a/b（测试）→ T8c（全绿）→ T8d/e（发布 v1.4.6）
```

估算改动面：`src/preflight.ts` +180/-60、`src/server.ts` +40/-35、`src/util.ts` +25、`src/agent/native-intercept.ts` +45、测试 +600。

**未验证声明**：本节的代码片段是设计级伪代码，行号基于 2026-11-07 的工作区（含两个未提交文件）。执行时每一处都必须以 `npx tsc --noEmit` 与该 Task 的验收测试为准；任何一处与代码现状不符，以代码为准并回报。

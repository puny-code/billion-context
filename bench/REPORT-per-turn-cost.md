# 每轮处理成本基准：8650 条消息 / 27.3 MiB 历史

**结论先行**：在这份历史规模下，「每轮」的 CPU 成本**不是**几百毫秒，而是 **8.2 秒起**；一旦 overflow 触发 preflight 压缩走一圈，**再加 228 秒**。成本的 99.5% 集中在 kernel 的 `recommend` 节点，而它是 **O(n²)**（实测 n^1.96，翻倍 3.1–5.4 倍）。给每轮 2 秒预算时，8650 条有 **3 个阶段**超预算：`processTurn`(286%)、`reconcileFoldCoverage` 冷轮(122%)、`preflightCompress`(11394%)。

- 分支 / HEAD：`2026-11-01_orphan-collect-and-recovery-window` / `03c5e4bf`（测量全程未变；本任务只新增 `bench/`，被测的三个文件 `src/preflight.ts`、`src/fold-reconcile.ts`、`kernel/src/*` 未被改动 —— 详见 §8 末条）
- 机器：Windows，node v22.22.3，`node --expose-gc --import tsx`，单进程、GC 已跑过的稳态
- 原始数据：[results-per-turn-cost.json](results-per-turn-cost.json)，脚本：[per-turn-cost.ts](per-turn-cost.ts)

---

## 1. 合成历史怎么造

| 项 | 取值 |
|---|---|
| 条数 | 1000 / 2000 / 4000 / 8650 |
| 单条字节 | 3309（8650 × 3309 = **27.30 MiB**，对齐「8650 条 / ≈27.3 MiB」） |
| 消息形状 | 4 条一循环：`user text` → `assistant text` → `assistant tool-call(call_N)` → `tool-result(call_N)`，配对齐全，让 turn-integrity 分组与 tool pair 真的生效 |
| 文本 | 可复现的英文段落重复（保证每轮字节数完全一致） |
| config | `defaultConfig(200_000)`，即 `compress.minCompressRange = 5000`、`preserveRecentMessages = 3`（bili 默认量级） |
| `renderTags` | `"text-only"`（prepare-* 四端都传这个，见 `src/server/prepare-openai.ts:213`） |

每个规模同进程跑 3 次取**中位数**，每次前先 `global.gc()`。

隔离（全程只写 `bench/`，绝不触碰真实数据）：`BILI_SESSIONS_DIR` / `XDG_STATE_HOME` / `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` 全部指向 `%TEMP%\bili-bench-*`，并 `Remove-Item env:BILLION_CONTEXT_NATIVE`。实测 SQLite 库落在 `%TEMP%\bili-bench-sessions\index.db`，真实状态目录未被打开。

---

## 2. 阶段 × 规模耗时（ms，3 次中位数）

| 阶段 | 1000 | 2000 | 4000 | 8650 |
|---|---:|---:|---:|---:|
| `estimateCoreMessages`（估算层） | 0.4 | 0.1 | 0.3 | **0.8** |
| `processTurn` 冷态（empty state，未触窗） | 83.2 | 258.6 | 1051.3 | **5712.3** |
| `processTurn` 判为超窗（emergency-truncate 武装） | 75.4 | 249.5 | 1015.0 | **5863.8** |
| ── 同上，节点加权和（校验用） | 73.1 | 259.2 | 1003.2 | **5862.8** |
| ── 其中 `recommend` 单节点 | 64.0 | 253.0 | 991.5 | **5836.4** |
| `reconcileFoldCoverage` **冷轮** | 325.2 | 558.6 | 1115.4 | **2445.9** |
| `reconcileFoldCoverage` **稳态轮**（同 id 重发，锚复用） | 1.07 | 1.67 | 4.08 | **8.90** |
| 实际下发给模型的候选单元数（`nudge.compressibleRanges`） | 250 | 500 | 1000 | **2162** |
| `preflightCompress` 整轮（真实入口，见 §5） | 1506 | 9713 | 39489 | **227879** |
| **合一：冷轮 reconcile + processTurn** | **408** | **817** | **2167** | **8158** |

测量口径：`estimateCoreMessages` 来自 `src/preflight.ts:378`；`processTurn` 是 `acp-kernel` 的 `core.processTurn`（`kernel/src/compress.ts:836`）；`reconcileFoldCoverage` 是 `src/fold-reconcile.ts:1607`；`preflightCompress` 是 `src/preflight.ts:1617` 的真实入口。

---

## 3. 相对线性度（n 翻倍时耗时倍数）

| 阶段 | 1000→2000 | 2000→4000 | 4000→8650 (×2.16) | 全程 1000→8650 | 拟合 |
|---|---:|---:|---:|---:|---|
| `estimateCoreMessages` | 0.3× | 2.7× | 2.6× | 2.0× | 噪声底，≈线性且 < 1ms，无意义 |
| `processTurn` | 3.1× | 4.1× | 5.4× | **68.6×** | **n^1.96 ≈ 二次** |
| `processTurn`（超窗） | 3.3× | 4.1× | 5.8× | **77.8×** | **n^2.02** |
| `recommend` 节点 | 4.0× | 3.9× | 5.2× | **91.2×** | **n^2.09** |
| `reconcileFoldCoverage` 冷轮 | 1.7× | 2.0× | 2.2× | 7.5× | **n^0.94 ≈ 线性**（已做过 #1930-2 的收敛） |
| `reconcileFoldCoverage` 稳态轮 | 1.6× | 2.4× | 2.2× | 8.3× | ≈线性（绝对值 <10ms，不重要） |
| `preflightCompress` 整轮 | 6.5× | 4.1× | 5.8× | **151.3×** | **n^2.33**，比 processTurn 更糟 |

**判定**：
- **超线性的是 kernel fold 主 pass（`recommend` 节点）**，二次方，不是估算层、也不是 fold 对账层。
- `reconcileFoldCoverage` 冷轮是**近线性**的（n^0.94），317→2446ms 一路 8.65 倍消息换 7.5 倍耗时 —— 这一段**没有**回归。
- `preflightCompress` 实测 n^2.33，比它内部调用的 `processTurn` 还要陡。

单条消息摊到的 `processTurn` 成本：1000 条时 **83 µs/条**，8650 条时 **660 µs/条**（8.65 倍消息 → 单条贵 8 倍，这就是二次方的直接体现）。

---

## 4. 主成本排序（8650 条时，一颗核上的纯 CPU）

| # | 阶段 | 耗时 | 占「单请求最低成本」的比例 |
|---|---|---:|---:|
| 1 | `preflightCompress` 整轮（仅在 overflow 触发时） | **227.9 s** | — （是 fold pass 的 40 倍） |
| 2 | `processTurn`（`recommend` 占其中 99.55%） | **5.71 s** | 70% |
| 3 | `reconcileFoldCoverage` 冷轮 | **2.45 s** | 30% |
| 4 | 其余 12 个 kernel 节点合计（assign-refs 5.7ms、sync-blocks 7.5ms、render-refs 7.5ms、…） | **≈26 ms** | 0.3% |
| 5 | `estimateCoreMessages` | **0.8 ms** | ≈0% |
| 6 | `reconcileFoldCoverage` 稳态轮 | 8.9 ms | 0.1% |

一句话：**成本全在两处** —— kernel 的 `recommend` 节点（每轮必付）和 preflight 的折叠循环（overflow 时付，付一次等于付 40 个 fold pass）。

### 4.1 节点级归因（8650 条，`core.defaultNodes()` 逐节点驱动）

| 节点 | ms | 占比 |
|---|---:|---:|
| **recommend** | **5836.4** | **99.55%** |
| render-refs | 7.5 | 0.13% |
| sync-blocks | 7.5 | 0.13% |
| assign-refs | 5.7 | 0.10% |
| view-latch | 2.2 | 0.04% |
| nudge-inject | 1.9 | 0.03% |
| hide-compress-calls / emergency-truncate / reconcile-live-ids / prune / pre-transform-snapshot | ≤1.2 | ≈0% |
| （ccr-store / absorb-hide / crush / absorb-prompt / filter 本 config 下未启用） | — | — |
| **合计** | **5862.8** | 与真实 `core.processTurn` 5712.3ms 的偏差 2.6%，可认为等价 |

### 4.2 CPU profile 佐证（`--cpu-prof`，一次 8650 条 processTurn）

| 自身耗时占比 | 函数 | 位置 |
|---:|---|---|
| 25.5% | `computeTurnGroups` | `kernel/src/turn-integrity.ts:30` |
| 25.4% | `computeIntegrityWithdrawals` | `kernel/src/turn-integrity.ts:138` |
| 17.8% | `resolveBoundaries` 里的 `indexByMessageId.set(...)` 回调 | `kernel/src/boundaries.ts:83` |
| 6.6% | `filterProtectedToolMessages` | `kernel/src/unit-projection.ts:521` |
| 4.5% | GC | — |
| 4.4% | `projectUnit` 本体 | `kernel/src/unit-projection.ts:92` |
| 2.6% + 2.1% + 1.3% + 1.3% | `computeIntegrityWithdrawals` 内层循环 / `collectAgedCompressCallIds` / `collectFailedCompressCallIds` / `isMessageProtected` | 同上 |

合计 **≈86%** 的采样落在 `projectUnit` 这一个函数及其向下调用里。

### 4.3 机制：为什么是二次方（可复现的因果链）

1. `recommend` 节点（`kernel/src/compress.ts:1192`）在每次 `processTurn` 里：
   - `computeProtectedRefs(io.messages, …)` —— **O(n)**；
   - `buildCompressibleRanges(...)` —— **O(n)**；
   - `mergeRangesToThreshold(contextRanges.compressible, config.compress.minCompressRange)`（`kernel/src/recommend.ts:577`）把候选段按 **5000 字符**的门槛合并成「单元」；
   - `screenRecommendedUnits(...)`（`kernel/src/recommend.ts:646`）**对每个单元**调用一次 `projectUnit`（`:658`）；
   - 又调了一次 `computeProtectedRefs(screenArray, …)` —— 再 **O(n)**。
2. `projectUnit`（`kernel/src/unit-projection.ts:92`）**每次调用都从头扫整个消息数组**：
   - `resolveBoundaries` 建 `indexByMessageId`（`:100`）→ 全量 Map；
   - `computeIntegrityWithdrawals`（`:365` / `:416`）→ `computeTurnGroups` 全量分组、再反复扫；
   - `filterProtectedToolMessages`（`:521`）→ `collectFailedCompressCallIds` + `collectLatestProtected` + `collectAgedCompressCallIds` + 两轮全量 `messages.find`；
   - 粗算每次 `projectUnit` ≈ **4–6 次全量扫描**。
3. 单元数 **U ≈ n/4**（实测 250 / 500 / 1000 / 2162，正好等于 n/4：一条 turn 组 = 3 条消息 ≈ 9.9KB，已过 5000 字符门槛，所以最小单元就是一条 turn，外加前导 user 后约 4 条一组）。
4. 于是总工作量 ≈ **U × O(n) = n²/4 × (4~6 次扫描)**。

**这个二次方对真实数据敏感的是「单元数 U」，而 U 由「消息大小分布 vs `minCompressRange=5000` 字符」决定**：消息越大、单元越少，二次方常数越小。本次合成历史每条 3.3KB 是均匀的，这是最不利的情形之一；真实历史里夹着几 MB 的 tool 结果时 U 会小于 n/4。**但 n=8650 / 27.3MiB 这个总字节数是给定的，只要单元数仍然是 O(n)，二次方的形状就成立**，只是常数会小一些。要精确知道真实权重，需要真实尺寸分布（本次不允许打开真实库，故未测）。

---

## 5. `preflightCompress` 是怎么测的，以及它为什么最贵

`src/preflight.ts:1617` 的真实入口，直接用 `core` + 一个最小 `Session` 驱动，**没有任何 mock 掉被测逻辑**。窗口按「真实 8650 条案例的比例」取：估算 7,162,200 tok / 207,000 窗口 = **34.6 倍溢出**，四档规模都用同一个溢出比，保证落在同一个 regime。

34.6× > `EMERGENCY_FOLD_COVERAGE`(= 16×2×0.6 = **19.2**，`src/preflight.ts:152`)，所以走 **#2383 的确定性摘要（deterministic digest）regime**：不发任何摘要请求、不联网、纯 CPU。**这正是 27.3MiB 事故实际走的路径**。

实测（每档 1 次，因为单次就是分钟级）：

| n | 轮数 | 一轮内折叠的段数 | 耗时 | 结束状态 |
|---|---:|---:|---:|---|
| 1000 | 1 / 512 | 250 | 1.51 s | `exhausted`，`fitsWindow=false` |
| 2000 | 1 / 512 | 500 | 9.71 s | `exhausted`，`fitsWindow=false` |
| 4000 | 1 / 512 | 1000 | 39.49 s | `exhausted`，`fitsWindow=false` |
| 8650 | 1 / 512 | 2162 | **227.88 s** | `exhausted`，`fitsWindow=false` |

要点（诚实修正一个直觉）：
- 它**不是**跑满 512 轮。它在**第 1 轮里就把全部 2162 个单元一次性折完**（每段一个确定性 digest），然后发现还是装不下、无更多可折的段 → `exhausted` 收尾。
- 所以 228 秒是**单轮**的代价，等于 **40 个 `processTurn`**（`227879/5712 ≈ 39.9×`）。原因同源：apply 侧 `applySingleRange`（`kernel/src/compress.ts:1490`）对**每个** range 再走一遍 `projectUnit`（`:1495`）+ 建块 + restamp，仍是多少个段就乘多少次全量扫描 → 实测 n^2.33。
- 它是「一轮都还没折完就 200 秒」的量级。客户端超时重试一次，就是 400 秒 —— 与「卡了 20 分钟」的现场一致。

---

## 6. 「假如每轮预算 2 秒」，8650 条时谁超

单请求（一次消息）实际要付的串行 CPU：

| 阶段 | 8650 条耗时 | / 2 s 预算 | 结论 |
|---|---:|---:|---|
| `estimateCoreMessages` | 0.8 ms | 0.04% | ✅ 便宜 |
| `reconcileFoldCoverage` 稳态轮 | 8.9 ms | 0.4% | ✅ 便宜 |
| `reconcileFoldCoverage` **冷轮** | **2445.9 ms** | **122%** | ❌ **超** |
| `processTurn`（fold 主 pass） | **5712.3 ms** | **286%** | ❌ **超（最大单项）** |
| 二者合计 | **8158.2 ms** | **408%** | ❌ 仅这两步就 4 倍预算 |
| `preflightCompress`（overflow 时） | **227879 ms** | **11394%** | ❌❌ **超 114 倍**，且仍 `fitsWindow=false` |
| 全部合计（overflow 路径） | **≈236 s** | **≈11800%** | 一次请求 ≈ 4 分钟纯 CPU |

**谁先超**（按 n² 外推的 2 秒临界点）：
- `preflightCompress` 在 **n ≈ 1150** 就超 2 秒；
- `reconcileFoldCoverage` 冷轮在 **n ≈ 5400** 超 2 秒；
- `processTurn` 在 **n ≈ 5500** 超 2 秒；
- 到 8650 条：三个阶段全超，`processTurn` 是最大单项，`preflight` 是灾难项。

**含义**（不是本次任务的实现，只是给设计的事实底座）：只要 `processTurn`/preflight 的二次方还在，任何「每轮 wall-clock 预算」都必须在**阶段内部**设检查点才可能生效 —— 一次 `processTurn` 调用本身就是 5.7s 的**不可打断同步段**（#4528 的 `yieldToEventLoop` 只能插在这个不可打断段**之间**，插不进去），preflight 的单轮更是 3.8 分钟的不可打断段。

---

## 7. 明确「测不到 / 无公开入口」的部分

诚实清单 —— 以下**没有测**，报告里也没有用估计值冒充实测：

1. **`handle.ts` 的整请求路径**（JSON 解析、协议转换、wire 重建、egress）：需要起完整 server 并伪造上游，本次未做。`estimateCoreMessages`/`processTurn`/`render-refs` 已覆盖其中 CPU 大头，但**协议转换层（prepare-*）的开销未测**。
2. **`reconcileFoldCoverage` 的 `storedMessages` 分支**（真实路径会传 `storedMessagesFor(session, …)`，走存储读）：本次按现有 perf 测试的形态传 `storedMessages: undefined`，**数据库读取与反序列化成本未计入**。
3. **上游/网络耗时**：本报告全部是纯 CPU，不含任何摘要请求的 RTT。LLM 摘要 regime（溢出 < 19.2 倍时）需要伪造上游，本次没驱动。
4. **`decode / decompress / zstd`、图片链路、persist 落盘**：不属于「每轮 fold」主链，未测。
5. **真实尺寸分布下的单元数 U**：不允许打开真实库，所以 U 只用合成历史验证（= n/4）。真实 U 需要真实数据。
6. 无法从外部打断 `processTurn`/`core.applyCompression`：**它们没有可注入的检查点或分片入口**（`Ports` 只有 `countTokens`），所以「阶段内部预算」目前**不存在公开机制**，需要新增。

---

## 8. 误差与注意事项

- **重复性**：8650 档独立跑了 3 遍完整测量：`processTurn` 5838.1 / 5616.6 / 5712.3 ms（±3.6%）；`reconcile` 冷轮 2447.5 / 2668.3 / 2445.9 ms（±4.7%）；`preflight` 221.1 / 217.8 / 227.9 s（±2.3%）。本报告取第 3 遍（最完整、含单元数）为主表。
- **单进程单机**：中位数 + 每次前 GC；仍受同机其他负载影响（测量期间有另一个 teammate 在写 `notes/`，非 CPU 密集）。
- **节点加权和 vs 真实 `processTurn`** 差 2.6%（5862.8 vs 5712.3）：逐节点驱动少了 `processTurn` 外层的 `lastPassIds`/`deadRefs` 收尾与一次 `validateConfig`，方向正确、量级一致，故用它做归因、用真实 `processTurn` 做总量。
- **合成历史的均匀性**见 §4.3 末尾：二次方形状可信，常数随真实尺寸分布变化。
- **`estimateCoreMessages` 的 0.1–0.8ms** 已在计时噪声底，别拿它的倍数当线性度结论。
- **测量期间工作区变动**：HEAD 始终是 `03c5e4bf`；但测量结束时 `git status` 出现 `M src/server/relay.ts` 与新增的 `tests/relay-fold-meter.test.ts`（**不是本任务所为**，本任务只新增 `bench/`）。本报告测的三个被测文件 `src/preflight.ts`、`src/fold-reconcile.ts`、`kernel/src/*` 在整个测量窗口内**均未被修改**（`git status` 的 `src/` 改动只有 `relay.ts` 一个），所以数字对应的是 HEAD 上的实现。

---

## 9. 复现

```powershell
# 先建隔离目录并清掉继承的 lane 判定变量
$env:BILI_SESSIONS_DIR="$env:TEMP\bili-bench-sessions"
$env:XDG_STATE_HOME="$env:TEMP\bili-bench-state"
$env:XDG_CONFIG_HOME="$env:TEMP\bili-bench-config"
$env:XDG_CACHE_HOME="$env:TEMP\bili-bench-cache"
Remove-Item env:BILLION_CONTEXT_NATIVE -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $env:BILI_SESSIONS_DIR,$env:XDG_STATE_HOME,$env:XDG_CONFIG_HOME,$env:XDG_CACHE_HOME | Out-Null

cd <repo>
# 全矩阵（约 6 分钟，preflight 那 4 档占 4.5 分钟）
node --expose-gc --import tsx bench/per-turn-cost.ts
# 单档，例如只测 8650
node --expose-gc --import tsx bench/per-turn-cost.ts 8650
```

`BENCH_PREFLIGHT_BUDGET_MS` 可调 preflight 的 wall-clock 上限（默认 60s；8650 档需要 ≥ 240s 才会自然跑完，否则结果里 `aborted=yes`）。

节点级归因可以用同一份脚本里的 `timeNodes()`（它驱动的是 `core.defaultNodes()` 返回的**真实 kernel 节点**，只把末尾的 render-refs 换成 bili 用的 `"text-only"` 策略）。

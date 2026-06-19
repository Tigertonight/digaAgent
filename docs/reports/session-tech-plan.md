# diga-agent 会话功能 — 技术迭代与 Bugfix 方案

> 输入依据：`docs/reports/session-audit.md`（13 项 finding：1 High / 8 Medium / 3 Low / 4 Info）
> 计划目标：把审计中暴露的 P0/P1/P2 问题转化为可排期、可验收、可回归的工程任务。

## 0. TL;DR

- **必须先修的 4 件事（P0，~3 人日）**：1) `POST /api/agent/new` 的 `sessionPath` 路径越权；2) abort 路径不清 watchdog 导致"中止后又跑一轮"；3) DELETE/fork 后 `listAllSessions` 缓存不失效造成幽灵 session；4) 持久化层 IO 错误普遍被 `catch {}` 静默吞，加最小可观察性补丁。
- **核心架构改造（P1，~8 人日）**：抽 `lib/storage/atomic.ts` 单点实现"UUID tmp + open(wx) + fsync + rename + fsyncDir + per-id Promise chain"，替换全仓 9 处 store 的写盘点；`createAgent` 入口加 in-flight 去重；progress/goal 加 schema version。
- **长期改进（P2，~6 人日）**：跨进程锁或单进程约束、孤儿 tmp/lock 清理、孤悬 session 维护任务、错误处理规范化文档与 PR checklist。
- **风险**：原子写改造涉及 9 个 store 同时改动，需做"灰度+回滚 flag"；schema version 改造需兼容老数据。
- **可衡量收益**：消除 1 个 High 安全洞、消除"中止后自动重跑"用户可感知 bug、消除 9 处潜在数据损坏点、补齐运维盲区。

## 1. 总体策略

**指导原则**

1. **先止血、再重构**：P0 全部走 small / 局部 patch，一周内可独立发版；P1 才动大基座，避免把安全修复阻塞在重构里。
2. **单点抽象优先于多点修补**：`atomic write helper` / `trusted session path guard` / `invalidateSessionListCache` / `finalizeAfterAbort` 四个共享单元一旦建立，相关 finding 可批量 close。
3. **可观察性零成本先行**：所有持久化 `catch {}` 至少 `console.warn(errno)`——这是后续灰度任何重构的前提，否则线上回归无感知。
4. **状态机对称**：每个 finding 共同根因是"开-关动作不对称"（subscribe / setTimeout / 持锁 / 缓存）。任何"开"必须有对应"关"清单，集中放在 `disposeAgent` / abort 分支 / DELETE 分支。
5. **Schema 演进规范化**：`workflows/server-store.ts` 是范例。所有 envelope 必须 `version` 字段，读端必须做 `version > CURRENT` 拒读、`< CURRENT` 迁移。
6. **测试覆盖跟随修复**：每个 P0/P1 任务都必须配一条 e2e 或单测，进 CI smoke。无测试不合并。

**不在本次范围**

- SDK 层 `~/.pi/sessions/<id>.jsonl` 写入（pi-coding-agent 内部）。
- 前端 React 层切换会话 race（单独排期）。
- 多租户鉴权层（假设受信端运行）。

## 2. 里程碑与排期

| 里程碑 | 周期 | 主题 | 工作量 | 关键产出 |
| --- | --- | --- | --- | --- |
| **M1** | Sprint 1（1 周内） | 安全与可观察性热修（P0） | ~3 人日 | 4 个独立小 PR，可独立发版 |
| **M2** | Sprint 2-3 | 持久化基座统一（P1 主轴） | ~8 人日 | `lib/storage/atomic.ts` + 9 store 替换 + 灰度 flag |
| **M3** | Sprint 3（与 M2 并行） | 生命周期一致性（P1） | ~5 人日 | createAgent 去重 / DELETE errno / 孤儿清理 |
| **M4** | Sprint 4 | Schema 演进规范（P1 收尾） | ~4 人日 | progress/goal version + 迁移 + 规范文档 |
| **M5** | Sprint 5+ | 长期可观察性与多进程（P2） | ~6 人日 | 跨进程锁 / 维护任务 / PR checklist |

**总投入预估**：~26 人日（约 1 名工程师 5-6 周，或 2 人 3 周）。

**关键路径**：M1（解锁安全发版） → M2 atomic helper 抽离 → M2 各 store 灰度替换 → M4 schema 演进。M3 可与 M2 并行。

## 3. 任务卡（按里程碑展开）

### 3.1 M1 · 安全与可观察性热修（Sprint 1，~3 人日）

**目标**：一周内完成 4 个独立小 PR，不依赖任何重构，可独立 hotfix 发版。

#### T1.1 `sessionPath` 路径越权修复（H1 / Top 1）

- **Finding**: 报告 2.1 / 3.2.1 H1
- **改动点**：
  - `app/api/agent/new/route.ts:31` 增加调用 `assertTrustedSessionPath(opts.sessionPath)`
  - 新增 `lib/sessions.ts` 导出函数 `assertTrustedSessionPath(p: string)`：包装 `resolveTrustedSessionPath` + `listAllSdkSessions()`，失败招 `TrustedSessionPathError`
  - `route.ts` catch 存在 `e instanceof TrustedSessionPathError` 返 400，其他异常返 `internalErrorResponse`（与 context 路由对齐，不再直返 stack）
- **依赖**：无
- **验收标准**：
  - 新增 e2e：`POST /api/agent/new` 携 `sessionPath=/etc/hosts` 返 400
  - 携未出现在 `listAllSdkSessions` 的任意 .jsonl 返 400
  - 正常 resume 路径仍然 200
- **工作量**：S（0.5 人日）
- **安全影响**：关闭任意文件写入 / SSE 泄露面

#### T1.2 abort 路径清 watchdog（M2 / Top 5）

- **Finding**: 报告 3.2.2
- **改动点**：
  - `lib/agent-registry.ts` 新增 `finalizeAfterAbort(rec)`：顺序调 `clearFinishWatchdog(rec)` → `clearToolWatchdog(rec)` → 清 `pendingFinishMessage` → `rec.isStreaming = false`
  - `app/api/agent/[id]/route.ts:796-810` 的 abort 分支改调 `finalizeAfterAbort(rec)` 后再 `rec.session.abort()`
- **验收标准**：
  - 新增单测：goal active 下发送 prompt，模拟 `message_end` 事件后 100ms 调 abort，等待 2s，断言不出现第二轮 `start_run`
- **工作量**：S（0.5 人日）

#### T1.3 `listAllSessions` 缓存主动失效（M3）

- **Finding**: 报告 3.2.3
- **改动点**：
  - `lib/sessions.ts` 新增导出 `invalidateSessionListCache()`（生产版本，不再复用 `__clearSessionListCacheForTests`）
  - `app/api/sessions/[id]/route.ts` DELETE 成功后调用
  - `app/api/sessions/[id]/fork/route.ts` 成功后调用
- **验收标准**：
  - e2e：DELETE 后 50ms 内 GET `/api/sessions`，列表不含该 session
  - fork 后立即 GET，能看见新 session
- **工作量**：S（0.3 人日）

#### T1.4 持久化错误可观察性补丁（Top 4 跨多点）

- **Finding**: 报告 3.1.3 多条
- **改动点**：仅加 log，不改逻辑。跨 5 个文件只增 catch 内 warn：
  - `lib/progress/file-store.ts:122-127`：read 非 ENOENT→`console.warn("[progress-store] read failed", err.code, fp)`
  - `lib/progress/file-store.ts:163-`、`lib/goal/file-store.ts:154-`、`lib/subagents/server-store.ts:124-`、`lib/workflows/server-store.ts:131-`、`lib/meta/store.ts:114-`：write catch 加 warn
  - 以上任何点 errno === 'ENOSPC' 重抣 throw（让调用层能传到 UI）
- **验收标准**：
  - 单测：mock `fs.writeFile` 招 ENOSPC，persist 函数必须 throw；mock EACCES，函数不 throw 但 console.warn 被调用一次
- **工作量**：S（1 人日）
- **后续侧面影响**：为 M2 重构提供线上发现问题的能力，是后续灰度的前提

### 3.2 M2 · 持久化基座统一（Sprint 2-3，~8 人日）

**目标**：抽出单一原子写 helper，并逐个迁移 9 处 store 的写盘代码。使用 feature flag `DIGA_ATOMIC_V2`，default on，存在问题可环境变量关闭。

#### T2.1 抽象 `lib/storage/atomic.ts`

- **Finding**: 报告 横切根因 1 / 3.1.2
- **交付物**：`lib/storage/atomic.ts`，导出：
  - `atomicWriteJson(filePath: string, data: unknown, opts?: { lockKey?: string }): Promise<void>`
    - `randomUUID()` tmp 名 → `open(tmp, 'wx')` → `write` → `handle.sync()` → `close` → `rename(tmp, fp)` → `fsyncDir(dir)`
    - rename 失败手动 unlink tmp
    - 错误分类：ENOSPC 重抣、ENOENT 中间目录不在时先 mkdirp 重试 1 次、其余 errno warn
  - `withPerKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T>`
    - 进程内 `Map<key, Promise<unknown>>` 串行队列（抷自 `meta/store.ts`）
  - `cleanupStaleTmpFiles(dir: string)`：启动时扫 `*.tmp.*` 并 unlink（为 T2.10 / P1-4 复用）
- **依赖**：无
- **验收标准**：独立单测覆盖并发写入、同名 tmp 冲突、ENOSPC 传递、wx 防撞、fsyncDir 被调用
- **工作量**：M（1.5 人日）
- **设计决策**：不引入第三方库（避免依赖蔓延）；API 以 `fp` 为 key，调用方传 `lockKey: fp` 即可获得串行保证

#### T2.2 ~ T2.10 各 store 逐个迁移

按 “高频写先 / 危险面大先” 顺序迁移，每个 store 一个 PR，仅替换写盘点、不改业务逻辑。每项均需一条边界单测 + 一次本地烟雾。

| 子任务 | 文件 | 优先级原因 | 工作量 |
| --- | --- | --- | --- |
| T2.2 | `lib/progress/file-store.ts` | 高频写 + 未串行锁，损坏面最大 | M (1d) |
| T2.3 | `lib/goal/file-store.ts` | 同步 API，需同步 → 异步 | S (0.5d) |
| T2.4 | `lib/subagents/server-store.ts` | 同步 API + 静默吃错 | S (0.5d) |
| T2.5 | `lib/workflows/server-store.ts` | 已有部分护栏，只需接入 helper | S (0.5d) |
| T2.6 | `lib/tasks/store.ts` | 低频但仓 9 之一 | S (0.3d) |
| T2.7 | `lib/mcp/registry.ts` | 低频 | S (0.3d) |
| T2.8 | `lib/subagents/memory.ts` | 低频 | S (0.3d) |
| T2.9 | `lib/workflows/template-store.ts` | 低频 | S (0.3d) |
| T2.10 | `lib/workflows/skill-store.ts` | 低频 | S (0.3d) |

- **验收标准**（适用于所有 T2.x）：
  - 单测：骤发 100 次同 key 写入，最终文件可被 `JSON.parse`，且为最后一次写入的内容
  - 烟雾：单独启用本 store 后跑 npm test，不出现后退
- **灰度**：环境变量 `DIGA_ATOMIC_V2=0` 可回到老逻辑（保留一个发版后移除）

#### T2.11 多进程临时占位（选做）

- progress 高频写可选加跨进程锁（与 M5 合并考虑）。本里程碑默认不启，避免范围蔓延。

**M2 完工定义**：仓库全货源 9 处 `${fp}.tmp.${pid}.${Date.now()}` 字符串消失；`grep -r 'tmp.${' lib/` 返回空。

### 3.3 M3 · 生命周期一致性（Sprint 3，~5 人日）

**目标**：打造生命周期“开-关状态对称”与并发去重，与 M2 并行，不依赖 atomic helper。

#### T3.1 `createAgent` 入口 in-flight 去重（M1 / Top 3）

- **Finding**: 报告 3.2.1 M1
- **改动点**：
  - `lib/agent-registry.ts` 增加模块局部 `Map<string, Promise<CreateResult>>` (key 为归一化后的 sessionPath，无 sessionPath 则不去重)
  - 入口：命中现有 record 返回旧逻辑不变；未命中但命中 in-flight map 则 await 已存在 Promise
  - finally 必须从 map 删除该 key（无论抣出）。抣出时不缓存失败结果
- **验收标准**：
  - 并发单测：`Promise.all` 并发 10 次 `createAgent({ sessionPath: X })`，断言最终 `reg.agents.size` 仅增 1，且返回同一 record
  - 返回路径中一个抣出时，下一次调用不会拿到缓存抣出
- **工作量**：M（1 人日）

#### T3.2 DELETE 错误分类与 errno 透传（L1）

- **Finding**: 报告 3.1.3 / 3.2.3 L1
- **改动点**：
  - `app/api/sessions/[id]/route.ts:101-137` 在 unlink 失败时返回包体包含 `errno` 与 `code`
  - 调用 unlink 前试探 `await fs.access(t.path, fs.constants.W_OK)`，不可写直接返 207 且不 dispose
  - 207 partial 返回体增加 `inMemoryDisposed: boolean` 字段，让前端判断
- **验收标准**：
  - 单测 mock unlink 招 EBUSY 与 EACCES，返回体 errno 区分正确
  - 不可写时不调 dispose
- **工作量**：S（0.5 人日）

#### T3.3 孤儿 tmp / lock 启动清理（P1-4）

- **Finding**: 报告 3.1.5
- **改动点**：
  - 复用 T2.1 的 `cleanupStaleTmpFiles(dir)`，在各 store 的 hydrate 入口调一次
  - 进程启动时添加导出函数 `cleanupStaleSessionLocks()`，扫 `<root>/sessions/*.lock`，超 30s 全部 rm
  - 在 `lib/agent-registry.ts` 启动路径（或 Next.js instrumentation hook）调用一次
- **验收标准**：
  - 集成测试：预放 3 个 stale `*.tmp.*` + 1 个 stale `.lock`，启动后均被清理
- **工作量**：S（0.5 人日）

#### T3.4 孤悬 session 扫描任务骨架（P2-3 提前占位）

- **Finding**: 报告 3.1.5
- **改动点**：仅骨架，本里程碑不开启默认调用：
  - 新增 `scripts/maintenance/cleanup-orphan-sessions.ts`，迭代 `~/.diga-agent/**`，反查 `listAllSdkSessions()`，不存在者归档到 `~/.diga-agent/.archive/<date>/`
  - 仅提供 CLI。默认不接入启动路径。
- **验收标准**：人工跑 dry-run 输出被清理列表与总占用。
- **工作量**：M（1 人日）
- **状态**：M5 中进一步完善 + 上线

#### T3.5 `assertSafeSessionId` 等 ID 白名单收紧（L）

- **Finding**: 报告 3.1.2 L
- **改动点**：统一为 `^[A-Za-z0-9_\-]{1,128}$` 正则。定向 grep 出调用点，逐个检查是否允许带点号 / 中文（现状看 SDK 生成为 UUID，不影响）。
- **工作量**：S（0.3 人日）

### 3.4 M4 · Schema 演进规范（Sprint 4，~4 人日）

**目标**：把 `workflows/server-store.ts` 的 schema version + 迁移模式推广到 progress / goal，并产出内部规范。

#### T4.1 progress schema version（P1-3）

- **Finding**: 报告 3.1.1
- **改动点**：
  - `lib/progress/file-store.ts` 加 `PROGRESS_SCHEMA_VERSION = 1`
  - `sanitizeProgress` 检查 `version`，缺失补 1；`> CURRENT` warn 且拒读（返 null）
  - `< CURRENT` 预留 `migrateProgress(v, raw)` switch 表
- **验收标准**：
  - 单测：v0 老文件读出 = 迁移后结果；造一个 `version: 99` 的文件被拒读并 warn
- **工作量**：M（1 人日）

#### T4.2 goal `sanitizeEnvelope` 理解 `version`（P1-3）

- **Finding**: 报告 3.1.1
- **改动点**：
  - `lib/goal/file-store.ts:106-145` 中 `sanitizeEnvelope` 增加对 `version` 的读取，`version > CURRENT_VERSION` 返 null + warn（避免用旧版覆写新版）
- **验收标准**：伪造高版本文件测试不被读，也不被覆写
- **工作量**：S（0.5 人日）

#### T4.3 “store 编写规范”内部文档

- **Finding**: 报告 横切根因 3 / P2-6
- **交付**：`docs/contributing/store-conventions.md`，包含：
  - 必须使用 `lib/storage/atomic.ts`
  - 必须声明 schema version
  - 错误处理表：ENOSPC throw、ENOENT/EACCES warn、JSON corrupt warn+null
  - PR review checklist 5 项
- **工作量**：S（0.5 人日）

#### T4.4 SSE overrun 边界注释清理（P2-5）

- **Finding**: 报告 3.2.4
- **改动点**：`lib/agent-registry.ts:2403-2410` + `app/api/agent/[id]/events/route.ts:80-96`，把判定改为 `since + 1 < earliest`，与 `getEventsSince` 严格大于对齐；上方加一句注释说明半开 / 半闭语义
- **工作量**：S（0.3 人日）
- **验收**：原有 SSE 测试全过，额外补一个 `since === earliest - 1` 的 case

### 3.5 M5 · 长期可观察性 / 多进程 / 文档（Sprint 5+，~6 人日）

**目标**：补齐多进程、长期维护、运维可观察性。本里程碑依赖 M2/M4 落地后的稳定性，可延后。

#### T5.1 跨进程锁或单进程约束（P2-1）

- **Finding**: 报告 3.1.4
- **两条路线（二选一）**：
  1. 给 progress 加跨进程锁（复用 meta 目录锁模式，包装进 `lib/storage/atomic.ts`的 `withInterProcessLock(key)`）
  2. 明确“diga-agent 仅支持单进程运行”：启动时检测 `~/.diga-agent/process.lock`，存在且 pid 存活报错退出
- **推荐**：路线 2，工作量小且足够合业务现状
- **工作量**：路线 1: L (2-3d) / 路线 2: S (0.5d)

#### T5.2 meta 锁续期（P2-2）

- **Finding**: 报告 3.1.4 M
- **改动点**：`acquireMetaFileLock` 持锁期间每 10s `utimes(lockDir)` 续期，或锁内放 `pid + startTime` 文件用于 stale 判定
- **验收标准**：造一个 60s 事务 + 另一进程检测，不会被认为 stale 抢锁
- **工作量**：M（1 人日）

#### T5.3 孤悬 session 维护任务上线（P2-3）

- **Finding**: 报告 3.1.5
- **改动点**：在 T3.4 骨架上补齐 dry-run / archive / 定期调度（仅 CLI / 周期任务）
- **工作量**：M（1 人日）

#### T5.4 运维指标（P2-6）

- **Finding**: 报告 3.1.3 / 6.3
- **改动点**：接入进程内计数器，暴露 `/api/_internal/metrics`（只在 dev / inspect 模式）：
  - `[<store>]_persist_warn_total`
  - `createAgent_inflight_dedup_total`
  - `delete_partial_total`、`delete_errno_*`
  - `sse_state_reset_total`、`sse_ringbuffer_overrun_total`
- **工作量**：M（1 人日）
- **不接外部 metrics 后端**：以 JSON 输出供贴身 CI / 调试使用

## 4. 跨任务的横切设计决策

### 4.1 `lib/storage/atomic.ts` API 草案（M2 关键依赖）

```ts
// 公共 API
export interface AtomicWriteOptions {
  lockKey?: string;          // 默认 = filePath，提供 per-key 串行
  fsyncDir?: boolean;        // 默认 true
  retryOnMissingDir?: boolean; // ENOENT 时 mkdirp + 重试 1 次，默认 true
}

export async function atomicWriteJson(
  filePath: string,
  data: unknown,
  opts?: AtomicWriteOptions,
): Promise<void>;

export function withPerKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T>;

export async function cleanupStaleTmpFiles(dir: string, opts?: { ttlMs?: number }): Promise<number>;

// 错误：
//  - ENOSPC: 重新 throw（让上层 throw 给 UI）
//  - ENOENT (中间目录缺): mkdirp + 重试 1 次
//  - 其他: console.warn + throw
```

### 4.2 `assertTrustedSessionPath` 单点（M1 / 安全）

```ts
// lib/sessions.ts
export class TrustedSessionPathError extends Error {}

export async function assertTrustedSessionPath(p: string): Promise<string> {
  const resolved = path.resolve(p);
  const list = await listAllSdkSessions();
  const hit = list.find(s => path.resolve(s.path) === resolved);
  if (!hit) throw new TrustedSessionPathError("sessionPath not in trusted list");
  return resolved;
}
```

任何接收 `sessionPath` 的路由 / context 入口必须调用此函数；`POST /api/agent/new`、未来潜在的 import / mount 路由统一走该单点。

### 4.3 `finalizeAfterAbort(rec)` 与状态机对称表

定义所有"开"动作与对应"关"动作的对照清单（位于 `lib/agent-registry.ts` 顶部注释）：

| 开 | 关 | 触发清理点 |
| --- | --- | --- |
| `setFinishWatchdog` | `clearFinishWatchdog` | abort / dispose / finishStreamingRun |
| `setToolWatchdog` | `clearToolWatchdog` | abort / dispose / tool_end |
| `pendingFinishMessage = ...` | 置 null | abort / dispose |
| ringBuffer subscribe | unsubscribe | dispose |
| listAllSessions cache set | invalidate | DELETE / fork / 显式 API |
| store per-key lock acquire | 释放 | finally |

### 4.4 错误处理分类表（M1 + M4 文档输出）

| errno | 默认行为 | UI 表现 |
| --- | --- | --- |
| ENOENT (read) | 返回 null，不 warn | 视为"无该会话" |
| ENOENT (中间目录缺) | mkdirp 重试 1 次 | 透明 |
| ENOSPC | warn + throw | 弹错"磁盘空间不足" |
| EACCES / EPERM | warn + throw | 弹错"权限不足" |
| EBUSY | warn + throw（DELETE 路径返 207） | "请稍后重试" |
| EIO 等其他 | warn + throw | 通用错误 |
| JSON corrupt | warn + 返回 null | 视为"无该会话" |


## 5. 测试策略

### 5.1 单测覆盖矩阵（必加）

| 测试编号 | 关联任务 | 内容 |
| --- | --- | --- |
| UT-01 | T1.1 | `assertTrustedSessionPath` 命中 / 未命中 / 解析后路径相同 |
| UT-02 | T1.2 | abort 路径调用顺序断言（mock watchdog 清理函数） |
| UT-03 | T1.3 | `invalidateSessionListCache` 后下一次调用不命中缓存 |
| UT-04 | T1.4 | 5 个 store 的 ENOSPC throw / EACCES warn |
| UT-05 | T2.1 | 并发 100 写：内容可解析、wx 防撞、ENOSPC 传递、fsyncDir 调用 |
| UT-06 | T2.2-T2.10 | 每 store 一个并发写测试 |
| UT-07 | T3.1 | 并发 N=10 createAgent 同 sessionPath，仅产生 1 条 record |
| UT-08 | T3.2 | DELETE EBUSY/EACCES 错误码区分 |
| UT-09 | T3.3 | hydrate 时孤儿 tmp / lock 被清理 |
| UT-10 | T4.1 | progress v0 老文件迁移 / version > CURRENT 拒读 |
| UT-11 | T4.2 | goal envelope 高 version 不被读、不被覆盖 |
| UT-12 | T4.4 | SSE since === earliest-1 边界正确（不丢事件 / 不双发 reset） |

### 5.2 e2e / 集成测试

- E2E-01：`/api/agent/new` 携带任意路径 sessionPath → 400
- E2E-02：DELETE 后 50ms 内 GET `/api/sessions` → 不含
- E2E-03：goal active 下 message_end 后立即 abort → 2s 内不再 start_run
- E2E-04：5000+ 事件后 SSE 重连，且 since 落在 earliest-1 → state_reset 触发
- E2E-05：进程注入 stale tmp / lock，启动后清理

### 5.3 崩溃与并发故障注入

- 在 atomic helper 测试中注入：rename 之前 process.exit、handle.sync 之前 process.exit、ENOSPC、EACCES。
- 多进程模拟：在 CI 中 spawn 两个 node 进程并发写同 progress 文件，断言无 0 字节文件。

### 5.4 CI 集成

- 所有 UT 进 `npm test` 默认套件
- E2E 进 `npm run test:e2e`
- 在 PR pipeline 中阻断未通过的测试
- 故障注入测试归入 nightly（避免主 PR 拖时长）

### 5.5 灰度 / 线上监控

- M2 上线后 1 个发版周期内：观测 `[<store>]_persist_warn_total` 是否突增
- 观测 `createAgent_inflight_dedup_total`：若长时间为 0 说明前端没有触发并发，可视为无害；若有命中说明修复有效
- 观测 `delete_partial_total`：辅助识别用户环境权限问题


## 6. 回滚与风险

### 6.1 风险矩阵

| 任务 | 风险 | 缓解 |
| --- | --- | --- |
| T1.1 sessionPath 校验 | 误伤 SDK 尚未列出的新建 session | 在 listAll 之前若入参等于"待新建"也允许（需在路由层标 newSession 分支） |
| T1.2 abort 清 watchdog | 过早清理导致正常 finishStreamingRun 不执行 | 仅在 abort 分支清，且单测覆盖 message_end → finishStreamingRun 正常路径 |
| T1.3 缓存失效 | 多进程仅本进程失效 | 多进程问题归入 M5 解决，本任务文档化 |
| T1.4 加 warn | 日志噪音 | 用 throttle / 仅记 errno，不打 stack |
| T2.x 原子写改造 | 写盘路径基础设施回归 | feature flag `DIGA_ATOMIC_V2`，分 store 灰度，每个 store 一个独立 PR |
| T3.1 in-flight 去重 | 死锁（前一个 promise 不 resolve） | finally 必清 map；单测覆盖 reject 场景 |
| T4.1/T4.2 schema version | 版本号判断错误导致拒读全部数据 | 默认填充 CURRENT，仅"高版本"才拒读；单测覆盖 |
| T5.1 跨进程锁 / 单进程约束 | 误判旧进程导致启动失败 | 路线 2 用 pid 存活检测；提供 `--force-unlock` |

### 6.2 回滚方案

- M1（T1.x）：每个 PR 独立 revert，无数据迁移依赖。
- M2（T2.x）：通过 `DIGA_ATOMIC_V2=0` 环境变量回到旧逻辑（保留至少一个发版周期）。
- M4（T4.x）：schema version 改造仅在 sanitize 层加判断，旧代码读新数据时按"version 不存在"处理。回滚需注意：高版本数据不能被低版本进程写回——必须**先回滚写盘代码、再启用读盘代码**，否则下次进程会用旧 schema 覆写。

### 6.3 数据安全

- 任何涉及到 hydrate 结果改变 / schema 改变的 PR 必须在合并前：
  1. 备份测试用户的 `~/.diga-agent` 目录
  2. 跑一次"启动 → 操作 → 关闭 → 重启"完整闭环
  3. 校验关键字段（progress steps / goal status / subagents batch）数量与重启前一致

### 6.4 发布节奏建议

- M1 一周内独立发版（hotfix）
- M2 / M3 紧跟一个常规迭代（带 atomic flag default on，但提供回退）
- M4 与 M3 合并发版
- M5 独立排期，可与下一个版本同步推进


## 7. 验收 Checklist（PR Review Gate）

每个 P0 / P1 的 PR 在 review 时强制核对以下 7 项：

1. **是否使用 `lib/storage/atomic.ts` 的 helper**（新增 store 必须；老 store 修改写盘逻辑必须）
2. **是否声明 schema version**（envelope 必须含 `version` 字段）
3. **错误是否 warn 而非吞**（`catch {}` 必须至少 `console.warn(errno)`）
4. **ENOSPC 是否 throw 给上层**（不能静默吞）
5. **新增 setTimeout / subscribe / 持锁 / 缓存** → dispose / abort / DELETE 路径有无对称清理
6. **是否新增对应单测 / e2e**（无测试不合并）
7. **是否更新 `docs/contributing/store-conventions.md`**（如修改了规范本身）

对应 GitHub PR template 草案：

```
## 会话功能 PR Checklist
- [ ] 使用 lib/storage/atomic.ts 写盘（如适用）
- [ ] envelope 含 version 字段（如适用）
- [ ] 持久化错误 warn(errno)，ENOSPC throw
- [ ] 新增"开"动作有对应"关"动作
- [ ] 添加单测 / e2e 覆盖
- [ ] 更新对应文档
- [ ] revert 路径已验证（feature flag / 数据兼容）
```


## 8. 附录 · 任务 ↔ Finding 追溯矩阵

| Finding (报告章节) | 严重度 | 任务编号 | 里程碑 |
| --- | --- | --- | --- |
| H1 — sessionPath 路径越权（3.2.1） | 🔴 High | T1.1 | M1 |
| Top 2 / 3.1.2 — 9 处不安全 tmp 写 | 🟠 Medium | T2.1 + T2.2~T2.10 | M2 |
| Top 3 / 3.2.1 — createAgent 并发去重 | 🟠 Medium | T3.1 | M3 |
| Top 4 / 3.1.3 — IO 错误静默吞 | 🟠 Medium | T1.4 | M1 |
| Top 5 / 3.2.2 — abort 不清 watchdog | 🟠 Medium | T1.2 | M1 |
| 3.1.1 — progress 无 schema version | 🟠 Medium | T4.1 | M4 |
| 3.1.1 — goal envelope version 未生效 | 🟠 Medium | T4.2 | M4 |
| 3.1.2 — progress 无 per-id 锁 | 🟠 Medium | T2.1 + T2.2 | M2 |
| 3.1.2 — sync API + 无 fsync | 🟠 Medium | T2.3 / T2.4 / T2.5 | M2 |
| 3.1.3 — meta IO 错误未 warn | 🟠 Medium | T1.4 | M1 |
| 3.1.3 — subagents/goal/workflows 静默吞 | 🟠 Medium | T1.4 | M1 |
| 3.1.4 — meta 锁 stale 判定 | 🟠 Medium | T5.2 | M5 |
| 3.1.4 — 跨进程缺锁 | 🟠 Medium | T5.1 | M5 |
| 3.1.5 — 孤儿 tmp 文件 | 🟠 Medium | T3.3 | M3 |
| 3.1.5 — meta lock 残留 | 🟠 Medium | T3.3 | M3 |
| 3.1.5 — 孤悬 session 无清理 | 🟠 Medium | T3.4 → T5.3 | M3+M5 |
| 3.2.3 — listAllSessions 缓存失效 | 🟠 Medium | T1.3 | M1 |
| 3.1.2 — assertSafeSessionId 白名单 | 🟡 Low | T3.5 | M3 |
| 3.1.3 — DELETE errno 区分 | 🟡 Low | T3.2 | M3 |
| 3.2.3 — DELETE 部分失败 UX | 🟡 Low | T3.2 | M3 |
| 3.2.4 — SSE overrun 边界注释 | 🟡 Low | T4.4 | M4 |
| 3.1.1 — meta forward-compat (info) | ⚪ Info | — | — |
| 3.1.2 — meta atomic 写（标杆） | ⚪ Info | T2.1 复用 | M2 |
| 3.1.3 — meta JSON 损坏处理 | ⚪ Info | — | — |
| 3.1.4 — listAll 200ms 缓存（多进程） | ⚪ Info | T5.1 | M5 |
| 3.2.1 — ID 冲突 / 多进程实例 | ⚪ Info | T5.1 | M5 |

**统计**：13 个具名 finding 全部分配到任务；4 个 Info 项中 3 个被吸收进 M2/M5，1 个仅作参考。


# Session 功能审计报告

> 本报告由 4 个并行子审计员（HTTP API / 持久化与并发 / Runtime 与事件流 / UI 生命周期）的发现合并、去重、重新评级而成。原始分组发现保留在同目录 `session-audit-report.raw.md`。

## 0. 执行摘要

本次审计覆盖 diga-agent 仓库与 "session" 直接相关的四个面：HTTP API 路由、持久化/并发存储层、运行时事件流（agent-registry + ring buffer + SSE）、前端会话生命周期。**未发现 Critical 级问题**，但发现若干会让"会话状态"在前后端不一致或残留幽灵数据的 High 级缺陷。

### 总览

- 合并去重后 **Finding 总数：26 条**（原始 32 条，去重合并 6 条）。
- 严重度分布：
  - Critical：0
  - **High：5**
  - **Medium：11**
  - **Low：7**
  - **Nit：3**

### Top 5 优先项（建议立即处理）

1. **H-RT-1（合并 F-RT-1 + F-RT-2 + UI #1）** — `disposeAgent` / `finishStreamingAfterPromptError` / 前端显式删 session 都存在"streaming agent 没收到终态事件"的同源问题：父 record 提前删除、未补 `agent_end`、未级联 abort，导致前端 turn-state 卡 loading、sidebar batch 永远 running、SSE 客户端无对齐事件。建议统一抽 `forceFinishStream(rec, reason)` 并在 dispose 前 await abort。
2. **H-PER-1（原 P1）** — `deleteMeta` 不进 `metaUpdateChains` 也不取文件锁，与 in-flight `updateMeta` 并发会复活已删 meta，产生孤儿元数据文件。修复成本低（纳入同一锁链），收益高。
3. **H-UI-2（原 UI #2）** — `setPendingImages/Files` 走 `updateActive`，异步附件解析回调期间用户切 session 会把附件落到错误 runner，是用户可观察的数据错位。
4. **H-RT-3（原 F-RT-3）** — SSE 路由在 `getAgent(id)` 与 `onNewEvent(id, ...)` 之间的窗口内 agent 被 dispose，listener 永远注册不上，只靠 15s 心跳兜底，行为不一致。
5. **M-API-1（原 HTTP fork 非原子 + DELETE agent 与文件状态不一致 合并）** — fork 非事务化、DELETE 路由未保证 agent record 与磁盘 session 文件同步，是后续幽灵 session 的源头之一，与 H-PER-1 / H-UI-1 形成清理路径连锁。

### 跨层主线

四份子报告里反复出现的真正主线只有两条：

- **"会话终止"语义没有单一事实源**：HTTP DELETE、`disposeAgent`、`finishStreamingAfterPromptError`、前端 LRU fallback、orphan 清理、subagent abort 各自只做局部清理，事件流（SSE / runtime event-store）和持久层（meta / sdk session 文件 / optimistic store）经常各落一半。
- **跨调用的并发互斥不全**：原子写本身正确，但锁边界（`deleteMeta`、`writeMeta` 公开导出、lock 目录 stale 判定）和墓碑/TTL 的缺失（optimistic、event-store 的 agentId=null）使得"删除"在并发下可被回写复活。



## 1. HTTP API 层

> 范围：`app/api/agent/[id]/**`、`app/api/sessions/**`、`app/api/agent/new` 等会话相关路由共 6 个。鉴权统一用 `withRemoteAuth`（`/context` 例外但等价），路径穿越在 `lib/sessions.ts:resolveTrustedSessionPath` 已做白名单。

### M-API-1 | Medium | `app/api/agent/[id]/fork/route.ts`

- **触发条件**：用户在某 session 上点 fork，SDK `forkFrom` 已落盘新 session 文件，但随后写 branch meta / 注册 agent 阶段抛错。
- **影响**：fork 非原子。新 session 文件留在磁盘上，但 meta / agent record 缺失，下次 `listAllSdkSessions` 扫到会以"无 meta"形态出现，与孤儿清理路径耦合。
- **修复建议**：把 forkFrom + meta 写入 + agent 注册三步用 try/catch 包成补偿事务，失败时调用 SDK 删除已落盘新 session；或以 `pending` 标记 meta，注册成功后置 `ready`。

### M-API-2 | Medium | `app/api/agent/[id]/route.ts`（DELETE）

- **触发条件**：DELETE agent 路由删除 agent record，但磁盘 session 文件 / runtime event-store 残留。
- **影响**：与 H-PER-1、H-UI-1 串联——前端立即看不到 session，后台仍有 in-flight prompt / subagent batch 在写事件，下次冷启动 `listAllSdkSessions` 又把 session 扫回来形成幽灵。
- **修复建议**：DELETE 路径先 `disposeAgent(await)` → 等 abort/收尾事件 push 完 → 删 sdk session 文件 → 删 meta → 清 event-store 中相关 agentId 与"agentId=null 但 sessionId 匹配"的 RuntimeEvent。

### L-API-1 | Low | 鉴权写法不统一

- **文件**：6 个路由文件中 5 个用 `withRemoteAuth`，`/context` 路由直接读 header 自实现等价校验。
- **影响**：行为等价，但偏离单一事实源；后续若 `withRemoteAuth` 增加审计字段会被遗漏。
- **修复建议**：迁移 `/context` 到 `withRemoteAuth`。

### L-API-2 | Low | `meta` GET 缺存在性校验

- **触发条件**：GET `/api/agent/[id]/meta`，agent 不存在时返回空对象而非 404。
- **影响**：前端无法区分"无 meta"和"agent 不存在"，可能掩盖路由错配。
- **修复建议**：先 `getAgent(id)`，不存在直接 404。

### L-API-3 | Low | `/context` 路由 `path` 静默丢弃

- **触发条件**：调用者传非法或越界 path，路由按 trusted root 兜底但不告知。
- **影响**：调试体验差；潜在的安全审计盲点。
- **修复建议**：非法 path 返回 400 或在响应里回显 `effectivePath`。

### N-API-1 | Nit | 分页性能（未确认）

- 大量 session 下 `listAllSdkSessions` 全量读+排序+切片，未来可能成瓶颈。属推测性，未实测。

### N-API-2 | Nit | export 路径校验链路冗长

- `SAFE_SESSION_ID_RE` 白名单 + tmpdir 隔离 + `resolveTrustedSessionPath` 三重保护，安全足够，但代码重复，可抽工具函数。

### N-API-3 | Nit | DELETE 与 fork 共享的"补偿"逻辑分散

- 建议抽 `lib/sessions/transactions.ts` 集中。



## 2. 持久化与并发

> 范围：`lib/sessions.ts`、`lib/sessions/optimistic.ts`、`lib/sessions/unread.ts`、`lib/meta/store.ts`、`lib/runtime/event-store.ts`。原子写本身正确（tmp + write + fsync + rename + fsyncDir），问题集中在锁边界与墓碑/TTL。

### H-PER-1 | High | `lib/meta/store.ts` `deleteMeta`

- **触发条件**：在某 sessionId 上有 in-flight `updateMeta`（read-merge-write 中）时调用 `deleteMeta`。
- **影响**：`deleteMeta` 不进 `metaUpdateChains`、不取文件锁，与 `updateMeta` 的 write 阶段并发会复活已删 meta 文件，产生与 sdk session 不一致的孤儿元数据。叠加 M-API-2，前端 sidebar 长期看到"删不掉"或回闪的 session。
- **修复建议**：让 `deleteMeta` 走与 `updateMeta` 相同的 `metaUpdateChains` 串行链，并在链头检查"已被标记 tombstone"短路后续 update。

### M-PER-1 | Medium | `writeMeta` 公开导出无锁

- **文件**：`lib/meta/store.ts`
- **触发条件**：调用方绕过 `updateMeta` 直接 `writeMeta`。
- **影响**：破坏 read-merge-write 互斥，并发场景下丢字段。
- **修复建议**：把 `writeMeta` 降为 module 内私有；如需公开提供 `replaceMeta(sessionId, full)` 包装走锁链。

### M-PER-2 | Medium | lock 目录 stale 判定基于 mtime

- **文件**：`lib/meta/store.ts`（lock 实现）
- **触发条件**：长持锁的合法 holder（如大 meta 合并）超过 stale 阈值。
- **影响**：误抢锁，read-merge-write 互斥被破坏。
- **修复建议**：lock 内写 holder pid+随机 token，stale 判定改为"目录存在 + 锁文件 mtime 超阈值 + holder 进程不存活"三条件 AND；或改用 file-lock 库。

### M-PER-3 | Medium | event-store 仅按 agentId 清理

- **文件**：`lib/runtime/event-store.ts`
- **触发条件**：跨 agent 共享或 `agentId=null` 的 RuntimeEvent（如 workflow 顶层、subagent 收尾）。session 删除走 agentId 清理时这些会成为幽灵记录。
- **影响**：长期内存/磁盘膨胀；evidence 检索可能命中已删 session 的事件。
- **修复建议**：event 上同时索引 sessionId（含父 sessionId 链），按 (agentId ∪ sessionId) 清理。

### M-PER-4 | Medium | `upsertOptimisticSession` 无墓碑/TTL

- **文件**：`lib/sessions/optimistic.ts`
- **触发条件**：DELETE session 与 `/api/agent/new` 回调竞争。
- **影响**：DELETE 后回调把已删 session 重新写回 optimistic store，前端看到幽灵 session。
- **修复建议**：增加墓碑集（短 TTL，如 5min）；upsert 前查墓碑短路。

### L-PER-1 | Low | `enforceAgentCapacity` 双 O(N) 扫描

- **文件**：`lib/runtime/event-store.ts`
- **影响**：每次 append 走两遍 O(N)，高 QPS 下 CPU 浪费。
- **修复建议**：维护 per-agentId 计数 map。

### L-PER-2 | Low | `listAllSdkSessions` `.then` 缓存无 inflight 守卫

- **文件**：`lib/sessions.ts`
- **影响**：冷启动并发请求会触发重复全量扫描。
- **修复建议**：用 inflight Promise 单例。

### L-PER-3 | Low | `isSessionUnread` 依赖跨端时钟一致

- **文件**：`lib/sessions/unread.ts`
- **影响**：客户端时钟漂移 / 字典序 fallback 在边界时间产生假阳/假阴。
- **修复建议**：以服务端单调时钟为准；或加 ±N 秒容差。



## 3. Runtime 与事件流

> 范围：`lib/agent-registry.ts`、`app/api/agent/[id]/events/route.ts` 及 ring buffer / SSE 链路。本节是本次审计 High 级问题最集中的区域，三个 High 实际上同源——"streaming 终止时事件未被推到客户端"。

### H-RT-1 | High | `lib/agent-registry.ts:2326-2360` `disposeAgent`

- **触发条件**：父 agent 仍有进行中的 subagent batch / workflow 时调用 `disposeAgent`（删 session、切 cwd、关 tab、HTTP DELETE 都会进入）。
- **影响**：`abortSubagentsForParent` / `abortWorkflowsForParent` 是 fire-and-forget。函数返回前 `reg.agents.delete(id)` 已执行，子 batch 真正 abort 完成后想 `pushParentEvent` / `pushExternalEvent` 推 `subagent_task_end` / `subagent_batch_end` / `workflow_*` 时父 record 已不在 map 中——**收尾事件直接丢失**。前端 sidebar batch 卡片永远 running。
- **修复建议**：把两个 abort 改为 `await`，或暴露 `disposeAgentAsync`；dispose 路径在 abort 收尾后再 `reg.agents.delete(id)`，并在 dispose 末尾 push 一条兜底 `agent_end`。

### H-RT-2 | High | `lib/agent-registry.ts` `finishStreamingAfterPromptError` (~2398-2415)

- **触发条件**：goal 续跑路径 `maybeContinueGoal` 中 `rec.session.prompt(...)` 抛错；或其他 prompt 异常。
- **影响**：函数翻 `isStreaming=false` 但**不 push `agent_end`**。前端 reducer 的 streaming 终止依赖 `agent_start/agent_end`，因此用户气泡卡 pending、最后一条 assistant chrome 留在 `compact/live`（参见 `lib/turn-state.ts:deriveTurnChromeState`）。这是"turn-state 卡 loading"主线最直接的命中点。
- **修复建议**：在该函数内 `pushAgentEvent(rec, { type: "agent_end", reason: "prompt-error", ... })`（必要时先 `message_end`）。与 H-RT-1、H-RT-3 抽公共 `forceFinishStream(rec, reason)`。

### H-RT-3 | High | `app/api/agent/[id]/events/route.ts:106-118` 心跳/flush 与 dispose 竞态

- **触发条件**：SSE 路由在 `getAgent(id)` 与 `onNewEvent(id, ...)` 之间窗口 agent 被 dispose。
- **影响**：`onNewEvent` 在 agent 不存在时返回**空 noop**，listener 永远注册不上，只有 15s 心跳兜底。这条路径与 H-RT-1 的事件丢失叠加，前端在 dispose 与重新订阅之间会"丢掉"完整一段事件。
- **修复建议**：SSE start 时再次 `isAgentDisposed(id)` 校验；`onNewEvent` 在 agent 不存在时返回特殊 sentinel 让调用方立即 close；缩短心跳到 5s 以快速发现失效订阅。

### M-RT-1 | Medium | `app/api/agent/[id]/events/route.ts:62-74` cancel/closeStream 重复清理

- **触发条件**：浏览器在 `closeStream` 已执行后再触发 `cancel`，或 `safeEnqueue` 与 cancel 并发。
- **影响**：清理幂等无致命问题，但 `safeEnqueue` 仅以 `closed` flag 防护，并发场景下可能向已 cancel 的 controller 调 enqueue 后再被 catch 置位，行为可观察。
- **修复建议**：把 `closeStream` 抽到 start 外层 closure，cancel 复用同一个；`safeEnqueue` 写入前 short-circuit `controller.desiredSize === null`。可降为 Low。

### M-RT-2 | Medium | hot-reload 下 ring buffer handler 引用旧模块

- **触发条件**：Next dev 模式 hot-reload。
- **影响**：`reg.agents` 在 globalThis，但 `pushAgentEvent` / `mirrorRuntimeEvent` 闭包是旧 module 的；老 agent 的 SDK 事件继续走旧函数，dev 下 SSE 序号 / runtime evidence 可能错乱。生产无影响。
- **修复建议**：dev 下 hot-reload 钩子里强制重建老 agent，或把 event-store map 也固定到 globalThis（需确认是否已做）。**未确认**。

### M-RT-3 | Medium | `releaseManagersForCwdIfUnused` 在 dispose 中线性扫描

- **文件**：`lib/agent-registry.ts` `disposeAgent` 内调用
- **影响**：每次 dispose O(N) 扫所有 agents 判断 cwd 是否仍被引用，N 大时是显著开销；且与 H-RT-1 的 `reg.agents.delete` 顺序耦合（删之前/之后扫到不同结果）。
- **修复建议**：维护 `cwd -> agentCount` 反向索引；dispose 中 decrement 到 0 时再释放。

### L-RT-1 | Low | dispose 不发"最终 agent_end"兜底

- 与 H-RT-1 关联但作为独立改进项保留：即便所有 abort 已 await，dispose 仍应推一条 `agent_end{ reason: "disposed" }` 让客户端 reducer 收敛。

### L-RT-2 | Low | watchdog 清理路径分散

- `clearFinishWatchdog` / `clearToolWatchdog` 在多处分别调用，建议合并到 `forceFinishStream`。



## 4. UI 会话生命周期

> 范围：`ChatApp.tsx`、`useSessions.ts`、`useRunners.ts`、`input-store.ts`、`electron-bridge.ts`。本节问题分两簇：① 显式删 session 不级联 abort（与 H-RT-1 同源）、② 切 session 时附件/SSE/banner 状态错位。

### H-UI-1 | High | 显式删 session 不发 abort（`useSessions.ts` 删除分支）

- **触发条件**：用户从 sidebar 显式删除当前 streaming session。
- **影响**：前端只发 DELETE 并本地清理，未先 abort runner；与 orphan 清理路径（后者会先 abort）不一致。后端 `disposeAgent` 又是 fire-and-forget abort（H-RT-1），叠加导致后台仍在跑的 prompt 把事件写到已删 agent record 上后悄无声息丢失。
- **修复建议**：UI 删除前先 `runner.abort()` 等 `agent_end` 或固定超时 → 再 DELETE。后端 DELETE 路由也应等价（见 M-API-2）。

### H-UI-2 | High | `setPendingImages/Files` 走 `updateActive`（`input-store.ts`）

- **触发条件**：`addImageFiles` / `addPathAttachment` 异步解析期间用户切到其他 session。
- **影响**：异步回调拿到的"active"已变更，附件被写入错误 runner 的 pendingImages/Files。是用户可观察的数据错位（"我贴的图跑到别的会话去了"）。
- **修复建议**：异步任务启动时 capture 起始 `sessionId`/`runnerId`，回调内通过 `updateById(sessionId, ...)` 写入；目标 session 已销毁则丢弃并提示。

### M-UI-1 | Medium | 切 session 时旧会话仍 streaming 无任何提示

- **文件**：`ChatApp.tsx` / `useSessions.ts`
- **影响**：用户切走后旧会话继续跑，新会话叠加 LRU fallback（M-UI-2）可能静默关 SSE，回切时看不到新事件。
- **修复建议**：切走时若旧 session streaming，保留其 SSE 订阅或在回切时自动 reattach；UI 上小红点提示。

### M-UI-2 | Medium | LRU fallback 不过滤 streaming/pending

- **文件**：`useRunners.ts`
- **影响**：LRU 淘汰路径未排除"正在 streaming"或"有 pendingImages/Files"的 runner，导致丢内存附件、断 SSE。
- **修复建议**：LRU 选择函数加 `isEvictable(runner)` 过滤。

### M-UI-3 | Medium | `refreshSessions` orphan 清理只处理 active runner

- **文件**：`useSessions.ts`
- **影响**：后台僵尸 runner（已 evict 但仍持 SSE）不会被清理。
- **修复建议**：把"所有 runner"作为遍历集合，按 sessionId 与服务端列表 diff 决定 dispose。

### M-UI-4 | Medium | cold-start `/context` fetch 无 cleanup/cancel

- **文件**：`ChatApp.tsx` 初始化
- **影响**：组件 unmount 或快速切 session 时旧 fetch 错误信息会污染全局 banner。
- **修复建议**：用 `AbortController` 关联 effect 生命周期；错误判断当前 sessionId 是否仍是发起时的那个。

### L-UI-1 | Low | `startNewSession` 重复 `setRunner`/`switchTo`

- **文件**：`useRunners.ts`
- **影响**：注释说只调一次，实际调两次且顺序导致首屏闪烁。
- **修复建议**：合并为一次调用，调整顺序：先 setRunner 再 switchTo。

### L-UI-2 | Low | Electron 桥两条路径生命周期不一致

- **文件**：`electron-bridge.ts`
- **影响**：pet listener 因依赖 `sessions` 反复 unsub/sub；IPC 缓冲是否丢消息**未确认**。
- **修复建议**：把 listener 注册改为只依赖稳定 ref；或用 `useEvent` 模式。



## 5. 未覆盖 / 需进一步复核

本次审计**未覆盖**或**仅作行为级核对**的范围，列在下方供后续轮次跟进：

1. **SDK 内部行为**：`SessionManager.forkFrom` 是否在内部 fsync、`appendSessionInfo` 的并发语义未读源码确认（参考 `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts` 仅看类型）。M-API-1 中"branch 抛错前 forkFrom 已落盘"的细节标"未确认"。
2. **下游模块自身健壮性**：`resolveTrustedSessionPath` / `findSessionPathById` 仅做了行为级核对，未审 `listAllSdkSessions` 反序列化的容错（部分 session 文件损坏时是否影响其余）。
3. **运行期实证**：H-PER-1 / M-PER-2 / M-PER-3 / M-PER-4 / M-RT-2 等 finding 缺乏运行期日志或复现样本，本次只论证"逻辑层缺口存在"，未量化命中频率。
4. **跨子任务范围**：`useChatStream` 中"草稿 → 真实 session"的 input-store rekey 流程不在 UI 子任务范围；H-UI-2 的修复需与该流程对齐。
5. **event-store 持久化**：本次只审了内存 ring buffer / map 部分，磁盘落盘策略（如有）未审。
6. **dev hot-reload**：M-RT-2 中"event-store 是否也用 globalThis"未在本范围内确认。
7. **分页性能**：N-API-1 大量 session 下的实际响应耗时未实测。
8. **鉴权审计字段**：L-API-1 中 `withRemoteAuth` 是否记录鉴权审计日志、`/context` 自实现是否同步记录，需后续 review。

> 上述项不影响当前 finding 结论，但若后续要把 High 全部修掉，建议先补这些点的实证数据再设计修复方案。



## 6. Finding 索引表

> 列出全部 26 条 finding。`原编号` 列指向四份子报告中的原始编号，便于回溯。

| ID | 严重度 | 文件:行号 | 触发条件 | 影响 | 修复建议 | 原编号 |
|---|---|---|---|---|---|---|
| H-RT-1 | High | `lib/agent-registry.ts:2326-2360` | 父 agent 仍有进行中 subagent/workflow 时调用 dispose | 收尾事件丢失，sidebar batch 永远 running | abort 改 await；dispose 末尾兜底 push `agent_end` | F-RT-1 |
| H-RT-2 | High | `lib/agent-registry.ts:~2398-2415` | goal 续跑或 prompt 抛错走 `finishStreamingAfterPromptError` | 不 push `agent_end`，前端 turn-state 卡 loading | 函数内补 `agent_end`；抽 `forceFinishStream` | F-RT-2 |
| H-RT-3 | High | `app/api/agent/[id]/events/route.ts:106-118` | `getAgent`→`onNewEvent` 间隙 agent 被 dispose | listener noop，仅靠 15s 心跳兜底 | start 时再校验；`onNewEvent` 返回 sentinel | F-RT-3 |
| H-PER-1 | High | `lib/meta/store.ts` `deleteMeta` | 与 in-flight `updateMeta` 并发 | 复活已删 meta，孤儿元数据 | 纳入 `metaUpdateChains` 串行 | P1 |
| H-UI-1 | High | `useSessions.ts` 删除分支 | 显式删 streaming session | 不级联 abort，事件被悄默丢 | 删除前先 abort 等 `agent_end` | UI #1 |
| H-UI-2 | High | `lib/sessions/input-store.ts` `setPendingImages/Files` | 异步附件回调期间切 session | 附件落到错误 runner | capture sessionId；`updateById` 写入 | UI #2 |
| M-API-1 | Medium | `app/api/agent/[id]/fork/route.ts` | fork 中途抛错 | 新 session 文件落盘但 meta/agent record 缺失 | 三步打包成补偿事务 | HTTP #1 |
| M-API-2 | Medium | `app/api/agent/[id]/route.ts` (DELETE) | DELETE agent | agent record 删但磁盘/事件残留 | DELETE 走 `disposeAgentAsync`+清 event-store | HTTP #4 |
| M-PER-1 | Medium | `lib/meta/store.ts` `writeMeta` 公开 | 调用方绕过 `updateMeta` | 破坏 read-merge-write 互斥 | 改私有或包成 `replaceMeta` 走锁链 | P2 |
| M-PER-2 | Medium | `lib/meta/store.ts` lock | 长持锁合法 holder 超阈值 | 误抢锁 | holder pid+token；活进程检测 | P3 |
| M-PER-3 | Medium | `lib/runtime/event-store.ts` | session 删除涉及 agentId=null 事件 | 幽灵 RuntimeEvent | 索引 sessionId，按并集清理 | P4 |
| M-PER-4 | Medium | `lib/sessions/optimistic.ts` `upsertOptimisticSession` | DELETE 与 `/api/agent/new` 回调竞争 | 复活幽灵 session | 加墓碑+TTL | P8 |
| M-RT-1 | Medium | `app/api/agent/[id]/events/route.ts:62-74` | cancel/closeStream 重复路径 | enqueue 到已 cancel controller | 抽 closeStream；desiredSize 短路 | F-RT-4 |
| M-RT-2 | Medium | `lib/agent-registry.ts` (globalThis) | Next dev hot-reload | ring buffer handler 引用旧模块 | dev 重建 agent；event-store 入 globalThis | F-RT-5 |
| M-RT-3 | Medium | `lib/agent-registry.ts` `releaseManagersForCwdIfUnused` | 每次 dispose | O(N) 扫描 + 顺序耦合 | 维护 cwd→count 反向索引 | F-RT-6 |
| M-UI-1 | Medium | `ChatApp.tsx`/`useSessions.ts` | 切 session 时旧会话 streaming | 无提示，叠加 LRU 静默断 SSE | 保留订阅或回切 reattach | UI #3 |
| M-UI-2 | Medium | `useRunners.ts` LRU | LRU 淘汰未过滤 streaming/pending | 丢附件断 SSE | `isEvictable` 过滤 | UI #4 |
| M-UI-3 | Medium | `useSessions.ts` `refreshSessions` | orphan 清理 | 后台僵尸 runner 不清 | 遍历所有 runner diff | UI #5 |
| M-UI-4 | Medium | `ChatApp.tsx` cold-start `/context` | unmount/快速切 session | 旧 fetch 错误污染 banner | AbortController + sessionId 校验 | UI #6 |
| L-API-1 | Low | 6 个路由 | 鉴权写法 | 未统一 `withRemoteAuth` | `/context` 迁移 | HTTP #2 |
| L-API-2 | Low | `app/api/agent/[id]/meta/route.ts` GET | agent 不存在 | 返回空对象而非 404 | 先 `getAgent` | HTTP #3 |
| L-API-3 | Low | `app/api/agent/[id]/context/route.ts` | 非法 path | 静默丢弃 | 返回 400 或回显 | HTTP #6 |
| L-PER-1 | Low | `lib/runtime/event-store.ts` `enforceAgentCapacity` | 每次 append | 双 O(N) 扫描 | per-agent 计数 map | P5 |
| L-PER-2 | Low | `lib/sessions.ts` `listAllSdkSessions` | 冷启动并发 | 无 inflight 守卫 | inflight Promise 单例 | P6 |
| L-PER-3 | Low | `lib/sessions/unread.ts` `isSessionUnread` | 跨端时钟漂移 | 假阳/假阴 | 服务端时钟为准 | P7 |
| L-RT-1 | Low | `lib/agent-registry.ts` `disposeAgent` 末尾 | 任何 dispose | 缺最终 `agent_end` 兜底 | dispose 推 `agent_end{reason:"disposed"}` | 衍生 |
| L-RT-2 | Low | `lib/agent-registry.ts` watchdog | 多处分别 clear | 清理路径分散 | 合并到 `forceFinishStream` | 衍生 |
| L-UI-1 | Low | `useRunners.ts` `startNewSession` | 新建 session | 重复 setRunner/switchTo | 合并一次；调顺序 | UI #7 |
| L-UI-2 | Low | `lib/electron-bridge.ts` | 两条路径不一致 | pet listener 反复 unsub/sub | 解耦依赖 | UI #8 |
| N-API-1 | Nit | `app/api/sessions/list/route.ts` | 大量 session | 分页性能（未实测） | 未来优化 | HTTP #8 |
| N-API-2 | Nit | export 路径 | 路径校验链路 | 三重保护代码冗余 | 抽工具函数 | HTTP 衍生 |
| N-API-3 | Nit | DELETE / fork | 补偿逻辑 | 分散 | 抽 `lib/sessions/transactions.ts` | HTTP 衍生 |

---

> **审计输出统计**：本报告字数与 finding 总数已在第 0 节列出。原始分组报告保留在 `docs/session-audit-report.raw.md`。


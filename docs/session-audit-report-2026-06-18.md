# 会话功能审核 · 复核报告（2026-06-18）

> 在 2026-06-17 报告基础上做的"差异化复核"。重点说明：上次列出的问题哪些已修、哪些只修了一半、哪些仍未动；同时补充本轮新发现。

## 总体结论

- **服务端 API 是这一周修得最干净的一块**：6-17 报告里高/中风险的服务端项（meta 并发丢字段、错误信息泄漏、context 路径越权、fork 锚点错位、DELETE 级联与 dispose）都已通过 commit `442f2bf` 落地。
- **仍有相当一批上次列出的问题没动手**，集中在「前端 hooks + chat-reducer + agent-registry」一侧；其中 1 个高风险（H1：subagent 历史永远查不出来），用户能直接感知。
- **本轮新发现 3 处**，最严重的是 agent route 顶层 catch 把 `error.message + stack` 整段返回给客户端，绕过了已修的 S3 净化原则。
- 没有发现新的高危安全问题，未修项更多是体验断层和审计日志失真，不影响数据正确性。

短期建议优先处理：H1、N1（新发现 stack 泄漏）、M2（未读判定不一致）、M11（删除 race）、M1（runtime 卡"运行中"）。其余排进周内迭代即可。

---

## 一、上次报告问题的当前状态

记号：✅ 已修　🟡 部分修　❌ 未修

### 高严重等级
| 编号 | 问题 | 状态 | 证据 |
|------|------|------|------|
| H1 | context 路由把 sessionId 当 sessionPath 传，subagent 历史永远空 | ❌ 未修 | `app/api/sessions/[id]/context/route.ts:91` 仍是 `listBatchesByParentSessionPath(id)` |

### 中严重等级
| 编号 | 问题 | 状态 | 证据 |
|------|------|------|------|
| M1 | agent crash / SDK 抛错时 isStreaming 永远 true，sidebar "运行中"挂死 | ❌ 未修 | `lib/agent-registry.ts:517` await `rec.session.prompt()` 未挂兜底；watchdog 仍只在 `message_end` 时启 |
| M2 | sidebar 与 pet 弹窗对"未读"判定不一致 | ❌ 未修 | `app/hooks/usePetPusher.ts:358,410` 仍 `seenAt < sess.modified` |
| M3 | DELETE 级联非原子，部分失败留下不一致 | 🟡 部分修 | 442f2bf 改善了错误吐出与日志，但 unlink 失败仍照常 deleteMeta / deletePersistedProgress；"jsonl 还在但 meta 已删"窗口保留 |
| M4 | DELETE 与活跃写入存在 race（dispose 不 await fd close） | 🟡 部分修 | 442f2bf 让 disposeAgent 标 disposed + 唤醒 listener，SSE 收口提前；但仍未真正 await writer close，Windows EBUSY / POSIX 尾巴写入仍可能漏 |
| M5 | fork 的 targetEntryId 仅判空，不校验归属 | ❌ 未修 | `app/api/sessions/[id]/fork/route.ts` 仅 `typeof === 'string' && !empty` |
| M6 | fork route 重复 listAll，detail 为 null 时错误码 500 应为 404 | ❌ 未修 | 同上文件 |
| M7 | context 路由信任客户端 path query | ✅ 已修 | 引入 `resolveTrustedSessionPath` 先精确匹配可信清单 |
| M8 | 重命名 PATCH 没有长度 / 频率校验 | ❌ 未修 | `app/api/sessions/[id]/route.ts:43` 仅 `trim()` |
| M9 | useSessions 标记已读形成 PATCH 风暴 | ❌ 未修 | `useSessions.ts:322` deps 仍带 `[sessions, selectedId, ...]`，每帧 token 都触发 |
| M10 | SSE onerror 立即 lost、无防抖、无主动重连 | 🟡 部分修 | 已加指数退避（5/10/30s）自动重连；但 onerror 仍即时切 lost，瞬断闪烁问题保留 |
| M11 | executeDeleteSession 用闭包 selectedId，与 refreshSessions 用 ref 不一致 | ❌ 未修 | `useSessions.ts` deps 仍 `selectedId` |
| M12 | reducer 收到 `subagent_batch_detached` 没有 case，detach 卡片卡死 | ❌ 未修 | `lib/chat-reducer.ts` 仍只覆盖 start / end；useAgentEvents 已派发但走 default |
| M13 | tool_execution_end / update 在 active assistant 已关闭时凭空造空气泡 | ❌ 未修 | `lib/chat-reducer.ts:1147,1554` 仍走 `replaceActive` → `ensureAssistant` |

### 低严重等级
| 编号 | 问题 | 状态 |
|------|------|------|
| L1 / L2 | 审批 timeout 误判 + 7 处复制粘贴未抽公共函数 | ❌ 未修 |
| L3 | recentClientRequests 不主动清过期 | ❌ 未修 |
| L4 | listAll 多处并发重复扫盘 | ❌ 未修 |
| L5 / L6 | stub session cwd 空字符串 / optimistic `||` 处理 path | ❌ 未修 |
| L7 | context 恢复 progress 时 race 窗口 | ❌ 未修 |
| L8 | `/api/sessions` GET 未走 withRemoteAuth 装饰器 | ❌ 未修 |
| L9 | export route Content-Disposition 拼未净化 id | ❌ 未修 |
| L10 | refreshSessions catch 完全静默 | ❌ 未修 |
| L11 ~ L18 | reducer / hooks 一系列小型杂项 | ❌ 未修 |

### 服务端 S 系列（442f2bf 集中修复）
S1（meta race，引入 `updateMeta` per-id 锁）、S3（错误信息净化，`internalErrorResponse`）、S4（context path 越权）、S6（fork 锚点 / aside 用户气泡对齐）、服务端 M1（subagent batch 孤儿）、服务端 M2（interrupted 误判）、服务端 M5（disposeAgent 唤醒 listener）— 全部 ✅ 已修，且配套有单测。


---

## 二、本轮新发现

### N1【高】agent route 顶层 catch 把 stack 整段返回客户端
- **位置**：`app/api/agent/[id]/route.ts:888-892`
- **现象**：所有 action 走完 switch 后的兜底 catch：
  ```ts
  return NextResponse.json(
    { error: (e as Error).message, stack: (e as Error).stack },
    { status: 500 }
  );
  ```
  既回了原始 message（含绝对路径、cwd、内部模块名），又回了完整 `stack`。
- **影响**：和 sessions 路由刚刚完成的 S3 净化原则正面冲突；远程入口下任何能触发 500 的输入都能拿到服务器目录结构 / Node 内部栈帧，是事实上的信息泄漏旁路。
- **建议**：和 sessions 路由统一走 `internalErrorResponse(e, { scope: 'POST /api/agent/[id]' })`，真错误写 server log；客户端只看到 generic message + `requestId`。

### N2【中】DELETE 流程仍非原子：unlink 失败照样删 meta / progress
- **位置**：`app/api/sessions/[id]/route.ts` DELETE handler 内的 `for (const t of targets)` 循环
- **现象**：commit 442f2bf 改进了错误吞吐和 errno 净化，但循环体里 unlink 失败只 push 到 `errors` 数组，紧接着仍然执行 `deleteMeta(t.id)` / `deletePersistedProgress(t.id)` / `removeBatchesByParentSessionPath(t.path)`。
- **影响**：jsonl 因权限 / 占用没删掉，但 meta（pinned / title / lastSeenAt）和 runtime progress 已经被清；下次 list 这条 session 突然"失忆"——前端体验是"重命名没了"+"进度没了"+"还能看到对话"。
- **建议**：unlink 失败即 `continue`，跳过本目标的 meta / progress / batches 清理；只对成功 unlink 的目标做后续清理。

### N3【中】SSE `onerror` 即时切 lost，无短暂错误防抖
- **位置**：`app/hooks/useSseManager.ts` 约 L310
- **现象**：自动重连已加（指数退避），但 `onstatusChangeRef.current(key, { sseStatus: 'lost' })` 仍在 onerror 立即调用。瞬断（idle timeout / 5xx 重试）会反复闪 "连接丢失" 提示。
- **影响**：用户对"是否还连得上"产生不信任；和实际"几秒后自动恢复"的体验脱节。
- **建议**：onerror 时只把 status 切到中间态 `degraded`（或 1~2 秒延时再切 lost），重连成功立即回 active；多次失败再升到 lost。

### 一些"看了但没问题"的点（也记一笔）
- 多处 `setSelectedId(null)` + `switchTo(DRAFT_KEY)` 的状态切换路径在 `executeDeleteSession` 里目前仍依赖闭包变量（M11），但 ChatApp 顶层的 sessionList polling + visibilitychange refresh 会兜底，正常使用很难命中残留高亮的窗口。M11 仍建议修，但优先级可以排在 H1 / N1 之后。
- `useSseManager` 对 `lastSeqRef` 的清理改成了"unmount 时统一清"，已实质修复了上次 L14（同 key 重 attach 丢断点续传）。
- `useSessions` 已给 `sameSessionList` 比较加上 lastSeenAt，有效防止 markSessionSeen 自循环。

---

## 三、按修复成本与影响分级

### 强烈建议短期内修
1. **H1**（context 路由 sessionId 当 path 用）—— 一行替换：先 `findSessionPathById(id)` 再传 path。一次几分钟，但用户感知最强烈（subagent 历史看不到）。
2. **N1**（agent route stack 泄漏）—— 替换为 `internalErrorResponse`，与 sessions 路由保持一致。半小时。
3. **M2**（sidebar / pet 未读判定不一致）—— `usePetPusher` 切到 `isSessionUnread`，统一未读来源。1 小时（含双端 e2e 验证）。
4. **N2 / M3**（DELETE 部分失败清理顺序）—— 在循环里 unlink 失败 `continue`，半小时。
5. **M11**（executeDeleteSession 闭包不一致）—— deps 改用 `selectedIdRef.current`，10 分钟。

### 本周排期
- **M1**：在 `agent-registry` 的 `prompt()` 之后挂 `.catch(() => finishStreamingRun(rec))` 兜底；scheduleFinishWatchdog 在 agent_start 时也挂一个 60s "心跳超时"。0.5 天。
- **M5 / M6**：fork 校验 targetEntryId 命中 forkable user message + 合并 listAll。0.5 天。
- **M8**：rename PATCH 加 200 字符上限 + 同名跳过 append。0.5 小时。
- **M9**：markSessionSeen 比较时若 prev ≥ cur.modified 直接短路；effect 改成 `[selectedId]` 触发 + focus 事件主动调一次。0.5 天。
- **M12**：reducer 补 `subagent_batch_detached` case，把对应 part 标 detached/running。1 小时。
- **M13**：tool_execution_end / update 改为"先在所有 assistant 倒序找 toolCallId"，找不到 `return state`。0.5 天 + 单测。

### 长期 / 顺手修
- **N3 / M10 防抖**：onerror 加 1.5s 延时切 lost。0.5 天（含手感校准）。
- **L1 / L2**：抽 `runApproval(rec, partialReq, source)` 并把 7 处审批模板合并；ApprovalResponse 增 `source` 字段。1 天。
- **L4**：给 `SessionManager.listAll()` 加 200ms in-flight dedupe / 内存缓存。0.5 天。
- **L9**：export route 用 `encodeURIComponent` 净化 id（虽然 SDK id 是 UUID，仍按防御性补）。10 分钟。
- **L15**：reducer 不再调 `Date.now()`，改由事件携带 `at`。1 天（含事件源全量调整）。

---

## 四、未发现 / 已确认合理的关键路径

- 服务端 meta 写入用 tmp + rename 原子提交，且 PATCH 已走 per-id 锁；并发改不同字段不再丢字段。
- DELETE 路径已先 dispose 内存中所有指向 targetPaths 的 agent record（含 hidden child agents），再 unlink。
- context 路由对 tail / before / limit 做了 `Number.isFinite + clamp`，分页时不附带 forkableUserMessages 和 progress（避免大 payload）。
- `getSessionContextTailByPath` / `getSessionContextPageByPath` 内部用 `sm.getSessionId() !== expectedId` 做事后兜底校验。
- `metaFilePath` 拒绝带 `/`、`\`、`..` 的 sessionId，挡住 path traversal。
- `collectSessionDescendants` 用 BFS + visited，避免环导致死循环；DELETE 级联现在依赖它做祖孙清理。
- SSE 已实现指数退避自动重连 + 主动关闭 / unmount 时清理 reconnect timer，避免"幽灵重连"。
- `useSessions.sameSessionList` 把 `meta.lastSeenAt` 计入比较，防止 markSessionSeen 自循环。
- chat-reducer 主路径（message_start / text_delta / message_update / message_end / agent_start / agent_end / approval_resolved）都被单测覆盖。

---

## 附：本次复核覆盖范围

- 服务端：`app/api/sessions/**`（route / context / fork / meta / export）+ `app/api/agent/[id]/route.ts`
- 持久化：`lib/sessions.ts` / `lib/sessions/optimistic.ts` / `lib/meta/store.ts` / `lib/progress/file-store.ts` / `lib/subagents/server-store.ts`
- 运行时：`lib/agent-registry.ts`（prompt / dispose / approval / watchdog）/ `lib/runtime/agent-event-bridge.ts`
- 前端：`app/hooks/useSessions.ts` / `app/hooks/useSseManager.ts` / `app/hooks/useChatStream.ts` / `app/hooks/useAgentEvents.ts` / `app/hooks/usePetPusher.ts`
- Reducer：`lib/chat-reducer.ts`

未覆盖（不在"会话"主线上，留给后续单独审）：subagents orchestrator 自身的状态机、workflow 脚本运行时、collab / evidence 模块、Electron 主进程对会话事件的转发。


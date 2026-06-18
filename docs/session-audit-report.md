生成时间：2026-06-17

# 会话功能审核报告

## 总体结论

整体架构健康、单元测试覆盖核心路径，但围绕“多人/多端协作 + 长跑会话 + 流式事件”这条主线，发现一批中等级别隐患，集中在三处：
1) **状态一致性**：sidebar 未读判定、pet 弹窗未读判定、agent 运行态判定各走各的字段，长会话里会出现“sidebar 已读但 pet 还提醒”“agent 崩了但前端永远转圈”这类用户能感知到的体验断层。
2) **错误/异常路径过于宽容**：abort 失败、SSE 断开、refreshSessions 网络错误等多处直接 `catch {}` 静默吞，出问题时用户没有任何提示，需要刷新或重启才自愈。
3) **服务端 API 边界**：context 路由有一处 sessionId 当 sessionPath 用的明显 bug（subagent 历史永远查不出来）；DELETE 级联删除非原子；fork 的 targetEntryId 不校验归属。

未发现高危安全问题。建议优先处理标记为【高】和【中】的条目，其余作为后续优化。

---

## 高 严重等级

### H1. context 路由把 sessionId 当作 sessionPath 传给 subagent 查询
- **位置**：`app/api/sessions/[id]/context/route.ts`（调用 `listBatchesByParentSessionPath(id)` 处） + `lib/subagents/server-store.ts:196-205`
- **现象**：`listBatchesByParentSessionPath` 期望传入的是 jsonl 绝对路径（parentSessionPath），但路由直接把 URL 中的 session id（UUID）传进去，filter 的严格相等永远不命中。
- **影响**：选中任意历史 session 后，前端拿到的 `subagentBatches` 永远是空数组——sub-agent 历史 batch 完全展示不出来，看起来像“以前跑过的子任务全没了”。
- **建议**：先 `findSessionPathById(id)` 取真实 path 再传入；或新增 `listBatchesByParentSessionId` 走 id 索引。
- **来源**：audit-server-api（独立发现）

---

## 中 严重等级

### M1. agent crash / SDK 抛错时，会话可能永远停留在“运行中”
- **位置**：`lib/agent-registry.ts` `session.subscribe` 回调与 `scheduleFinishWatchdog`（行号未核实）
- **现象**：`isStreaming = true` 只在收到 `agent_start` 时被设；`finishWatchdog` 只在 `message_end` 时挂上。如果底层 SDK 在 `agent_start` 之后抛错且没发任何 `message_end`/`agent_end`（fetch reject、模型 401 等），`isStreaming` 永远是 true。
- **影响**：sidebar 上显示“运行中”转一晚上不停，未读永远不亮；列表排序把这条死会话钉在顶部；用户必须手动 dispose 或重启才能恢复。
- **建议**：在 `session.prompt(...)` 的 await 后加 `.catch(() => finishStreamingRun(record))` 兜底；watchdog 也应在 `agent_start` 时挂一个长 timeout（例如 60s 无任何事件就强制收尾）。
- **来源**：audit-runtime（独立发现）

### M2. sidebar 与 pet 弹窗对“未读”判定不一致
- **位置**：`app/components/Sidebar.tsx:489` 用 `isSessionUnread`（看 `lastAgentEndAt`）；`app/hooks/usePetPusher.ts:357,410` 直接 `seenAt < sess.modified`（看 jsonl mtime）
- **现象**：sidebar 已经按 RFC 切到“agent_end 时间”做判定，但 pet 弹窗逻辑还在用 `modified`。多 turn 会话里：sidebar 不会高亮蓝点（因为 lastAgentEndAt 已等于 seenAt），但 pet 仍会因为 mtime 更新被触发。
- **影响**：用户在 sidebar 看到“已读了”，pet 还在提醒——多端体验不一致。
- **建议**：把 `usePetPusher` 也切到 `isSessionUnread`，统一未读来源。
- **来源**：audit-runtime（独立发现）

### M3. DELETE 级联删除非原子，部分失败会留下不一致
- **位置**：`app/api/sessions/[id]/route.ts` DELETE handler 里 `for (const t of targets)` 循环
- **现象**：循环里 `fs.unlink(jsonl)` 失败只记 errors 但**继续**走 `deleteMeta` + `deletePersistedProgress`。errors 非空时整体 500。
- **影响**：jsonl 因权限/被占用没删掉，但 meta / progress 已经删了；下次 list 出来这条 session 突然丢了 pinned/title/进度快照，UI 看起来像“会话陌生化”。
- **建议**：unlink 失败的目标跳过 deleteMeta/deletePersistedProgress；errors 非空时不要再清辅助数据。
- **来源**：audit-server-api（独立发现）

### M4. DELETE 与活跃写入存在 race
- **位置**：`app/api/sessions/[id]/route.ts` DELETE handler 中 `disposeAgent` 之后立刻 `unlink`
- **现象**：`disposeAgent` 是 best-effort（整段 try/catch 吞），不显式等待 fd 关闭就 unlink。极端情况下 stream 还在 flush 到 jsonl。
- **影响**：POSIX 下尾巴写入丢失；Windows 下 unlink 可能直接 EBUSY，落入“部分失败”分支。
- **建议**：disposeAgent 改为真正 await writer close 后再 unlink；Windows 加重试。
- **来源**：audit-server-api（独立发现）

### M5. fork 的 `targetEntryId` 仅判空、不校验是否归属源 session
- **位置**：`app/api/sessions/[id]/fork/route.ts` POST handler
- **现象**：`targetEntryId` 仅校验非空就回写到响应里，没有校验它是否真存在于源 session 的 entries 中。
- **影响**：客户端传非法 entryId 时，新 session 已经被创建（孤儿 fork 文件），后续 navigate 必然失败；用户层面表现为 fork 出一堆和源 session 一模一样的副本。
- **建议**：fork 前用 `getSessionDetail(id)` 校验 `targetEntryId` 命中 user message；不存在直接 400。
- **来源**：audit-server-api（独立发现）

### M6. fork route 重复扫描 + 错误码语义不准
- **位置**：`app/api/sessions/[id]/fork/route.ts` POST handler 上半段
- **现象**：先 `findSessionPathById`（内部 `SessionManager.listAll()`），紧接着 `getSessionDetail(id)` 再次 `listAll()`。`getSessionDetail` 返回 null 时回 500，但其实更像 race 而不是服务端错误。
- **影响**：性能浪费 + 错误码语义不对，监控报警容易误判。
- **建议**：合并到一次 listAll；getSessionDetail 返回 null 时回 404。
- **来源**：audit-server-api（独立发现）

### M7. context 路由信任客户端传入的 `path` query
- **位置**：`app/api/sessions/[id]/context/route.ts`
- **现象**：直接把客户端 query 的 sessionPath 透传给 `SessionManager.open()`，仅靠 `sm.getSessionId() !== expectedId` 事后校验。已认证的远程客户端可以指向任意可读 jsonl。
- **影响**：错误码不准；理论上还允许已认证客户端探测任意文件是否为合法 SDK session（旁路信道）。
- **建议**：要么去掉 path 参数全部走 `findSessionPathById(id)`，要么先校验 path 在 SDK sessions 根目录下且存在。
- **来源**：audit-server-api（独立发现）

### M8. 重命名 PATCH 没有长度/频率校验
- **位置**：`app/api/sessions/[id]/route.ts` PATCH handler，`appendSessionInfo(name)`
- **现象**：name 仅 `trim()` 校验非空，任意长度都直接 append；高频改名也都全部落盘。
- **影响**：恶意/误用客户端可往 jsonl 里无限追加大 SessionInfo，膨胀文件；与 meta PATCH 的 title 上限（200）不一致。
- **建议**：加 200 字符上限 + 与上次 name 相同时跳过 append。
- **来源**：audit-server-api（独立发现）

### M9. `useSessions` 标记已读形成“列表抖动 → PATCH 风暴”
- **位置**：`app/hooks/useSessions.ts` ~L259-268，effect 监听 `[sessions, selectedId, markSessionSeen]`
- **现象**：每次 `sessions` 引用变化（轮询、SSE）都会通过 microtask 调一次 `markSessionSeen`，触发 `persistServerLastSeen`（PATCH `/api/sessions/:id/meta`） + `setLastSeenMap`。流式过程中只要 modified 变就再写一次。
- **影响**：聚焦看着某 session 时，每一次 token / agent_end 都会发一个 meta PATCH，后端写盘频率被放大；也连带让 PATCH 接口的真实压力远高于业务直觉。
- **建议**：`markSessionSeen` 比较时如果 prev 已记录的 ISO ≥ cur.modified 直接短路；或这条 effect 改成只在 selectedId 变化或显式 focus 事件触发。
- **来源**：audit-hooks（独立发现）

### M10. SSE 错误立即标 `lost`，没有退避，永久断开时不会主动重连
- **位置**：`app/hooks/useSseManager.ts` `es.onerror`（约 L260）
- **现象**：onerror 即标 `sseStatus: 'lost'`，浏览器自带重连只能处理瞬断；偶发 5xx / nginx idle timeout 会让“连接丢失”提示反复闪烁。如果服务端真的永久 close，会一直停在 lost，必须用户切换 session 才恢复。
- **影响**：UI 提示频繁闪烁影响信任感；真断时没有自愈。
- **建议**：实现简易退避重 attach（5s/10s/30s 三档），并把 sseStatus 的状态切换做防抖（短暂 error 不立即标 lost）。
- **来源**：audit-hooks（独立发现）

### M11. `executeDeleteSession` 用闭包 `selectedId`，与 `refreshSessions` 用 ref 不一致
- **位置**：`app/hooks/useSessions.ts` ~L295-325
- **现象**：`refreshSessions` 走 `selectedIdRef.current`，但 `executeDeleteSession` 用闭包 `selectedId`。同一帧内“先选 A 再删 A”可能命中 stale 闭包。
- **影响**：极端时序下 UI 仍高亮已删 session id，需要等下一次 refresh 兜底。
- **建议**：统一使用 `selectedIdRef.current`。
- **来源**：audit-hooks（独立发现）

### M12. reducer 收到 `subagent_batch_detached` 没有对应 case，状态卡死
- **位置**：`lib/chat-reducer.ts` switch 内（无 detached 分支）；事件源 `lib/subagents/orchestrator.ts:1579`，由 `app/hooks/useAgentEvents.ts:484` 转发到 reducer
- **现象**：subagent 批次 detach 异步跑时，reducer 走 `default → return state`，前端拿不到“已 detach”的标记。
- **影响**：detach 异步执行的 subagent 卡片停留在初始 status，看起来像“卡住”。
- **建议**：补 `case "subagent_batch_detached"` 把对应 part 标为 detached/running；或在 useAgentEvents 层不要派给 reducer。
- **来源**：audit-reducer（独立发现）

### M13. `tool_execution_end` / `tool_execution_update` 在 active assistant 已关闭时会“凭空”造空气泡
- **位置**：`lib/chat-reducer.ts` 对应 case + `ensureAssistant`（约 L230-237）
- **现象**：`replaceActive` 总会先 `ensureAssistant`，当 `activeAssistantIndex < 0`（事件迟到/乱序）时会 push 一条空 assistant；后续 `findToolPartIndex` 找不到 toolCallId 不做修改，但占位已留下。
- **影响**：消息列表末尾凭空多一条空 assistant 气泡；activeAssistantIndex 错误推进，下一轮 thinking/text_delta 写到不属于它的消息上。
- **建议**：tool 类事件改为“先在所有 assistant 中倒序找 toolCallId 所在 part”，找不到 `return state`，不要 ensureAssistant。
- **来源**：audit-reducer（独立发现）

---

## 低 严重等级

### L1. `resolveApproval` 把“用户主动选择默认 deny”误判成 timeout
- **位置**：`lib/agent-registry.ts:1050-1052`（同模式在 7 处复制粘贴的审批分支里都有）
- **现象**：判断超时 vs 用户操作的依据是 `denyReason === undefined && decision === defaultDecision`。但用户在 UI 上点“按默认 deny”而没填 reason 时，会被打成 `resolvedBy: "timeout"`。
- **影响**：审计日志失真；排查“为什么这条工具没跑”时方向被带偏。
- **建议**：`resolveApproval` 增加 `source: "user"|"timeout"`，从 ApprovalResponse 读真值。
- **来源**：audit-runtime

### L2. 审批模板复制粘贴 7 次，未抽公共函数
- **位置**：`lib/agent-registry.ts` 的 `requestWorkflowCapabilityApproval` / `requestMcpToolApproval` / `requestBrowserSiteApproval` 等 7 处
- **影响**：上面 L1 一改要改 7 处；新增审批类型必漏点。
- **建议**：抽 `runApproval(rec, partialReq)` 统一封装。
- **来源**：audit-runtime

### L3. `recentClientRequests` 没有过期主动清理
- **位置**：`lib/agent-registry.ts` 与 `lib/client-request-dedupe.ts`
- **现象**：靠 TTL 判断是否复用，但过期 entry 不会主动 delete。
- **影响**：长跑会话内存随消息数线性增长。
- **建议**：claim 时顺便 delete 过期；或 pushAgentEvent 时按概率扫一遍。
- **来源**：audit-runtime

### L4. `SessionManager.listAll()` 多处并发重复扫盘
- **位置**：`lib/sessions.ts` 的 listAllSessions / findSessionPathById / getSessionDetail / getSessionContext / collectSessionDescendants
- **现象**：每个公开函数各自 await listAll，没有缓存或 in-flight dedupe。
- **影响**：多客户端并发 + cwd 多 + session 多（500+）时 sidebar 抖动可见。
- **建议**：加 200ms 级内存缓存或 in-flight dedupe。
- **来源**：audit-runtime

### L5. P4 stub session 的 cwd 可能为空字符串
- **位置**：`lib/sessions.ts:62` `cwd: summary.cwd ?? ""`
- **影响**：边界场景下用户看到 cwd="" 的 ghost stub。
- **建议**：改严格断言或直接跳过 stub。
- **来源**：audit-runtime

### L6. `optimistic.upsertOptimisticSession` 用 `||` 而不是 `??` 处理 path
- **位置**：`lib/sessions/optimistic.ts:42-43`
- **影响**：极小，但 `runtimeByPath` 用 sessionFile 当 key，错配会让 isRunning 标到错误 session。
- **建议**：分支显式化，仅在 `!cur.path` 时补值，不一致时 console.warn。
- **来源**：audit-runtime

### L7. context 路由恢复 progress 时存在 race 窗口
- **位置**：`app/api/sessions/[id]/context/route.ts` `markInterruptedProgress` 逻辑
- **现象**：listAgentSummaries 内存快照 与 readPersistedProgress 之间不是原子的。
- **影响**：偶发把刚启动的会话标成 interrupted。
- **建议**：两步靠近 + 注释；或在 agent 重启侧主动覆盖一次 progress。
- **来源**：audit-server-api

### L8. `/api/sessions` GET 与 context GET 没用 `withRemoteAuth` 装饰器
- **位置**：`app/api/sessions/route.ts`、`app/api/sessions/[id]/context/route.ts`
- **影响**：风格不统一，未来加新策略容易漏。
- **建议**：与同目录其他 handler 统一改成 withRemoteAuth。
- **来源**：audit-server-api

### L9. export route 把未净化的 `id` 拼进 `Content-Disposition`
- **位置**：`app/api/sessions/[id]/export/route.ts`
- **影响**：理论 header 注入；当前 SDK id 是 UUID，几乎无危害。
- **建议**：`encodeURIComponent` 或限制 charset。
- **来源**：audit-server-api

### L10. `refreshSessions` 的 catch 完全静默
- **位置**：`app/hooks/useSessions.ts` ~L322 `.catch(() => {})`
- **影响**：网络错或坏 JSON 时 sidebar 静默不更新，用户没有任何提示。
- **建议**：catch 至少 console.warn + 退避重试；或调用 onError。
- **来源**：audit-hooks

### L11. `useChatStream.send` / `guardActiveKeyMatchesSelected` 引用频繁抖动
- **位置**：`app/hooks/useChatStream.ts`
- **现象**：guard 依赖 [activeKeyRef, selectedId, sessions, setError]，sessions 一变就重建，连锁让 send 重建。
- **影响**：Composer 收到的 onSend prop 不稳定，memo 失效，抵消了之前的性能优化。
- **建议**：把 guard 改成读 sessionsRef/selectedIdRef 的稳定函数。
- **来源**：audit-hooks

### L12. `onAbort` 错误整段被吞且不清 retryInfo
- **位置**：`app/hooks/useChatStream.ts`
- **影响**：abort 失败时 UI 残留进度态。
- **建议**：onAbort 顺手清 retryInfo 与 pendingMessages。
- **来源**：audit-hooks

### L13. `onChangeThinking` 失败时不回滚
- **位置**：`app/hooks/useChatStream.ts`
- **影响**：UI 显示已切换 thinking，实际后端没切。
- **建议**：失败回滚 + setError。
- **来源**：audit-hooks

### L14. `closeSseFor` 无条件清 lastSeqRef，重 attach 时丢断点续传
- **位置**：`app/hooks/useSseManager.ts:173-196`
- **影响**：同 key 重 attach 时可能从头重放。
- **建议**：close 不删 lastSeq，只在 unmount 清；或带 agentId 判断。
- **来源**：audit-hooks

### L15. reducer 含 `Date.now()` 副作用，不是严格纯函数
- **位置**：`lib/chat-reducer.ts` 多处（thinking、optimistic_user、fork_replace_user）
- **影响**：StrictMode 下两次 reduce 时间戳不同；未来事件回放 e2e 不可重放。
- **建议**：让事件携带时间戳，reducer 不调 Date.now。
- **来源**：audit-reducer

### L16. `__fork_replace_user` 没清 `completedAssistantResponseIds`
- **位置**：`lib/chat-reducer.ts`
- **影响**：极小概率下首批 delta 被吞。
- **建议**：fork 时一并清 completedAssistantResponseIds。
- **来源**：audit-reducer

### L17. `tool_execution_update` 即便无变化也创建新 message 引用
- **位置**：`lib/chat-reducer.ts`
- **影响**：React memo 失效，partial 流时性能轻微浪费。
- **建议**：mutator 找不到 toolCallId 时直接 return msg。
- **来源**：audit-reducer

### L18. `activeAssistantReplayText` 在 tool/审批/clarification 等 part 插入时不清空
- **位置**：`lib/chat-reducer.ts`
- **影响**：非标准 shim + 工具混合输出场景下，工具调用之后那段文字可能丢前几字。
- **建议**：抽 `clearReplay(state)`，所有“非 text 写 parts”路径都调一下。
- **来源**：audit-reducer

---

## 已确认合理的功能点

服务端 API：
- `lib/meta/store.ts` 写入用 tmp + rename 原子提交。
- `metaFilePath` 拒绝带 `/`、`\`、`..` 的 sessionId，挡住 path traversal。
- meta PATCH 严格走白名单字段，title 长度 200 限制，`lastSeenAt` 校验为正有限数；spread 时强制 id 一致。
- meta GET/PATCH 与 SDK 的 PATCH（appendSessionInfo）严格分离，互不干扰。
- DELETE 路由先 dispose 内存中所有指向 targetPaths 的 agent record（含 hidden child agents）。
- DELETE unlink 对 ENOENT 静默通过，幂等性合理；meta/progress 删除函数同样幂等。
- `collectSessionDescendants` 用 BFS + visited，避免环导致的死循环。
- fork 校验源 session 存在、cwd 非空。
- context 路由对 tail/before/limit 做了 `Number.isFinite + clamp`，分页/tail 不附带 forkableUserMessages 和 progress。
- `getSessionContextTailByPath` / `getSessionContextPageByPath` 内部用 `sm.getSessionId() !== expectedId` 兜底校验。
- export 路由用 pathToFileURL + 动态 import 加载 SDK 子模块，并在 finally 清理 tmp。

运行时与持久化：
- `subscribe` 回调里只用 closure 的 record 引用，避免大多数读路径上的窗口问题。
- jsonl 操作的失败路径基本走 best-effort + try/catch，单个 session 写失败不会影响其它。

前端 hooks：
- `useSessions` 的 sameSessionList 把 lastSeenAt 计入比较，防止 markSessionSeen 自循环（虽然 PATCH 风暴问题仍存在，见 M9）。
- `useSseManager` unmount cleanup 用 effect-time 快照，符合 React ESLint 规则。

chat-reducer：
- 主路径 message_start / text_delta / message_update / message_end / agent_start / agent_end 已被单测覆盖。
- approval_resolved 用倒序遍历查找 toolCallId，跨 message 也能命中。
- thinking_delta 写入时显式清掉 activeAssistantReplayText/Offset。


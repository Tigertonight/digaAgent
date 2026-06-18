# 会话功能审计报告

- **时间**：2026-06-17
- **审计范围**：服务端 API、运行时与 SSE、前端 hooks、状态机/fork/export
- **整体结论**：**有隐患（中等健康度）**。基础流程稳定，但在「并发」「错误恢复」「断线重连」三个维度上多处缺保护，会让用户在网络抖动、重命名/快速操作、并发请求等边界场景看到错乱状态。
- **原始审计**：详见同目录 `session-audit-raw.md`（4 路 485 行）。

---

## 1. 覆盖范围

**已覆盖（4 路审计 + 侦察）**
- 服务端 API：`app/api/sessions/{,[id]/{,fork,export,context,meta}}/route.ts`、`lib/sessions.ts`、`lib/sessions/{optimistic,unread}.ts`、`lib/meta/{types,store}.ts`
- 运行时 / SSE：`lib/agent-registry.ts`、`app/api/agent/[id]/{route.ts,events/route.ts}`、`lib/runtime/event-store.ts`
- 前端 hooks：`app/hooks/{useSessions,useSessionMeta,useChatStream,useSseManager,useChatModalsState,useRuntimeTimeline,useForkable}.ts`
- 状态机：`lib/chat-reducer.ts`、`lib/turn-state.ts`、`lib/context-aside.ts`

**部分覆盖 / 未覆盖**
- 桌面端 `app/ChatApp.tsx`（3555 行）只看了与 hooks 装配相关的部分，未做内部审计
- 移动端 `app/mobile/MobileApp.tsx`（3650 行，平行实现）**未覆盖**
- Sidebar/BranchesPopover 等 UI 组件仅按"是否消费会话状态"扫过，未审 a11y/事件
- electron 多窗口 IPC（`pet:*`）未深入

---

## 2. 高优先级问题（高严重度，建议优先修）

### H-1 createAgent 同 sessionPath 复用存在竞态，会双开 SDK 写同一 jsonl
- **位置**：`lib/agent-registry.ts:986-996`
- **现象**：复用判断是 `Array.find`，无锁。两个几乎同时到达的请求（前端切换/刷新双开/移动端断线重连）都会发现 existing 不存在，各自走 `SessionManager.open(sessionPath)` + `createAgentSession`，最终注册两个不同 agentId 共享同一 sessionFile。
- **用户影响**：① 同一 jsonl 被两个 writer 同时 append → 事件顺序错乱；② goal/clarification/approval 落到 agentA，但子流是 agentB → 用户点了 approve 没有响应；③ sidebar "running" 状态不可推断哪个 agent 是真活的。
- **建议方向**：在 createAgent 入口加 `pendingByPath: Map<string, Promise<...>>`，让同 path 的并发请求复用同一 promise；或显式加 per-path 锁。

### H-2 SSE 没有任何重连策略，断线后永久 `lost`
- **位置**：`app/hooks/useSseManager.ts:277-281`
- **现象**：`onerror` 只把状态置为 `"lost"`，从不重新创建 EventSource。代码注释承认"重连策略 → 暂留 ChatApp"，但 ChatApp 也没主动 reattach。EventSource 进入 CLOSED 后浏览器原生不再重试。
- **用户影响**：网络抖动 / Next 热重启 / 后端短时不可用之后，**SSE 永远不再恢复**；用户必须切 session 或刷页。后台 turn 即使最终 agent_end，前端也永远看不到，HUD 卡在 streaming。
- **建议方向**：onerror 检查 `readyState === CLOSED` 时安排 backoff reattach，复用 `lastSeqRef` 续传（后端已支持 since）；或在 useChatStream 暴露主动 reconnect 入口。

### H-3 fork API 收下 `targetEntryId` 但完全不使用，仅由前端再调 navigate_tree 截断
- **位置**：`app/api/sessions/[id]/fork/route.ts:33-79`
- **现象**：路由强校验 `targetEntryId` 非空，但实际只回显；新文件 leaf 仍然指向源 session 末端。真正截到 fork 点是前端 `useForkable.ts:267` 在第二步做的。
- **用户影响**：① 任何直接调 fork API 的客户端（脚本/curl/远程）都拿到一份 leaf 没截断的拷贝，发 prompt 会从源 session 末尾续写；② 步骤 1 成功但步骤 3 失败/网络抖断/用户切走会留下脏 fork，无事务回滚。
- **建议方向**：把 navigate_tree 拉到服务端做成原子 fork API；或文档化两步契约并在响应里明确 `leafId` 让客户端验证。

---

## 3. 中优先级问题

### M-1 abort 路径不调用 finishStreamingRun，goal turn 与 runtime 事件不收尾
- 位置：`app/api/agent/[id]/route.ts:706-720`
- 现象：abort 只 `rec.isStreaming = false`，绕过 `finishStreamingRun`，也不 push `agent_end`。
- 用户影响：用户点 stop 后，goal turn 永远停留 `running`；runtime_events 没 agent.end mirror，HUD/审计错乱。
- 建议：abort 统一走 `finishStreamingRun(rec)` 或显式 push agent_end。

### M-2 finishWatchdog 兜底翻 isStreaming，但不补发任何终止事件
- 位置：`lib/agent-registry.ts:599-630, 1880`
- 现象：watchdog 只关闭服务端内部状态，不 push agent_end / message_end。
- 用户影响：SSE 订阅方（前端 reducer）不知本轮结束，phase 卡在 thinking/streaming；`lastAgentEndAt` 有值但前端永远 reconcile 不到。
- 建议：watchdog 触发时也 push `agent_end`。

### M-3 prompt 失败时已发了 optimistic_user_ack，前端无法回滚
- 位置：`app/api/agent/[id]/route.ts:436-475` + `lib/chat-reducer.ts:806`
- 现象：claim → push ack → 才 await prompt；prompt throw 后只 clearClientRequest。但 ack 已把 user 气泡 `pending=false`，reducer 的 `__optimistic_user_failed` 分支只对 pending=true 生效。
- 用户影响：模型未配置/上游 401 等失败时，UI 看气泡是"已发送"，实际 SDK 没接受；用户再点 send 会创建新一条，旧的留在那里。
- 建议：调换次序——prompt 至少 enqueue 成功后再发 ack；或新增服务端 `optimistic_user_failed` 事件。


### M-4 LocalCodingAssistant 缺并发保护，CLI 失败漏 message_end
- 位置：lib/agent-registry.ts:824-922
- 现象：rec.external?.child 守卫在 spawn 之前的 async 间隙拦不住第二次调用 → 两个 child 同跑；CLI 启动失败只 push agent_end，前面已 push message_start 没补 message_end。
- 用户影响：本地 CLI 模式下 assistant 气泡停留 partial；偶发 CLI 双开 emit 互串。
- 建议：在最早窗口占位 rec.external = { child: PENDING }；CLI 启动失败也 push message_end。

### M-5 PATCH /meta 是 read-modify-write，存在丢失更新
- 位置：app/api/sessions/[id]/meta/route.ts:84-94
- 现象：read → spread merge → write，无锁。多 tab 同时改 pinned/title 会互相覆盖；高频 lastSeenAt PATCH 放大冲突窗口。
- 用户影响：跨 tab/跨设备已读、pin、title 偶发回滚到旧值。
- 建议：per-id mutex；或把 lastSeenAt 单独走 append-only 路径。

### M-6 DELETE 部分失败时 meta/progress 已被清，jsonl 还在
- 位置：app/api/sessions/[id]/route.ts:99-118
- 现象：循环里先 unlink 失败进 errors，但接着无条件 deleteMeta + deletePersistedProgress。
- 用户影响：jsonl 残骸下次 listAll 变成无 meta/progress 的孤儿，pin/title 全丢且不可恢复。
- 建议：先 unlink 全部成功才动 meta/progress；或两阶段执行。

### M-7 listAll 在删除/fork/详情 helper 里被反复全盘扫描
- 位置：lib/sessions.ts:99-141
- 现象：findSessionPathById、getSessionDetail、collectSessionDescendants 各自 await listAll。fork 路由单次请求触发 2 次。
- 用户影响：会话数到几百以上明显感知卡顿；并发请求互相拖慢。
- 建议：进程内 id→path 缓存（chokidar 失效）或单请求复用 listAll。

### M-8 markSessionSeen 在流式更新下高频 PATCH
- 位置：app/hooks/useSessions.ts:294-302
- 现象：sessions 每次刷新都 queueMicrotask 标记，streaming 期间几十秒长 turn 可触发数百次 PATCH。
- 用户影响：服务端连接/写盘冗余；多设备已读不一致放大。
- 建议：同 sessionId N 秒节流；仅在 modified 真前进且距上次 PATCH > X 时发。

### M-9 lastSeen 持久化与 server PATCH 互相覆盖
- 位置：app/hooks/useSessions.ts:90-99 / 254-269 / 358-365
- 现象：markSessionSeen fire-and-forget PATCH 失败静默；mergeServerLastSeen 仅当 next[id] < seen 才覆盖。PATCH 失败但本地已写入 → server 永远停旧值。
- 用户影响：跨设备/多 tab 已读不一致，特别是网络不稳时。
- 建议：PATCH 重试 / 失败回滚本地；或承认本地为真值，定期单向 push。

### M-10 ensureAgent 失败后 optimistic sidebar 项变孤儿
- 位置：app/hooks/useChatStream.ts:381-401, 538-547
- 现象：agent 已 fetch 创建，但接下来的 prompt 失败后只标 user 气泡 failed，sidebar 行没回收。upgradeDraftIfNeeded 在 has(newKey) 分支不清 draft，回到 draft 后输入框残留旧附件。
- 用户影响：sidebar 出现"无内容空会话"；切回新会话看到上一次输入。
- 建议：失败保留 sidebar 但状态置 failed；has(newKey) 分支也清 draft。

### M-11 startGoal / startWorkflow 不清 input 和 attachments
- 位置：app/hooks/useChatStream.ts:567-680
- 现象：与 send 不同，goal/workflow 不调 setInput("") 和 setPendingImages/Files([])。
- 用户影响：用户用 /goal 后 Composer 还残留 objective，下次 send 会再发；附件被静默丢弃。
- 建议：成功 dispatch 后清 input 和 attachments。

### M-12 guardActiveKeyMatchesSelected 在 path 缺失时直接放行
- 位置：app/hooks/useChatStream.ts:496-501
- 现象：if (!selectedSession?.path) return true; —— sessions 列表尚未加载或刚删未 refresh 时，prompt 落到 active runner（可能不是用户以为的那个 session）。
- 用户影响：边界情况下越权写到错的 session。
- 建议：找不到时返回 false 并 setError。

### M-13 reducer aside-only user 静默丢弃，无任何痕迹
- 位置：lib/chat-reducer.ts:944-948
- 现象：stripContextAside 后 parts.length===0 直接 return state。
- 用户影响：bug 触发该形状时 UI 完全不可见、日志无痕，排查只能 jsonl 比对。
- 建议：dev 构建 console.debug；或 ReducerState 维护 silentlyDropped 计数。

### M-14 reducer 同文本异源 user 兜底匹配可能错并
- 位置：lib/chat-reducer.ts:919-935
- 现象：last 是 pending user 且无 clientRequestId 时按文本相等做衰变兜底。
- 用户影响：用户连发两条相同文本，第二条会被错并到第一条 optimistic → 第二条永远 pending、第二轮 assistant 索引错。
- 建议：删除该兜底（现代客户端必带 clientRequestId）或加 in-flight 检查。

### M-15 历史会话 subagent batch 双重渲染
- 位置：lib/chat-reducer.ts:583-586, 660-684, 1690-1717
- 现象：ctxToMessages 把 delegate_subagents 工具结果转 subagent_batch part；appendRestoredSubagentBatches 又从持久化数组追加一条独立 message。两边按 batchId 去重，但 fromToolResult fallback 用 toolCallId，与 SDK 真 batchId 不一致时 UI 同时出现两份卡片。
- 用户影响：历史会话偶发看到重复 subagent batch 卡片。
- 建议：fromToolResult 强制 details.batchId；或 ctxToMessages 不再生成 batch part 统一交给 appendRestored。

### M-16 export route 并发用 mtime 命名会冲突
- 位置：app/api/sessions/[id]/export/route.ts:69-85
- 现象：outPath 用 ${id}-${Date.now()}.html，毫秒级并发会写同一文件；finally 里 unlink 又被吞错。
- 用户影响：用户拿到错误/半截 HTML，且看不到错误。
- 建议：用 randomUUID 替换 Date.now()；或让 SDK 直接返回内存字符串。

### M-17 export route 通过 cwd() 绝对路径动态 import SDK 子模块
- 位置：app/api/sessions/[id]/export/route.ts:25-50
- 现象：硬编码 node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/index.js。
- 用户影响：pnpm 平铺 / standalone 构建变化时运行期才报错。
- 建议：要求 SDK 加 exports map；短期 fallback 用 require.resolve 求真实路径。

### M-18 export 不传自定义 toolRenderer，自定义工具卡片不可读
- 位置：app/api/sessions/[id]/export/route.ts:73-75
- 现象：subagent_batch / workflow_run / approval / clarification 在导出 HTML 中按 SDK 默认 raw json 渲染。
- 用户影响：导出存档对这些卡片不可读。
- 建议：构造 ToolHtmlRenderer 与前端 MessageView 一致。

### M-19 SSE backpressure 未检查 desiredSize
- 位置：app/api/agent/[id]/events/route.ts:96-115
- 现象：scheduleFlush 每 16ms enqueue，从不看 controller.desiredSize；ring buffer 5000 条只保护来源，没保护出口。
- 用户影响：慢消费场景后端进程 SSE buffer 堆积。
- 建议：enqueue 前看 desiredSize，<=0 跳过本轮，下次 flush 用 ring 重新拉差量。

### M-20 lastSeqRef 与未来 SSE 重连配合不良
- 位置：app/hooks/useSseManager.ts:196, 230-237, 262-271
- 现象：close 时清 lastSeq，未来 H-2 重连实现后会 since=-1 重发整段历史。
- 用户影响：与 H-2 联动，将来重连时偶发气泡重复。
- 建议：close 只清 generation 保留 lastSeq；attach 同 agentId 复用 since。

### M-21 DELETE dispose 仅按 sessionFile 字符串匹配
- 位置：app/api/sessions/[id]/route.ts:84-94
- 现象：targetPaths 比较字符串，symlink/不同前缀时 mismatch。
- 用户影响：未 dispose 的 agent 在文件被 unlink 后继续 appendFileSync，写到孤立 inode + EBADF。
- 建议：同时按 sessionId 匹配；或先 resolvePath 两边再比对。


---

## 4. 低优先级 / 代码卫生

- **L-1** SSE since=NaN 时静默吞所有事件（events/route.ts:46-53）—— 加 Number.isFinite 校验。
- **L-2** PATCH 重命名无变化时仍 append session_info 行（[id]/route.ts:36-58）—— 与 getSessionName 比较短路。
- **L-3** export route 一次性 readFile 后再 Response，长 session 会吃内存；改流式即可。
- **L-4** context route 的 tail/before 参数解析失败静默回退到全量；非法值应 400。
- **L-5** fork 路由复用源 cwd，跨机器迁移场景静默失败；新建 session 起来跑 bash 立刻报错。
- **L-6** session GET（按 id）刚 POST /api/agent/new 后第一条 message 还没写时返回 null；缺 registry 兜底。
- **L-7** listAllSessions stub 注入逻辑下，hidden agent 的 sessionFile 路径形态不一致时会 push 重复 id。
- **L-8** sameSessionList 字段对比硬编码 17 个，未来加字段静默不重渲。
- **L-9** 删除 session 用 selectedId 闭包陈旧值，删除中切 session 可能误清空。
- **L-10** RAF flush 中单条 dispatch 抛错只 console.error，状态可能被部分污染。
- **L-11** turn-state.deriveTurnChromeState 中间 turn streaming=true 的判定有死分支（待复查）。
- **L-12** chat-reducer tool_execution_end 没补一次 sealLastThinkingIfOpen，可能留下 endedAt=undefined 的 thinking part。
- **L-13** GET /context 的 interrupted 标记不写回持久化 progress，外部读取看到的是旧值。
- **L-14** recentClientRequests 在 ack 之后失败 + 客户端断网重发组合下，dedupe 已 clear，旧 ack 已发，会再次 claim 成功（与 M-3 联动需一并处理）。

---

## 5. 模块健康度小结

| 模块 | 整体评价 | 主要风险 |
|---|---|---|
| 服务端 API | 中等 | PATCH 竞态（M-5）、DELETE 半截清理（M-6）、fork 两步契约（H-3）、export 命名冲突（M-16）|
| 运行时 / SSE | 偏弱 | createAgent 双开（H-1）、abort/watchdog 漏发 agent_end（M-1/M-2）、Local CLI 漏 message_end（M-4）|
| 前端 hooks | 偏弱 | SSE 不重连（H-2）、optimistic 失败回滚不全（M-3/M-10）、guard 误放行（M-12）、PATCH 高频（M-8/M-9）|
| 状态机 / fork-export | 中等 | aside-only 静默丢弃（M-13）、同文本兜底误并（M-14）、subagent batch 双渲染（M-15）、export 工具卡片缺自定义渲染（M-18）|

---

## 6. 建议的下一步（按优先级）

1. **修 H-1 createAgent 竞态**：加 per-sessionPath in-flight Promise map。这是会让历史 jsonl 错乱的根因，先堵。
2. **修 H-2 SSE 重连**：onerror 触发带 backoff 的 reattach，复用 lastSeq 续传。这是用户最容易感知的"卡住不动"问题。
3. **修 H-3 fork 原子性**：把 navigate_tree 拉到服务端做原子接口；或显式文档化两步契约 + 提供 server-side 回滚。
4. **统一 abort / watchdog 收尾事件**（M-1 / M-2）：所有终止路径都 push agent_end，避免 HUD 卡 streaming。
5. **梳理 optimistic ack / 失败回滚**（M-3 / M-10 / L-14）：调换 ack 与 prompt 的次序，或加服务端 optimistic_user_failed 事件。
6. **加 PATCH /meta 串行化**（M-5）+ markSessionSeen 节流（M-8 / M-9），消除已读/title/pin 的偶发回滚。

> **注**：L-* 项可在做高优先级修复时顺手清理；M-13/M-14 等 reducer 兜底分支建议先加 dev-only 计数/日志再决定是否删，避免误伤老客户端兼容。

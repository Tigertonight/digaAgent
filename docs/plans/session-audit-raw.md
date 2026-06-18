===== api full =====
I'll audit the server-side session APIs and persistence layer. Let me start by mapping the territory.

---

Now let me check key dependencies to evaluate inconsistencies: meta store, agent-registry, with-auth/assertRemoteAuth, and the SDK's SessionManager.forkFrom contract.

---

Note: `app/api/sessions/route.ts` and `app/api/sessions/[id]/context/route.ts` use bare `assertRemoteAuth` instead of `withRemoteAuth`. That likely escapes the CI check-route-auth check. Let me confirm.

---

So `assertRemoteAuth` import is OK by lint. Both files use it correctly. Let me check the SDK contract for `forkFrom` behavior, and key details:

---

Got the SDK contract. Key observations:

- `forkFrom` has `targetCwd` param. The route calls `SessionManager.forkFrom(sourcePath, sourceCwd)` — fork into the source's cwd. That is OK semantically.
- Multiple `listAll` calls per request (CRUD) — `findSessionPathById`, `getSessionDetail`, `collectSessionDescendants` each do `SessionManager.listAll()` (full disk scan). DELETE flow does it twice (once via `collectSessionDescendants`, once implicit). `getSessionContext` calls `findSessionPathById` then `SessionManager.open`. The fork route does `findSessionPathById` + `getSessionDetail` (which also does listAll). Performance smell.
- DELETE returns 404 only if `targets.length === 0`, but `collectSessionDescendants` also returns `null` if root not found — which the route treats as 404 due to `!targets || targets.length === 0`. OK.
- DELETE: when partial failure occurs, returns 500 but meta/progress for failed-jsonl ids ARE still deleted (loop runs deleteMeta/deletePersistedProgress before checking error). So a partial failure means: `.jsonl` survives but meta/progress gone — `lastSeenAt` / pin / cached progress wiped. Inconsistency.
- DELETE: dispose loop iterates `listAgentSummaries()` once but `targetPaths.has(summary.sessionFile)` — fine. However it doesn't dispose by `agent.sessionId === id` only by sessionFile match; if a hidden/spawned agent is keyed by sessionFile mismatch (e.g., different resolved path) it could survive. Minor.
- DELETE has no race protection: if a streaming agent finishes and a new entry is appended after `disposeAgent` returns but before `fs.unlink`, you can lose the late append (file still gets unlinked) — but that's inherent to delete semantics. OK.
- PATCH (rename): not concurrency-protected. `SessionManager.open(path)` reads the entire file into memory + appends. If two PATCHes race, both succeed (append-only), last one wins. Acceptable but note. However `SessionManager.open` opens a fresh manager per call (no shared instance with the live agent's SM) — append goes to disk fine but the in-memory live agent's `sessionFile` index won't see the rename until reload. Also, the live agent could append a normal entry concurrently — both append using `appendFileSync` which is OS-atomic for small writes. OK in practice.
- GET context: `progress` recovery branch — `markInterruptedProgress(progress)` is invoked, but `progress` value persisted to disk is **not updated**. So next call repeats the interrupt detection (cheap) and the persisted progress stays "completed-looking". OK by design, but if `hasUnpairedToolCalls` becomes false later (e.g., after a fresh agent run repairs), progress on disk is still stale. Minor.
- Context route: when both `before` and `tail` provided, `before` wins; when neither provided, returns full context + extras. Otherwise (paged/tail) returns slim ctx without `forkableUserMessages` / `subagentBatches` / `progress` / `interrupted`. The mobile pagination flow loses progress/interrupted info per refresh — front-end has to fetch full page once for these. Documented behavior in code; not a bug but easy to misuse.
- Context page parameters: `tail = Number(tailRaw)` — if `tailRaw` is invalid (e.g. "abc"), `tail = NaN`, and `Number.isFinite(tail) && tail > 0` is false, so falls back to full context. But the `limit = limitRaw ? Number(limitRaw) : tail` — if `tail = NaN`, limit defaults to NaN, then `Number.isFinite(limit) && limit > 0 ? limit : 80`. OK fallback. Edge OK.
- Fork route: `targetEntryId` is required and returned but not used (the SDK doesn't navigate). Comment says front-end must call `navigate_tree(targetEntryId)`. If front-end forgets, the new session leaf is at end → fork point is meaningless (silently wrong). Bad ergonomics.
- Fork route: also doesn't check `targetEntryId` is actually a valid entry id of the source — silent 200 with garbage id.
- Fork: source cwd may not exist on this machine (forkFrom uses targetCwd as cwd in new file). If sourceCwd is a stale path from a different machine, the new session is created with that stale cwd. May fail later.
- Meta PATCH: after `await readMeta(id)`, between read and `writeMeta`, two concurrent PATCHes can lose update — classic read-modify-write race. Comment in store.ts says "atomic via tmp+rename", but the higher-level merge isn't atomic. If client A sets `pinned=true` and client B sets `title=foo` concurrently, one update wins, the other is lost. Severity medium.
- Meta route: `lastSeenAt` is in writable list — but title/pinned and lastSeenAt should arguably be different write paths (lastSeenAt is high-frequency from session focus). Mixing them increases the race window for important fields.
- Meta route: clears `title` via `out.title = undefined`. Then `merged: SessionMeta = { ...existing, ...patch, id }` keeps `title: undefined` in the spread, but JSON.stringify drops it. However the route returns `merged` which includes `title: undefined` — JSON serialization to client also drops it. But `existing.title` was a string, after spread `merged.title = undefined`, which is what we want. OK.
- listAllSessions: stub injection logic — when registry has a sessionFile not yet on disk, inserts a stub. But `firstMessage = ""` and `messageCount = 0`. After actual SDK persists, next listAll picks the real one and the stub disappears (matched by id). What if `summary.sessionId` exists in `list` but `summary.sessionFile` does NOT match `s.path` (e.g., path resolution differs)? Then stub gets pushed with same id → duplicate row. Defensive `seen by id` check missing.
- listAllSessions sort: pinned > waiting_user > running > modified. Looks reasonable.
- Export route: `cachedExport` is module-level mutable. In Next dev/HMR, route module re-evals can leave dangling cache; ok but minor. Path constructed via `process.cwd()` which is the Next runtime cwd, may differ in standalone build.
- Export route's auth: uses `withRemoteAuth` ✓. Good.
- Export: no rate-limit / size cap. Large jsonl could OOM (reads entire file into a string).
- `findSessionPathById` does a full SDK listAll() for every API call — O(N session files) disk scans per API hit. Used by GET /:id, PATCH, fork, context, export. Probably fine for hundreds, terrible for thousands. Performance issue.
- DELETE: cascades to descendants but does NOT delete child session **meta** if the child had been forked but whose own descendants share a path? Actually `targets` from `collectSessionDescendants` includes all forks via parentSessionPath chain — meta deletion is inside the loop. OK.
- DELETE: But `collectSessionDescendants` matches via `parentSessionPath` (the stored path string in header). If the source got moved/renamed on disk, child's `parentSessionPath` no longer matches → cascade misses → orphans remain. Not a code bug per se but documented limitation.
- Auth: `app/api/sessions/route.ts` GET uses bare `assertRemoteAuth` — fine for the script check, but doesn't use `withRemoteAuth` consistency-wise. Mixed style.

Let me also check `getForkableUserMessages` and the `interrupted` flow more closely:

---

Frontend always calls navigate_tree after fork. So the fork route returning a leaf-at-end session is by design. OK.

Now check progress recovery:

---

Check listAgentSummaries.sessionId vs sessionFile relationship:

---

Good. I have plenty for the report. Let me finalize.

# 服务端会话 API & 持久化审计报告

审计范围：`app/api/sessions/**`、`lib/sessions.ts`、`lib/sessions/optimistic.ts`、`lib/sessions/unread.ts`。仅做静态阅读，未运行代码。

---

### F-01 PATCH /api/sessions/[id]/meta 是 read‑modify‑write，存在竞态丢失更新
- **位置**：app/api/sessions/[id]/meta/route.ts:84-94（`existing = readMeta`; `merged = ...`; `await writeMeta`）
- **现象**：handler 先 `readMeta(id)`，再 spread merge body，再 `writeMeta`。`writeMeta` 自身用 tmp+rename 保证单次写原子，但 read→merge→write 之间没有任何锁。
- **为什么不合理**：两个并发 PATCH（例如客户端 A 改 `pinned`、客户端 B 改 `title`，或多个 tab 上同时点 pin/title 编辑）会互相覆盖：后写者用的是它读到的旧 existing，没看到对方的改动。`lastSeenAt`（高频写）也走同一路径，会进一步放大冲突窗口。
- **严重度**：中
- **建议方向**：要么按 sessionId 串行化（per-id mutex），要么把 partial merge 下沉到 `meta/store` 层做 file-lock + read‑modify‑write。或最起码把 `lastSeenAt` 单独走一条只追加该字段的路径。

### F-02 fork 路由没校验 `targetEntryId` 真的是源 session 的 entry
- **位置**：app/api/sessions/[id]/fork/route.ts:31-69
- **现象**：只检查 `targetEntryId` 是非空字符串；`SessionManager.forkFrom` 拷贝完整 jsonl 后，路由把 `targetEntryId` 原样回显给前端，由前端再调 `navigate_tree`。源里若没有这个 id，前端 navigate 时才会报错。
- **为什么不合理**：fork 文件已经创建，但 navigate_tree 失败 → 用户看到一条 leaf 在末尾的"莫名 fork 出来的整段历史"。重试无法回滚，需要手动删。也容易被构造请求做"造垃圾会话"。
- **严重度**：低（前端正常路径不会触发，但容错性差）
- **建议方向**：fork 前 `SessionManager.open(sourcePath).getEntry(targetEntryId)` 校验，缺失就 400；要么 fork 成功但 navigate 失败时主动 unlink 新建文件。

### F-03 DELETE 部分失败时，meta/progress 已被清，jsonl 还在
- **位置**：app/api/sessions/[id]/route.ts:99-118（循环里先 unlink，再无条件 `deleteMeta` / `deletePersistedProgress`）
- **现象**：单条目 unlink 失败会进 `errors`，但同一轮内紧接着仍然 `await deleteMeta(t.id)` 和 `deletePersistedProgress(t.id)`。最后返回 500。
- **为什么不合理**：用户重试或刷新后看到 jsonl 残骸，但 pin / title / lastSeenAt / 持久化 progress 已经丢；下次 listAll 拉到这条 jsonl 时它会变成"无 meta、无 progress"的孤儿，且不可恢复。
- **严重度**：中
- **建议方向**：失败时跳过该 id 的 meta/progress 删除（先 unlink 成功才动 meta）；或者把整个 DELETE 做成"两阶段"——先全部 unlink，再统一清 meta/progress。

### F-04 GET /api/sessions/[id]/context 的 `interrupted` 不写回持久化 progress
- **位置**：app/api/sessions/[id]/context/route.ts:60-83
- **现象**：检测到未配对工具调用且无活 agent → `progress = markInterruptedProgress(progress)`，但只把变形后的对象塞进响应，没有 `writePersistedProgress`。
- **为什么不合理**：每次请求都重做一遍这个推断；如果 progress 文件本身的"completed"快照与真实状态不符，外部读取（导出、其他流程）拿到的还是旧值，只有走这个路由才会看到 interrupted。语义不一致。
- **严重度**：低
- **建议方向**：第一次推断到 interrupted 时同时写一份"interrupted snapshot"到 file-store；或在文档里明确"interrupted 仅运行时计算"。

### F-05 `findSessionPathById` / `getSessionDetail` / `collectSessionDescendants` 各自全盘 listAll
- **位置**：lib/sessions.ts:117-119, 132-141, 99-115
- **现象**：每个 helper 都 `await SessionManager.listAll()`（跨所有项目目录扫 jsonl + 解析 header + 部分内容）。DELETE 一次请求至少触发 1 次（cascade），fork 路由同时调 `findSessionPathById` + `getSessionDetail` = 2 次完整 listAll。
- **为什么不合理**：会话数到几百以上时单次 API 调用都要 100+ ms 磁盘扫描；并发请求会互相拖慢。在长跑机器上明显感知。也意味着大量 jsonl 解析开销重复发生。
- **严重度**：中
- **建议方向**：抽一个进程内 `id → path` 缓存（监听 chokidar 或 mtime 失效），或至少在单个请求内复用一次 `listAll` 结果。

### F-06 listAllSessions stub 注入逻辑下，registry 中存在多个 hidden agent 时可能产生重复行
- **位置**：lib/sessions.ts:62-91
- **现象**：stub 只看 `sessionFile` 是否在 `onDiskPaths`，不再用 `seen by id`。如果 registry 里两个 summary 共享同一 `sessionId`（比如 hidden 子 agent + 父 agent 都对应同一 sessionFile，但其中一个 sessionFile 路径解析与磁盘字符串不一致），可能往 `enriched` 里 push 重复 id。
- **为什么不合理**：前端 sidebar 按 id 渲染时若是 list 而非 map，会出现"两条同一 session"的鬼影；按 map 也可能拿到 stub 而非真值，覆盖错的字段。
- **严重度**：低（前提条件较窄）
- **建议方向**：stub 注入前用 `enriched` 已有 id 做去重；并对比 `resolvePath(s.path) === resolvePath(summary.sessionFile)`。

### F-07 PATCH 重命名没有去重 / 无变化短路，会污染 jsonl
- **位置**：app/api/sessions/[id]/route.ts:36-58
- **现象**：每次调用都 `appendSessionInfo(name)`，即使 name 没变化、即使连续 5 次同名提交。
- **为什么不合理**：jsonl 长期 append 会形成大量同 name 的 session_info entry，污染 tree 视图、徒增体积；也容易被前端 onBlur 之类多次触发。
- **严重度**：低
- **建议方向**：与 `sm.getSessionName()` 比较，相同则直接返回 `{ ok: true, id, name }`，不写盘。

### F-08 export 路由把整个 session HTML 一次性读进内存
- **位置**：app/api/sessions/[id]/export/route.ts:65-78
- **现象**：先 `exportFromFile(path, { outputPath })` 写到 tmp，然后 `await fs.readFile(outPath, "utf8")` 一次性读进字符串再 Response 返回；没有流式。
- **为什么不合理**：长 session（几十 MB jsonl 渲染出来更大的 HTML）会一次性吃内存；并发导出几条就把 worker 顶住。还会丢掉已经写到磁盘的 outPath 的内容副本（无 fsync 等可观测性）。
- **严重度**：低
- **建议方向**：直接 `Response(fs.createReadStream(outPath))` 流式回传，删除 tmp 用 finalizer 而不是 try/finally。

### F-09 DELETE dispose 仅按 sessionFile 匹配，可能漏掉别名路径上的 agent
- **位置**：app/api/sessions/[id]/route.ts:84-94
- **现象**：`targetPaths = new Set(targets.map(t => t.path))`，循环 `summary.sessionFile && targetPaths.has(...)` 才 dispose。`SessionManager.listAll()` 返回的 `path` 与 `summary.sessionFile`（agent-registry 写时已 resolvePath）若来自不同来源，字符串可能不严格相等（例如 symlink、不同前缀）。
- **为什么不合理**：留下来的 agent 在文件被 unlink 后还会继续 `appendFileSync` —— SDK 的 `_persist` 不检查文件存在；写一段时间后 EBADF / 写到孤立 inode。日志噪声 + 数据泄露到不可见路径。
- **严重度**：中（仅在路径形态不一致时触发）
- **建议方向**：dispose 时同时按 `sessionId` 匹配，或先 `resolvePath` 两边再比对。

### F-10 上下文分页接口缺少 `tail`/`before` 互斥与上限校验的明确错误
- **位置**：app/api/sessions/[id]/context/route.ts:25-49
- **现象**：当 `tailRaw="abc"` 或 `beforeRaw="-1"` 时，`Number()` 得 NaN/-1，分支条件 false → 回退到"全量 context"。客户端没收到 400，反而拿到一份"非预期但语法对"的响应。
- **为什么不合理**：UI 调试时容易把"没分页"误以为"没有更多数据"。同时 `limit` clamp 在 [1,200]（lib/sessions.ts:178, 199），但路由层不 clamp，端点向用户屏蔽这个细节。
- **严重度**：低
- **建议方向**：参数解析失败显式返回 400；或在响应里带 `{ paged: true|false }` 指示降级。

### F-11 fork 路由直接复用源 cwd，跨机器迁移场景静默失败
- **位置**：app/api/sessions/[id]/fork/route.ts:50-61, 71（`SessionManager.forkFrom(sourcePath, sourceCwd)`）
- **现象**：从 detail.info.cwd 拿到原 cwd（可能是另一台机器、或被删掉的目录），直接 `forkFrom`。
- **为什么不合理**：新 session 的 header.cwd 写成不存在路径，后续 agent 起来运行 bash/file 工具会立刻失败，但 fork API 已经返回 200。
- **严重度**：低
- **建议方向**：fork 路由可选 `cwd` body 字段；缺省时校验源 cwd 存在（`fs.stat`），不存在则 400 让前端选择新 cwd。

### F-12 session GET（按 id）没有兜底从 registry 找路径
- **位置**：app/api/sessions/[id]/route.ts:18-32（`getSessionDetail` 走 SessionManager.listAll）
- **现象**：刚刚 `POST /api/agent/new` 拿到 sessionId、还没写满首条 assistant message 时，`buildSessionInfo` 返回 null（无 message 直接被 listAll 的 `entries.length === 0` 过滤）。前端立
===== runtime full =====
我将审计会话运行时相关代码。先定位文件结构。

---

session-runner.ts 主要是类型/工厂，没有运行时逻辑。重点应该在 agent-registry.ts 和 runtime/。

---

现在重点审计 agent-registry.ts，分段读取：

---

全部读完了。现在看 SSE 路由（API 层）来评估约定一致性：

---

现在看 agent/new 路由处理并发会话冲突：

---

看一下 getEarliestEventSeq 的逻辑边界判断、以及 SSE state_reset 触发条件：

---

检查 SSE since 计算是否正确处理 -1 / 0（since=-1 时 earliest>0 触发 state_reset 的条件 `since < earliest - 1`，如果 since=-1 表示从头开始，但 buffer 已被覆盖时仍然不会触发？）：

第一次连接 since=-1，earliest>0，`-1 < earliest-1` 为 true，确实会发 state_reset。但若 since=-1 时 buffer 还没满（nextSeq <= MAX），earliest=0，`-1 < -1` 为 false，不重置，正常回放。看起来 OK。

但是 since=0 表示「我已经收到 seq=0」，希望 seq>0 的事件。如果 buffer 已满，earliest=nextSeq-5000，假设 earliest=5000，`0 < 4999` true，触发 reset。OK。

但 since=earliest-1 时：`since < earliest - 1` 是 `earliest-1 < earliest-1` = false，不重置。可是这种情况 since 已经在 buffer 边界，回放从 since+1=earliest 开始，OK。

但 **since=earliest-2 时**：`earliest-2 < earliest-1` true，state_reset 必要。OK。

看起来边界 OK。然而注意一个问题：`getEventsSince` 在 buffer 已满时如果 `since` 是个非常旧的值，会返回所有 5000 条；但客户端缺失的是 `[since+1, earliest-1]` 这段，这些会丢。state_reset 解决了这个问题。OK。

下一个关注点：finishWatchdog。它在 message_end 时调度 1500ms，到期后 `finishStreamingRun` 把 isStreaming 设置 false 并 `maybeContinueGoal`。但是 SDK 后续发的 agent_end 还会进 listener 调一次 finishStreamingRun（因 `if (!rec.isStreaming) return` 短路），这没事。但 watchdog 触发时**没有 push agent_end 事件**，前端 reducer 可能仍认为还在流式；而且 mirrorRuntimeEvent 也不会接到 agent_end。

---

确认：在 SDK 路径下，watchdog 触发只调用 `finishStreamingRun`（只翻 isStreaming 标志、未 push agent_end）。前端 chat-reducer 是基于 SSE 事件的，它不会知道这个内部状态翻转。看下 reducer 是如何决定 streaming 停止的：

---

reducer 似乎不直接消费 agent_end。但 SessionRuntimeState 通过 listAgentSummaries 暴露 isStreaming，sidebar 会用。Watchdog 只翻 `rec.isStreaming` 这个内存 flag，但 runtime_event 仅来自 mirror，没有 mirror agent_end → runtime event 状态会"卡在 running"。

继续看 abort 路径里有个 SSE 的潜在问题：abort 后没 push agent_end，但 finishStreamingRun 在 watchdog/agent_end 才走，会跳过 goal 的 finishGoalTurn / maybeContinueGoal。

---

abort case 在 route.ts:719 直接置 `rec.isStreaming = false`，而 **没有调 `finishStreamingRun`**——这绕过了 finishGoalTurn 的 turn 关闭逻辑（goal turn 留在 open 状态），并且 `maybeContinueGoal` 不会被触发（虽然这通常对 abort 是期望的）。但 goal turn 关不掉有问题。

继续看 `claimClientRequest` 在 prompt error 时 `clearClientRequest`——但若是 SDK prompt 抛错，rec 在 prompt 之前已 push 了 optimistic_user_ack 进 ring buffer，前端已经创建了 user 气泡。SDK throw 后端 clear 了 dedupe key，前端的 pending user 气泡如何被清除？看下：

---

所以 prompt 失败时，optimistic_user_ack 已经发了（ack 把 pending 设为 false 了！）；server 端 throw 抛 500 后，前端还能通过 `__optimistic_user_failed` 修复吗？由于 ack 已把 pending 清成 false，在前端代码里 `__optimistic_user_failed` 找的是 `pending`。所以**ack 后再 throw → 前端永远看不到失败标记**——气泡会停在"已发送"但 SDK 没真的开始执行（或在中途失败），用户 confused。

继续看 client_request 去重 + retry 错误路径。`recentClientRequests` 在 record 刚创建时 set Map(），但 `claimClientRequest` 内部判断 `if (!rec.recentClientRequests) ... = new Map()`——是冗余但安全的。

回到关键：检查 SSE 控制器的 backpressure：

`controller.enqueue` 在 ReadableStream 里没限速，listener->scheduleFlush 不会 await enqueue 完成。如果客户端读得慢（断线/CDN buffering），事件会堆在 controller 内部 queue。但 next.js Web Streams 通常没暴露 desiredSize 检查。这里的 16ms 节流其实只是合并刷新，不解决 backpressure，是个潜在的内存压力点。

再扫些剩余文件以保证覆盖：

---

local-coding-assistant 路径里也有问题：在 prompt CLI failed 之前 push 了 message_start (assistant)，CLI 失败后只 push agent_end，**没有 push message_end**——前端的 assistant 气泡可能停在 streaming 状态。

另外，`promptLocalCodingAssistantAgent` 在 child 启动后并没有把 `rec.external.child` 置位之前 await，`rec.external = {child: null, ...}` 先被覆盖成新对象，然后 `child = spawn(...)`，再 `rec.external.child = child`。如果 SIGTERM 在 spawn 与赋值之间到来，abort 路径只看到 child:null，无法 kill。

再看 CLI 模式下并发保护：函数开头 `if (rec.external?.child)` throw，但**第二次调用时若 stage 处于 spawn 期间**（rec.external.child 还是 null 的窗口），可以同时启动两个 child 进程。

继续看 createAgent 复用逻辑：

---

createAgent 的复用是按 sessionPath 查找，但**没有锁**：两个并发请求同时刷新会话页（首次都没拿到 existing），都会进入下方走完整 createAgentSession 流程，最终注册两个 agentId 指向同一 sessionFile（second one overwrites jsonl）。这是一个明显竞态。

也注意到——`createAgent` 不创建并发锁；前端 useAgentEvents 触发的 reuse 会被双开 SDK，可能让 SessionManager.open 同 path 两次 → jsonl 文件被双 writer 损坏。

最后看 SettingsManager 等的缓存清理：dispose 不清理这些 cwd-key Map，长跑会累积。但是不大重要。

够了，写报告。

---

## 会话运行时与 SSE 审计

### F-01 abort 不调用 finishStreamingRun，goal turn 与运行时事件无法收尾
- **位置**：`app/api/agent/[id]/route.ts:706-720`
- **现象**：`abort` action 只把 `rec.isStreaming = false` 直接赋值，绕过 `finishStreamingRun(rec)`。后者本来要 `finishGoalTurn`、关闭 goal 当前 turn、并 `maybeContinueGoal`。同时该路径完全没有 `pushAgentEvent(rec, { type: "agent_end" })`，前端通过 SSE 看到的事件流里 abort 只触发 `rec.session.abort()`（SDK 不一定补 agent_end）。
- **为什么不合理**：用户点 stop 后，进行中的 goal turn 永远停留在 `running`，`listGoalTurns` 里这条 turn 没有 `endedAt`/`status`，UI/会话历史显示一条"还在跑"的 turn。`mirrorRuntimeEvent` 也再无 `agent.end` 落库，导致 runtime_events 时间线里这次 run 的状态只有 running 没有终止，审计/前端 hud 都会出错。
- **严重度**：中
- **建议方向**：abort 路径应统一走 `finishStreamingRun(rec)`（必要时附加 abort 标志），或显式 `pushAgentEvent(rec, { type: "agent_end", ... })` 让 watchdog/turn/SSE 同步收尾。

### F-02 `finishWatchdog` 兜底翻 `isStreaming`，但不补发任何终止事件
- **位置**：`lib/agent-registry.ts:599-630`、`1880`
- **现象**：`scheduleFinishWatchdog` 在 `message_end` 后 1500ms 触发 `finishStreamingRun(rec)`，把 `isStreaming` 置 false 并关 goal turn，**但没有 `pushAgentEvent` 任何 agent_end / message_end 类事件**。
- **为什么不合理**：watchdog 的存在意义就是"local shim 漏发 agent_end"——既然要兜底，就只兜了服务端内部状态、没兜对外契约。结果：(1) 通过 SSE 订阅的前端 reducer 不知道这一轮结束，phase 仍卡在 thinking/streaming；(2) `runtime/event-store` 也没有 agent.end mirror，`runtimeState` 只能通过其他路径变 done；(3) `lastAgentEndAt = Date.now()` 已经 set 了但前端永远 reconcile 不到这个时间。两条路径不一致。
- **严重度**：中
- **建议方向**：watchdog 触发时也 `pushAgentEvent(rec, { type: "agent_end" })`，让 SSE 与 runtime mirror 走同一个真相。

### F-03 prompt 失败时已发出 optimistic_user_ack，前端无法回滚
- **位置**：`app/api/agent/[id]/route.ts:436-475`，配合 `lib/chat-reducer.ts:806`
- **现象**：prompt 流程为：(a) `claimClientRequest` → (b) `pushExternalEvent(rec, optimistic_user_ack)` → (c) `await rec.session.prompt(...)`；若 (c) throw，catch 里只做 `clearClientRequest`，再把异常抛 500。但 ack 已经把前端 user 气泡的 `pending` 置为 false（reducer:828）。
- **为什么不合理**：`__optimistic_user_failed` reducer 分支只对 `pending===true` 的消息生效（chat-reducer:847）。一旦 ack 已过，前端再判定失败也不会标红/可重发的"失败"状态。用户体验上看气泡是"已发送"，但 SDK 实际没接受这条消息（例如模型未配置、上游 401、SDK 抛错都属此类）。同时 dedupe key 已 clear，用户再次点 send 是"新一条"，旧气泡还留在那里。
- **严重度**：中
- **建议方向**：调换次序——只在 `prompt()` 调用成功（或至少 enqueue 成功）后再发 ack；或新增一个 `optimistic_user_failed` 服务端事件，从 ring buffer 推回到前端，让 reducer 找 `pending===false && clientRequestId===X` 也能标失败。

### F-04 createAgent 对同一 sessionPath 的复用存在竞态
- **位置**：`lib/agent-registry.ts:986-996`
- **现象**：复用判断是 `Array.from(reg.agents.values()).find(...)`，没有锁。两次几乎同时到达的请求（前端切换/刷新双开、移动端断线重连等）都会发现 `existing===undefined`，于是各自走 `SessionManager.open(opts.sessionPath)` + `createAgentSession`，最终在 `reg.agents.set(id, record)` 注册两个不同 `id` 但共享同一 `sessionFile` 的 agent。
- **为什么不合理**：(1) 两个 SessionManager.open 同时持有相同 jsonl 的写句柄，pi-coding-agent 内部对 jsonl 是 append；并发写虽不至撕裂行（fs.write atomic-line on small writes 不是保证），但事件顺序一定错乱；(2) goal/clarification/approval 的 server-store 是 by agentId 索引，会出现"用户在 agentA 里 approval，子流是 agentB"的撞车；(3) `getRunningSessionFiles` 会重复看到同一 sessionFile，sidebar "running" 状态稳定但不可推断到底哪个 agent 是真活的。
- **严重度**：高
- **建议方向**：在 createAgent 入口加 per-sessionPath 的 in-flight Promise map（`pendingByPath: Map<string, Promise<...>>`），让同 path 的并发请求复用同一个 promise；或在 createAgent 入口 `await new Promise(setImmediate)` 之类不能保证顺序，最好显式 lock。

### F-05 LocalCodingAssistant：spawn 之间无并发保护、失败时漏 message_end
- **位置**：`lib/agent-registry.ts:824-922`
- **现象**：(a) `if (rec.external?.child) throw` 只能拦住 child 已赋值的情况；函数前段 `rec.external = { child: null, emittedText: "" }`，随后 `await resolveLocalCodingAssistantCli()` 是 async 间隙，期间第二次调用看到 `rec.external.child===null` 不会抛、继续 spawn，最终两个 child 同时跑，emit 互相串。(b) CLI 失败分支（`resolveLocalCodingAssistantCli` 抛错）只 `pushAgentEvent agent_end`，但前面已 push `message_start` (assistant)。前端看到 assistant 气泡 start 而无对应 message_end，气泡停在 partial 状态。
- **为什么不合理**：local CLI 路径用 `rec.external.child` 当并发哨兵但赋值时机晚于 isStreaming/message_start。任一异步窗口都会让"两个 CLI 跑同一 agent"成为可能。message_end 缺失则违反 SDK 事件契约（前端 reducer 依赖 message_end 来收尾 partials）。
- **严重度**：中
- **建议方向**：在最早窗口判定/占位 `rec.external = { kind, child: PENDING }`，或者用一个 Boolean flag `localBusy` 在函数最前置位；CLI 启动失败/退出非零路径都补一条 `message_end { stopReason: "error" }` 后再 `agent_end`。

### F-06 SSE 16ms 节流没考虑 backpressure，慢消费会无界堆积
- **位置**：`app/api/agent/[id]/events/route.ts:96-115`
- **现象**：`scheduleFlush` 每 16ms 把 `getEventsSince(...)` 的差量全部 `controller.enqueue`，从未检查 `controller.desiredSize`、也没限速。如果客户端读慢（移动网/反代缓冲/暂停 EventSource），enqueue 会堆在 ReadableStream 内部 buffer，Node 不主动断流；高频 token_delta 5000 条上限即 5000 个 SSE chunk。
- **为什么不合理**：长跑 + 慢消费下后端进程内存被 SSE buffer 拉爆；ring buffer 已经按 5000 上限保护，但 controller queue 没。再叠加心跳 15s 看不出客户端早就背压。
- **严重度**：低 / 中（取决于网络质量）
- **建议方向**：`enqueue` 前看 `controller.desiredSize`，<=0 时跳过本轮 flush 并把 `lastSentSeq` 留低；下次 flush 用 ring buffer 重新拉差量。或退一步：定期检测 `req.signal.aborted` + `setTimeout(0)` 让事件 loop 喘息。

### F-07 SSE since 解析对非法值 / NaN 不防御
- **位置**：`app/api/agent/[id]/events/route.ts:46-53`
- **现象**：`since = sinceRaw === "latest" ? getLatestEventSeq(id) : Number(sinceRaw)`。当 `?since=foo` 或 `Last-Event-ID: foo` 时 `Number()` 返 NaN；后续 `since < earliest - 1` 与 NaN 比较恒为 false，走"普通回放"分支：`getEventsSince(id, NaN)` 内部 `e.seq > NaN` 也是 false，结果一条都不返回。前端拿不到回放且不会触发 state_reset，黑屏到下一个 live event 才动。
- **为什么不合理**：恶意/旧客户端发非法 since 会让会话静默卡住；EventSource 自动重连场景下 last-event-id 字段被代理改写也会触发。
- **严重度**：低
- **建议方向**：`Number.isFinite(since)` 校验；非法当 -1 处理，跑全量回放/必要时 state_reset。

### F-08 `recentClientRequests` 在前端"重发"语义下与 ack 之后失败配合不良
- **位置**：`lib/agent-registry.ts:343-374`、`app/api/agent/[id]/route.ts:472-475`
- **现象**：dedupe TTL 默认 `DEFAULT_CLIENT_REQUEST_TTL_MS`；prompt 失败时 `clearClientRequest` 只在 catch 内删 key。但若 `pushExternalEvent(optimistic_user_ack)` 与 SDK throw 之间，前端因网络断线没收到 500 响应，会按 `optimistic_user_failed` 客户端兜底重发——但 server 已 clear，前端发同一 `clientRequestId` 就再次 claim 成功，`pushEx
===== hooks full =====
我开始审计前端会话 hooks 与 SSE 客户端相关代码。

---

现在我有完整代码。下面给出审计发现。

---

现在我对代码有充分了解，可以输出审计结果。

---

# 审计报告：前端会话 hooks 与 SSE 客户端

### F-01 SSE 没有任何重连策略，断线后永久 "lost"
- **位置**：app/hooks/useSseManager.ts:277-281
- **现象**：`onerror` 仅把状态置为 `"lost"`，从不重新创建 EventSource。注释也承认"重连 / 断线重试策略 → 暂留 ChatApp"，但实际 ChatApp 也没主动 reattach（仅在 `attachSseFor` 显式被调时才换连接）。EventSource 浏览器原生会自动重连失败请求，但服务端 5xx / 关闭连接后 readyState 进入 CLOSED 时它就不再重试。
- **为什么不合理**：网络抖动 / Next 热重启 / 后端短时不可用后，SSE 状态保持 `lost`，新事件全部丢失；用户必须切 session 或刷新页面才能恢复 streaming。后台跑的 turn 即使最终 agent_end，前端也看不到。
- **严重度**：高
- **建议方向**：onerror 检查 `readyState === CLOSED` 时安排带 backoff 的 reattach（仍用 `lastSeqRef` 的 since 续传，后端已支持）；或者在 useChatStream 中暴露主动 reconnect 入口给 UI。

### F-02 SSE 错误吞掉细节，调用方拿不到原因
- **位置**：app/hooks/useSseManager.ts:277-281；app/hooks/useChatStream.ts:584, 638
- **现象**：`es.onerror` 只 `console.warn`，事件对象没有 status code / response 信息（EventSource 限制）；并且 `useChatStream` 内多处 `agentAction` 失败用 `try {} catch {}` 完全静默（onAbort/onCompact/onAbortCompaction/onChangeThinking/sendAgentText）。
- **为什么不合理**：当后端拒绝 abort/compact（agent 已被销毁、权限失败等）时 UI 既不告诉用户，runner 状态也已经被 optimistic 清掉（`streaming:false / progress: failOpen`），看起来"成功了"实则后端还在跑。
- **严重度**：中
- **建议方向**：catch 内至少 `setError(userFacingMessage(e))`；onAbort 失败时回滚 streaming 标志或保留 progress。

### F-03 lastSeen 持久化竞态：localStorage 与 server PATCH 互相覆盖
- **位置**：app/hooks/useSessions.ts:90-99（`persistServerLastSeen`）+ 254-269（`markSessionSeen`）+ 358-365（`refreshSessions` 的 mergeServerLastSeen）
- **现象**：每次 `markSessionSeen` 都向 `/api/sessions/:id/meta` 发 fire-and-forget PATCH，且失败完全静默（`.catch(() => {})`）。同时每次 polling/refreshSessions 都调 `mergeServerLastSeen`：仅当 `next[id] < seen` 才覆盖；这导致客户端 lastSeen 高于 server 的 PATCH 失败结果会一直持续，server 视角永远停留在旧值。
- **为什么不合理**：跨设备/多 tab 已读不一致；尤其是 PATCH 在第一次失败但本地 already 写入后，这条消息在另一个设备永远显示未读。
- **严重度**：中
- **建议方向**：PATCH 加重试 / 失败时回滚 localStorage 标记；或承认 localStorage 是真值，定期单向 push。

### F-04 markSessionSeen 在 sessions 变化时每次都尝试微任务标记，仍可能错过 in-flight PATCH
- **位置**：app/hooks/useSessions.ts:294-302
- **现象**：sessions 数组每次 refreshSessions（无 diff 时已通过 `sameSessionList` 短路）变化都会 `queueMicrotask(() => markSessionSeen(...))`。在窗口聚焦的连续流式更新（每秒数次 setSessions）下，会高频触发 `markSessionSeen → setLastSeenMap → writeLastSeenToStorage → fetch PATCH`。
- **为什么不合理**：streaming 期间每次 modified 变化都会触发一次 fetch PATCH /meta；几十秒长 turn 可能产生数百次写。占用 server 连接、写盘，且大多数 PATCH 完全冗余。
- **严重度**：中
- **建议方向**：对 PATCH 节流（同 sessionId 在 N 秒内合并）；或仅在 modified 真正前进且距上次 PATCH > X 时才发。

### F-05 sameSessionList 漏字段对比，可能错失 UI 更新
- **位置**：app/hooks/useSessions.ts:155-186
- **现象**：浅比 17 个字段，但例如 `meta.title`/`meta.pinned`/`meta.lastSeenAt` 比了，`meta.archived`、`meta.color`、`meta.tags` 等如有扩展则被忽略；同时如果未来 `SessionInfoLite` 加字段（如 `cwdLabel`、`projectId`），列表不会重渲。
- **为什么不合理**：此函数被作为唯一 diff gate（"same → 直接返回 prev"），新字段静默不更新会非常难调试。
- **严重度**：低
- **建议方向**：用浅 key 比较所有顶层 + meta 全部 key（Object.keys 快路径）；或将其按 immutable identity（path+modified+lastEventSeq）做主键，meta 走单独引用比较。

### F-06 删除 session 时使用 selectedId 闭包陈旧值
- **位置**：app/hooks/useSessions.ts:443-466
- **现象**：`executeDeleteSession` 依赖 `selectedId`（state）做兜底判断（`else if (selectedId && deletedIds.has(selectedId))`），但函数体里已经把 `selectedId` 加进 `useCallback` deps；调用 → 异步 await fetch → 期间用户可能切 session。这时 `selectedId` 还是旧的，可能错误地把当前显示的会话 setSelectedId(null)。
- **为什么不合理**：删除一个非当前 session 但 selectedId 在 await 中刚切到一个无关 session，依然能命中清空。
- **严重度**：低
- **建议方向**：用 `selectedIdRef.current` 而非闭包变量；或者只用 activeKey 判断兜底。

### F-07 lastSeqRef key=RunnerKey 但 since 校验只用 agentId 做相同判断
- **位置**：app/hooks/useSseManager.ts:230-237、262-271
- **现象**：`lastSeqRef.set(key, { agentId, seq })`，attach 新连接时若 `record.agentId !== agentId` 则用 `-1`。但 RunnerKey 是 sessionPath；同一个 sessionPath 不同时间的 agent 可能复用同一 path（重启 / fork resume）。当之前 agent 残留 lastSeq 较大，新 agent 不应继承——这点已处理。但反向情况：如果**同一 agentId 跨断线 reattach**（如 onerror 后未来重连），由于 lastSeqRef 仍保留，since 会用旧值，但 close→delete 已经清除（line 196）。
- **为什么不合理**：F-01 暗含的重连一旦实现，会因 close 把 lastSeq 也清了→since=-1→重发整段历史→reducer 去重需要做更多工作（可能引出 dup 气泡）。
- **严重度**：中（与 F-01 联动）
- **建议方向**：close 时只清 generation，保留 lastSeq；attach 同 agentId 时复用 since。

### F-08 RAF flush 中单条 dispatch 抛错只 log，事件被丢弃且无指标
- **位置**：app/hooks/useSseManager.ts:155-161
- **现象**：`for (const item of pending) { try { onEventRef.current(...) } catch (err) { console.error("[sse] dispatch failed", err); } }` —— 单条 reducer 抛错，整段事件继续，但 reducer 状态可能已被部分污染。
- **为什么不合理**：reducer 中处理 tool 事件时若有 invariant 抛错（如 finalText undefined），后续 token 全被消费，状态变得不可追溯；用户无任何提示。
- **严重度**：低
- **建议方向**：抛错时把该 runner 标 sseStatus=lost 并触发 reload；或 surface 到 setError。

### F-09 ensureAgent 失败后 optimistic sidebar 项被遗弃（孤儿）
- **位置**：app/hooks/useChatStream.ts:381-401
- **现象**：先 `await fetch /api/agent/new`，成功才 attachSse + upsertOptimisticSession。但**send 路径**：optimistic user message 通过 `__optimistic_user` 已 dispatch；如果接下来的 `agentAction(prompt)` 失败（line 538-547），只用 `__optimistic_user_failed` 标记 user 气泡，不会取消 optimistic sidebar 行 —— 但这条 sidebar 行已绑定 sessionFile（agent 已创建）。
  另一种情形：`upgradeDraftIfNeeded` 在 `runnersRef.has(newKey)` 时直接返回（line 263-269），不再 set runner——可能漏 setRunner(DRAFT, emptyRunner)，导致 draft runner 残留输入。
- **为什么不合理**：第一种 case 用户看到一个空会话出现在 sidebar，很难判断是否真创建。第二种 case 切回 draft 后还能看到旧附件。
- **严重度**：中
- **建议方向**：发 prompt 失败时保留 sidebar 项（agent 是真创建的，用户可重发），但把状态明确为 "failed"；或者 has(newKey) 分支也清 draft。

### F-10 startWorkflow / startGoal 不清 input、不清 attachments
- **位置**：app/hooks/useChatStream.ts:567-600（startGoal）、612-680（startWorkflow）
- **现象**：与 `send()` 不同，goal/workflow 既不调 `setInput("")` 也不 `setPendingImages([])` / `setPendingFiles([])`。
- **为什么不合理**：用户用 /goal 后 Composer 里仍残留刚才输入的 objective；下一次 send 会再次发送一次。如果带 pendingFiles，附件会和 goal 同时被 optimistic 消费？这里又没把 attachments 传给 agentAction，附件被静默丢弃。
- **严重度**：中
- **建议方向**：成功 dispatch 后清 input 和 attachments；或在 Composer 入口对 /goal /workflow 调用前就清。

### F-11 guardActiveKeyMatchesSelected 在 selectedSession 找不到 path 时直接放行
- **位置**：app/hooks/useChatStream.ts:496-501
- **现象**：`if (!selectedSession?.path) return true;`——sessions 列表尚未加载或被刚删但还没 refresh 的窗口里，会把"看似选中"的 session 当作不存在直接放行，prompt 落到 active runner（可能是另一个 session）。
- **为什么不合理**：边界情况下越权写到错的 session（特别是 polling 还没回来的瞬间）。
- **严重度**：中
- **建议方向**：找不到时改为返回 false 并 setError("会话信息尚未就
===== reducer full =====
我开始审计会话状态机 + fork/export/context-aside 路径。

---

现在审计 chat-reducer.ts。先看结构：

---

现在已经掌握 reducer/turn-state/context-aside/fork/export 的完整实现。看一下 context-aside 在哪里被注入（发送侧）以便确认对应的注入点：

---

看一下 fork API 的几个细节问题：targetEntryId 传了但实际没用（仅返回回去）。再看 `forkFrom` 的 SDK 行为：

---

看一下 export 路由的潜在问题：

---

现在我有足够信息开始写报告。补充确认一下：fork 拷贝出新 session 之后的 leaf 截断时机和 export 的并发安全：

---

够了。开始撰写审计报告。

---

## 会话状态机 + fork/export/context-aside 审计

### F-01 fork API 收下 `targetEntryId` 但完全不使用，仅当回显
- **位置**：app/api/sessions/[id]/fork/route.ts:33-79
- **现象**：路由强校验 `targetEntryId` 必须非空字符串，但实际只把它原样塞回 response。真正把 leaf 截到 fork 点的 `navigate_tree` 完全靠前端 `useForkable.ts:267` 在另一次往返里做。新文件落盘时 leaf 仍然是源 session 末端。
- **为什么不合理**：① 任何直接调用此 API（脚本、curl、远程 client）但不接 `navigate_tree` 的调用者都会拿到一份「leaf 没截断」的拷贝，外观像"未完成的 fork"，再次发 prompt 会从源 session 末尾续写而不是从指定 entry 续写。② 服务器到客户端两步竞态：步骤 1 成功而步骤 3 失败/中断（网络抖动、用户切走 session）会留下脏 fork，没有事务回滚。
- **严重度**：高
- **建议方向**：要么把 navigate_tree 拉到 server 端做成原子接口，要么文档化"fork API 只造文件，调用方必须紧跟 navigate_tree"，并在远程返回里明确 `leafId` 让客户端能验证。

### F-02 fork 失败 / cwd 缺失时，错误码不一致
- **位置**：app/api/sessions/[id]/fork/route.ts:50-63
- **现象**：源 session 找不到 → 404；source detail 读不出来 → 500；源 session 没 cwd → 400。
- **为什么不合理**：source detail 失败被归为 500（"source session not readable"），但很多失败情况其实是文件被外部删除/正在重写——等价于 404。当前 500 会触发上游告警/重试，体感是服务端故障。
- **严重度**：低
- **建议方向**：把 detail 读取失败 + path 仍存在的边界明确成 409 或 404；并把 SDK forkFrom 抛错的 catch 里区分 ENOENT。

### F-03 reducer `__fork_replace_user` 截断后未清理 `completedAssistantResponseIds`
- **位置**：lib/chat-reducer.ts:851-871
- **现象**：fork-replace 执行 `state.messages = state.messages.slice(0, index + 1)`，并清掉 `activeAssistantIndex / Replay`，但 `completedAssistantResponseIds`（最近 20 个已完成 responseId）保持原样。
- **为什么不合理**：fork 后重发会拿到新一轮 SDK message，但若 SDK 复用旧 responseId（reconnect / 重放场景），`message_update` 在 line 982 的"已 completed → 直接 return"分支会误吞掉首批 delta，UI 表现为"新轮第一段文字丢失"。触发概率低，但发生时极难定位。
- **严重度**：中
- **建议方向**：fork-replace 时同步清空或裁剪 `completedAssistantResponseIds`（尤其裁掉 fork 点之后产生的 responseId）。

### F-04 `message_start` 衰变兜底分支允许 clientRequestId 为空 → 同文本异源 user 会被错并
- **位置**：lib/chat-reducer.ts:919-935（`isPendingNoCriTextMatch`）
- **现象**：如果 last 是 pending user、没 clientRequestId 且文本与新 message_start 的 textJoined 完全相等，就把 last 衰变。注释说"老客户端 / 未重发路径兜底"。
- **为什么不合理**：在并发场景（用户连发两条相同文本，前一条还 pending），会把后一条 SDK 真消息错并到前一个 optimistic 上，造成第二条 user 永远 pending、第二轮 assistant 接到错误的 user 索引。
- **严重度**：中（取决于用户是否会出现重复文本快速连发）
- **建议方向**：要么彻底删掉这个兜底（现代客户端必带 clientRequestId），要么加一条"该 pending user 的 clientRequestId 必须确认未在 in-flight 队列里"的限制。

### F-05 `message_start` aside-only user 被静默丢弃，缺乏区分日志/标记
- **位置**：lib/chat-reducer.ts:944-948
- **现象**：当 stripContextAside 后 parts.length === 0 时直接 `return state`，不入历史。
- **为什么不合理**：这条规则是为"goal continuation / 隐藏 system prompt"设计的，但同样的形状也可能由 bug 触发（例如某个工具误把整段用户文本包到 aside）。一旦发生，UI 上完全不可见、日志也没痕迹，排查时只能靠 jsonl 比对。
- **严重度**：中
- **建议方向**：保留静默策略，但在 dev 构建里 `console.debug` 一行；或在 ReducerState 里维护一个 `silentlyDroppedUserMessages` 计数供调试面板读取。

### F-06 reducer 内部多处 in-place mutate `parts[idx] = …`，与"必须纯函数"注释自相矛盾
- **位置**：lib/chat-reducer.ts:386-394（sealLastThinkingIfOpen）、1146-1155（tool_execution_update）、1542-1561（tool_execution_end）等
- **现象**：函数注释（line 204-207）明确说"reducer 必须是纯的，不能 in-place 改 part 对象"，并以此为由把 `appendToLastTextPart` 改成 replace。但 `sealLastThinkingIfOpen(parts)` 直接对入参数组下标赋值；`tool_execution_update` 拿到的是 `(msg.parts ?? []).slice()` 后赋值，这层 slice 确实是新数组——但 `sealLastThinkingIfOpen` 调用前的 parts 在大多数路径都是当前 state 的 parts 浅拷贝，OK。问题在 `seal` 函数本身改的是 parts 元素引用而不是新建 part 对象——它新建了 part（`parts[i] = { ...p, endedAt }`），实际上没违反不可变。**误报修正**：复审后实际 OK。但 `tool_execution_end` 那里没有先 `sealLastThinkingIfOpen`，若 thinking 还开着会留下 endedAt=undefined 的 thinking part 到下一轮。
- **严重度**：低
- **建议方向**：在 `tool_execution_end` 里也补一次 sealLastThinkingIfOpen，保证 thinking 在任何"翻篇"事件后都被收口。

### F-07 `ctxToMessages` 不应用 `appendRestoredSubagentBatches` 的逆操作；同一历史会话双重渲染 subagent
- **位置**：lib/chat-reducer.ts:1690-1717、660-684
- **现象**：历史会话恢复时，`ctxToMessages` 在每个 assistant message 内部识别 `delegate_subagents` 工具结果，**生成一个 subagent_batch part**（line 1703-1709）。同时 `appendRestoredSubagentBatches` 又会从 session 持久化的 `subagentBatches` 数组读出已存在的 batch，按 id 去重后**追加一条独立 assistant message**包含所有 part。
- **为什么不合理**：去重判定（line 671：`existing.add(part.id)`）是按 batchId。`subagentBatchPartFromToolResult` 在没有 `details.batchId` 时 fallback 用 `params.toolCallId`（line 583-586），而 SDK 持久化的 SubagentBatch 用的是真 batchId。一旦两者不匹配，UI 同时出现两份 subagent batch 卡片，且持久化的那份 `restored: true`。
- **严重度**：中
- **建议方向**：① 在 fromToolResult 分支强制要求 `details.batchId`，没拿到就 return null；② 或者在 ctxToMessages 阶段不再插入 subagent_batch part，统一交给 appendRestoredSubagentBatches。

### F-08 export route 在并发请求时会因 mtime+id 冲突写到同一文件
- **位置**：app/api/sessions/[id]/export/route.ts:69-85
- **现象**：`outPath = tmpdir/diga-agent-export-${id}-${Date.now()}.html`，毫秒级时间戳。Now() 在同毫秒并发不算极小概率（用户双击下载/前端 retry）。两个请求同时跑 `exportFromFile` 写同一路径，第二个会覆盖第一个；接着二者 finally 各自 unlink，第二个 unlink 时文件已不存在（`.catch(()=>{})` 吞掉），第一个 readFile 可能读到第二个已截断的内容或 ENOENT。
- **为什么不合理**：用户拿到错误 / 半截 HTML，且观察不到错误（catch 吞掉 unlink 失败）。
- **严重度**：中
- **建议方向**：用 `crypto.randomUUID()` 替换 `Date.now()`；或者直接让 SDK 写到内存返回字符串，避免落盘+读盘+删盘往返。

### F-09 export route 通过 `process.cwd()` 绝对路径动态 import SDK 子模块，部署/打包脆弱
- **位置**：app/api/sessions/[id]/export/route.ts:25-50
- **现象**：硬编码拼 `node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/index.js`，绕过 package exports map。注释承认"会触发 Turbopack 警告"。
- **为什么不合理**：任何 hoisted/pnpm 平铺布局变化（npm ci 后 node_modules 被打平到 monorepo 根）都会让此路径失效，运行期才报错。production 构建用 standalone output 时，这个文件会不会被 NFT 抓到完全依赖 `void sdk` 这个副作用 import，靠运气。
- **严重度**：中
- **建议方向**：要求 SDK 把 export-html 加进 `exports` map（或在本仓库做一层 wrapper / 拷贝）。短期至少加 fallback：先尝试 `require.resolve("@earendil-works/pi-coding-agent/package.json")` 求出真实路径再拼子路径。

### F-10 export route 不暴露 themeName / toolRenderer，数据完整性受限
- **位置**：app/api/sessions/[id]/export/route.ts:73-75
- **现象**：调用 `exportFromFile(path, { outputPath: outPath })`，没传 themeName 也没传 toolRenderer。
- **为什么不合理**：本仓库自定义了大量 tool（subagent_batch、workflow_run、approval、clarification）。导出 HTML 时这些自定义 tool 会按 SDK 默认渲染（一般是 args/result raw json），用户拿到的存档对这些卡片不可读。**数据完整性按 SDK 视角不缺，但用户可见信息缺失。**
- **严重度**：中
- **建议方向**：构造一个 ToolHtmlRenderer 把 subagent_batch / workflow_run / approval / clarification 的 args+details 渲成与前端 MessageView 一致的 HTML 片段。

### F-11 turn-state `deriveTurnChromeState` 的 streaming + 中间 turn 判定有死分支
- **位置**：lib/turn-state.ts:33-40
- **现象**：当 `isActiveAssistant=true && streaming=true` → live；

# Session 生命周期审计报告

范围（只读）：
- app/ChatApp.tsx
- app/hooks/useSessions.ts
- app/hooks/useRunners.ts
- lib/composer/input-store.ts
- lib/electron-bridge.ts

按严重度排序，最多 8 条。

---

## Finding 1 — 删除会话时未中止仍在 streaming 的后端 agent

| 字段 | 内容 |
|---|---|
| 严重度 | High |
| 位置 | app/hooks/useSessions.ts:443-472（`executeDeleteSession`） |

代码片段（节选）：
```ts
for (const did of deletedIds) {
  const sel = sessionsRef.current.find((s) => s.id === did);
  if (!sel) continue;
  const key: RunnerKey = sel.path;
  closeSseFor(key);
  deleteInput(key);
  ...
  runnersRef.current.delete(key);
}
```

- 触发条件：用户在 active session（或被级联 fork 子会话）正在 streaming 时点击 "删除"。
- 影响：前端只 `closeSseFor` + `runnersRef.delete`，**没有给该 agent 发 `abort`**。后端 agent 进程可能继续跑到结束（消耗 token / 触发工具副作用 / 生成新文件），用户却以为"已经删了"。对照 `refreshSessions` 内的 orphan 清理（useSessions.ts:368-376）能看出语义不一致——orphan 路径会主动 abort，而显式 delete 反而不会。是否完全靠后端 DELETE 接口级联 abort 未确认；若后端不保证则存在静默泄漏。
- 修复建议：在 `closeSseFor(key)` 之前，对 `runner.agentId && runner.streaming` 的 runner 先 POST `{ type: "abort" }`（与 useSessions.ts:370-376 行为对齐），或在后端 DELETE handler 内显式保证 abort 并在文档中声明该契约。


## Finding 2 — 异步附件归属错乱（draft / 未发送附件归属当前 active）

| 字段 | 内容 |
|---|---|
| 严重度 | High |
| 位置 | app/ChatApp.tsx:1412-1422（`setPendingImages` / `setPendingFiles`） |

```ts
const setPendingImages = useCallback(
  (v) => updateActive((s) => ({ pendingImages: resolve(s.pendingImages, v) })),
  [resolve, updateActive]
);
const setPendingFiles = useCallback(
  (v) => updateActive((s) => ({ pendingFiles: resolve(s.pendingFiles, v) })),
  [resolve, updateActive]
);
```

- 触发条件：用户在 session A 拖入图片/路径附件，`addImageFiles` / `addPathAttachment` 内部异步处理（FileReader、读路径元数据等）期间用户切到 session B；异步回调里调用 `setPendingImages/Files`，此时 `updateActive` 走 `activeKeyRef.current`，写入了 B 的 pending 数组。
- 影响：附件会"泄漏"到错误的 session，后续在 B 发送时会带上 A 的图片/文件；A 切回来时却看不到。在多个 session 并行操作的常见场景下会产生迷惑性 bug，且可能引发隐私/上下文混淆（A 的图片被发到 B 的 agent）。
- 对比参照：同文件内 `refreshContextForRunner` / 模型切换 / fork 提交都遵循 "在调用入口 capture `ownerKeyAtClick = activeKeyRef.current`，回调里只写该 ownerKey" 模式（见 ChatApp.tsx:1808、2484、2790、2842），唯独 attachment setter 直接走 active。
- 修复建议：把 `setPendingImages/Files` 改成 `(ownerKey, v) => updateRunner(ownerKey, ...)`，由 `addImageFiles/addPathAttachment` 在调用前 capture `activeKeyRef.current`，或者在 `useAttachments` 内部直接 capture 并传给 setter。最低限度也应在异步回调里做 ownerKey guard：`if (activeKeyRef.current !== ownerKey) return;` 然后定向 `updateRunner(ownerKey, ...)`。
## Finding 3 — 切换会话时上一会话仍 streaming，未触发任何 abort/确认

| 字段 | 内容 |
|---|---|
| 严重度 | Medium |
| 位置 | app/ChatApp.tsx:1080-1093（`selectSessionAndCloseWorkbench`）、1781-1803（cold-start effect）、1577-1587（`pet.onSwitchSession`） |

```ts
const selectSessionAndCloseWorkbench = useCallback((id: string) => {
  const target = sessions.find((s) => s.id === id);
  if (target && runnersRef.current.has(target.path)) {
    switchTo(target.path);  // 仅切 active，不动旧 runner / SSE / agent
  }
  setSelectedId(id);
  ...
});
```

- 触发条件：A 正在 streaming 时切到 B。
- 影响：这是设计意图（注释明确说 "切换会话时不关 SSE / 后台流式继续"），本身不是 bug。但当前实现完全没有可视化提示 / abort 入口让用户知道 A 仍在跑。配合 Finding 4（LRU 在背景队列满时会 evict 即使 `streaming===true` 也保护、但 fallback 路径仍能 evict 后台 runner 而**不 abort**——见 useRunners.ts:215-223）：用户切到 B 之后，A 的 SSE 可能被 LRU 关掉，agent 在后端继续消耗预算却没有 UI 显示。属于"静默后台开销"。
- 注意：未确认 SSE 关闭后是否会 auto-reconnect 维持事件可见性；从 esMap 语义看 close 即停。
- 修复建议：(a) 切走的 session 在左侧列表保持 `isRunning` 高亮；(b) LRU fallback evict 时记录 telemetry 并考虑对 `streaming` runner 也走 abort；(c) 或在 fallback 路径里给 `streaming` 兜底保护（与正常 candidates 列表里 `if (r.streaming) continue;` 对齐）。

## Finding 4 — LRU fallback 路径会淘汰 streaming/compacting/有 pending attachment 的后台 runner

| 字段 | 内容 |
|---|---|
| 严重度 | Medium |
| 位置 | app/hooks/useRunners.ts:240-262 |

```ts
if (candidates.length === 0) {
  const fallback: { key: RunnerKey; touched: number }[] = [];
  for (const [key, r] of map) {
    if (key === DRAFT_KEY) continue;
    if (key === activeKeyRef.current) continue;
    fallback.push({ key, touched: r.lastTouched });   // 不再过滤 streaming / pending*
  }
  ...
  for (let i = 0; i < Math.min(need, fallback.length); i++) {
    const key = fallback[i].key;
    try { onEvict?.(key); } catch {}
    map.delete(key);
  }
}
```

- 触发条件：runners 数量超 `maxRunners` 且所有非 active runner 都"被保护"（streaming / compacting / pending approval / pending file / pending image）。fallback 不区分保护原因，挑 lastTouched 最久的强行删。
- 影响：
  1. **streaming runner 被 evict**：onEvict → `closeSseFor`，SSE 断；后端 agent 仍在跑（fallback 路径同样不 abort），用户切回该 session 时只能靠 `/sessions/:id/context` 冷启动重建，期间产生的 token / cost / progress 节点丢失或迟到。
  2. **pendingImages/pendingFiles 被 evict**：内存里那些 `ImageContentLite` / `PendingAttachment`（base64 / blob 引用）随 runner 一起销毁，runner 重建后用户刚拖入的附件**永久丢失**且没有任何错误提示。
  3. 注释里明确说"为维持硬上限"——但硬上限的代价没有暴露给用户。
- 修复建议：fallback 也应至少跳过 `streaming` 和 `pendingImages.length > 0 || pendingFiles.length > 0` 的 runner，宁可超过 maxRunners 一个也不做静默数据丢失；如果一定要释放，先把 pending 附件序列化到 sessionStorage 再 evict；streaming 释放前先 abort + 发出 toast。

## Finding 5 — `refreshSessions` 内的 orphan 清理只看 active runner，不清理后台僵尸 runner

| 字段 | 内容 |
|---|---|
| 严重度 | Medium |
| 位置 | app/hooks/useSessions.ts:367-381 |

```ts
if (currentActiveKey !== DRAFT_KEY && !nextPaths.has(currentActiveKey)) {
  const orphaned = runnersRef.current.get(currentActiveKey);
  if (orphaned?.agentId && orphaned.streaming) { /* abort */ }
  closeSseFor(currentActiveKey);
  runnersRef.current.delete(currentActiveKey);
  switchTo(DRAFT_KEY);
}
```

- 触发条件：另一端（CLI / 其他 tab / 别的设备）删除了某个 session，本端轮询拉到新列表，但这个被删 session 当前**不是** active（只是后台 runner）。
- 影响：循环只检查 `currentActiveKey`，对 `runnersRef` 中其他 path-key 不做清理。这些 runner 的：
  - SSE 连接继续保留，事件最终 404 / error，靠 useSseManager 退化机制处理；
  - `runnersRef` 条目占 LRU 名额，把真正活跃的 runner 推向 fallback evict（叠加 Finding 4）；
  - `input-store` 里的 draft 也不会被 `deleteInput` 清掉（草稿死键泄漏，与 `executeDeleteSession` 显式 delete 路径不一致）。
- 修复建议：把检查范围扩展到全部非 DRAFT runner，对 `!nextPaths.has(key)` 的所有 runner 做 abort（如 streaming） + closeSseFor + deleteInput + runnersRef.delete。

## Finding 6 — cold-start `/context` 拉取无取消，错误会写到全局 banner

| 字段 | 内容 |
|---|---|
| 严重度 | Medium |
| 位置 | app/ChatApp.tsx:1781-1889（`useEffect` keyed on `selectedId`） |

```ts
const requestSessionId = selectedId;
void fetch(`/api/sessions/${requestSessionId}/context`)
  .then((r) => r.json())
  .then((ctx) => {
    if (ctx.error) {
      ...
      setError(ctx.error);                    // 全局 banner，不区分是否仍是 active
      return;
    }
    ...
  })
  .catch((e) => {
    ...
    setError(message);
  });
```

- 触发条件：用户快速切换 A→B→C；A 的 `/context` 还没回，B 的也在跑，最后 C 在跑。任意一个在用户已经离开后失败 / 返回 error 字段。
- 影响：
  1. `setError` 是 ChatApp 顶层全局 banner，用户当前在 C，却看到针对 A 的错误（来源 session 的错误信息混到当前 UI），且无法溯源。
  2. 三个 fetch 同时在飞、没有 AbortController；尽管 `cur.contextLoading` guard 能避免脏写，但带宽 / 服务端 IO 是浪费。
  3. effect 的 `useEffect` 没有 cleanup 取消 in-flight fetch（同文件内其他 effect，例如 1140-1156 的 updater，已经用 `cancelled` flag 模式，这里却没采用）。
- 修复建议：(a) 加 cleanup：`let cancelled = false; ...; return () => { cancelled = true; };` 并在 `.then/.catch` 里 `if (cancelled) return;` 才调 `setError`；(b) 或者只在 ownerKey === activeKeyRef.current 时才弹 banner，否则只写 runner 内的 `contextError`；(c) 进一步可上 AbortController。

## Finding 7 — `startNewSession` 重复调用 `setRunner` / `switchTo`，并把 `setSelectedId(null)` 与 SSE 关闭的顺序倒置

| 字段 | 内容 |
|---|---|
| 严重度 | Low |
| 位置 | app/ChatApp.tsx:2163-2178 |

```ts
const startNewSession = useCallback(() => {
  setError(null);
  if (!runnersRef.current.has(DRAFT_KEY)) {
    setRunner(DRAFT_KEY, emptyRunner());
  }
  setWorkbenchOpen(false);
  persistWorkbench(false, { type: "overview" });
  setSelectedId(null);
  switchTo(DRAFT_KEY);
  closeSseFor(DRAFT_KEY);
  setRunner(DRAFT_KEY, emptyRunner());
  storeSetInput(DRAFT_KEY, "");
  switchTo(DRAFT_KEY);   // 第二次 switchTo 同 key，直接 early-return
}, ...);
```

- 触发条件：每次点击 "+New chat"。
- 影响：
  1. 第二次 `switchTo(DRAFT_KEY)` 在 `useRunners.switchTo` 内首行 `if (newKey === activeKeyRef.current) return;` 直接返回——但作者注释说"重新 switchTo 让 useRunners 把新的 empty snapshot 同步给 React state"，这其实**不会发生**（switchTo 不再走 setActiveSnapshot 分支）。所幸第二次 `setRunner(DRAFT_KEY, empty)` 在 `key === activeKeyRef.current` 分支里已经做了 `setActiveSnapshot`（useRunners.ts:289-291），所以渲染没问题；但**注释与实际行为不一致**，未来重构容易踩。
  2. `setSelectedId(null)` → `switchTo(DRAFT_KEY)` → `closeSseFor(DRAFT_KEY)`：先切 active 再关 SSE。如果 draft 之前的 agent 在 streaming，切到 active 的瞬间 React commit 到带 streaming 的旧 snapshot，下一帧才被新 emptyRunner 覆盖——可能闪一帧"上一次的状态"。建议先 `closeSseFor` + `setRunner(empty)` 再 `switchTo`。
- 修复建议：合并为一次 setRunner+switchTo；删除注释里"重新 switchTo"的解释或改成 setRunner 已触发 setActiveSnapshot；调整顺序避免一帧闪烁。

## Finding 8 — `electronApi` 通过 `appInfo` 状态 gate，但宠物相关 effect 直接调 `getElectronApi()`，造成桥接生命周期不一致

| 字段 | 内容 |
|---|---|
| 严重度 | Low |
| 位置 | app/ChatApp.tsx:1123-1126 vs 1576-1588、2123-2146；lib/electron-bridge.ts:`getElectronApi()` 同步返回 |

```ts
const electronApi = useMemo(
  () => (appInfo ? getElectronApi() : null),
  [appInfo]
);
...
useEffect(() => {
  const api = getElectronApi();          // 不经 electronApi memo
  if (!api?.pet?.onSwitchSession) return;
  ...
}, [runnersRef, sessions, setSelectedId, switchTo]);
```

- 触发条件：Electron 启动后，`api.getAppInfo()` 异步返回前的窗口期。
- 影响：
  1. `electronApi` 这个 memo 在 `appInfo === null` 时返回 null，导致依赖它的 `updater` / `power` 等 effect 在首屏短暂期不订阅；而 pet 的 `onSwitchSession` / `onReconnectSession` 直接调 `getElectronApi()`，已经能订阅。**两条桥接路径生命周期不同**，没有任何注释解释为什么。
  2. `getElectronApi()` 实现是同步的（`return window.digaAgent ?? null`），用 `appInfo` gate 没有真正的语义价值，纯粹是冗余间接层。
  3. pet 相关 effect 把 `sessions` 放进依赖（1587 行 `[runnersRef, sessions, setSelectedId, switchTo]`、2146 行同）。每次 `setSessions` 触发 → unsub → re-sub，主进程可能在每次 `setInterval` 轮询后看到 listener churn；从 electron-bridge.ts 看 `onSwitchSession(cb)` 返回的取消函数应当幂等，但频繁 sub/unsub 仍是无谓开销，且若主进程在两次订阅之间 emit，事件会丢（未确认 IPC 是否有缓冲）。
- 修复建议：(a) 统一桥接入口，要么所有 effect 用 `electronApi` memo，要么都直接 `getElectronApi()`，并解释原因；(b) pet listener 用 ref 包 sessions（`sessionsRefRef.current.find(...)`）让 effect 依赖只剩 `[]`，避免 churn；(c) 去掉 `appInfo` gate 或改成显式 `isElectron()` 同步判断。
## Finding 3 — meta 文件锁基于目录 mtime 判停滞，长写会被错误抢锁

- 严重度：**Medium**（未确认是否在生产 workload 下触发；逻辑上确定可触发）
- 位置：`lib/meta/store.ts:80-115`（`acquireMetaFileLock`）
- 代码片段：
  ```ts
  await fs.mkdir(lockDir);
  ...
  const st = await fs.stat(lockDir);
  if (Date.now() - st.mtimeMs > META_LOCK_STALE_MS) {  // 30s
    await fs.rm(lockDir, { recursive: true, force: true });
    continue;
  }
  ```
- 触发条件：锁目录是空目录，`mtime` 在创建后不会变化。任何持锁 >= 30s 的合法 holder（慢盘、fsync 阻塞、debugger 断点、GC stall）会被另一进程误判为 stale，强行 rm 抢锁；原 holder 仍在临界区继续 `writeMeta`，结果两个进程并发写。
- 影响：跨进程写并发被打破，可能丢失字段（pinned/title/lastSeenAt）。dev 多进程热重载、桌面多窗口场景风险更高。
- 修复建议：
  1. lock 文件改为写入 PID + 启动 epoch；stale 判定改成"PID 不在"而非 mtime；
  2. 持锁期间周期 `fs.utimes(lockDir, now, now)` 心跳；
  3. 拿锁后 `fs.stat` 比较 inode 确认仍是自己创建的，否则失败重试。

## Finding 4 — `enforceAgentCapacity` 每次 append 都是 O(N) 扫两遍

- 严重度：**Low**（性能 nit；非正确性问题）
- 位置：`lib/runtime/event-store.ts:60-72`（`enforceAgentCapacity`）和 `:79-83`（被 `appendRuntimeEvent` 调用）
- 代码片段：
  ```ts
  function enforceAgentCapacity(agentId): void {
    if (!agentId) return;
    let count = 0;
    for (const event of store.byId.values()) {
      if (event.agentId === agentId) count += 1;     // 第一遍 O(N)
    }
    let excess = count - MAX_EVENTS_PER_AGENT;
    if (excess <= 0) return;
    for (const [id, event] of store.byId) {
      if (event.agentId !== agentId) continue;        // 第二遍 O(N)
      ...
    }
  }
  ```
- 触发条件：单 agent 高频 append（streaming token / progress event）。每次调用都会 `O(N)` 遍历整个全局 store（默认上限 50 000），即使该 agent 的事件只有几十条，也会扫全表两遍。
- 影响：长生命周期进程 + 多 agent 并发时，append 路径退化到 O(N)。在容量上限附近会出现"越多越慢"的尾延迟。
- 修复建议：
  1. 用 `Map<agentId, Set<eventId>>` 做副本索引，append/delete 同步维护，cap 检查 O(1)；
  2. 或在 `appendRuntimeEvent` 内只在 `byId.size` 跨越阈值倍数时才触发 enforce；
  3. 至少把 enforceAgent + enforce 全局合并为一次 O(N) 遍历（当前是两次：一次按 agent，一次按全局）。

## Finding 5 — runtime event-store 没有按 sessionId 清理的入口，删除 session 后跨 agent 的事件可能遗留

- 严重度：**Medium**（未确认是否有真实事件未带 agentId；逻辑上确定有缺口）
- 位置：`lib/runtime/event-store.ts:118-127`（仅 `disposeRuntimeEventsForAgent`）+ 调用方 `lib/agent-registry.ts:2361`
- 代码片段：
  ```ts
  // event-store 仅按 agentId 清理：
  export function disposeRuntimeEventsForAgent(agentId: string): number { ... }

  // RuntimeEvent 自身可挂 sessionId：
  // events.ts:25  sessionId?: string | null;
  ```
- 触发条件：DELETE 路由（`app/api/sessions/[id]/route.ts`）只对仍在 registry 中、`sessionFile` 命中的 agent 调用 `disposeAgent` → `disposeRuntimeEventsForAgent(agentId)`。如果某些 RuntimeEvent 写入时 `agentId` 为 null（如 source: "browser" / "workflow" / "goal" 的跨 agent 共享事件），或事件归属的 agent 已经先一步 dispose 而 event 又在被 dispose 之后（边缘竞态）补登记，再删除 session 时无法连带清理。
- 影响：`listRuntimeEvents({ sessionId })` 仍能查到已删除 session 的事件；UI 可能展示"幽灵事件"。事件总量受 `MAX_EVENTS=50_000` 限制，泄漏不会无限放大，但语义不一致。
- 修复建议：
  1. 在 event-store 中加 `disposeRuntimeEventsForSession(sessionId: string): number`，DELETE 路由对每个 target session 调用一次，与 `deleteMeta` / `deletePersistedProgress` 并列；
  2. 或在 `appendRuntimeEvent` 强制要求 sessionId（schema 校验），并维护 `Map<sessionId, Set<eventId>>` 副本索引使清理 O(k)。

## Finding 6 — `listAllSdkSessions` 缓存写入存在 stale-cache 重写竞态

- 严重度：**Low**
- 位置：`lib/sessions.ts:39-61`
- 代码片段：
  ```ts
  const inflight = SessionManager.listAll()
    .then((value) => {
      listAllCache = { at: Date.now(), value };   // [A]
      return value;
    })
    .catch((e) => {
      if (listAllCache?.inflight === inflight) listAllCache = null;
      throw e;
    });
  listAllCache = { at: now, inflight };           // [B]
  ```
- 触发条件：场景 1：`__clearSessionListCacheForTests()` 或并发的失败 inflight 把 `listAllCache` 设为 null/replaced 后，本次 `.then` 仍会无条件 `listAllCache = { at, value }`，把更新的状态/失效信号覆盖掉。场景 2：缓存写入与下一轮 `listAllSdkSessions` 调用之间没有判等，[A] 处可能把已经被另一个调用替换为更新的 `at` 的缓存覆盖回旧 value。
- 影响：极小概率拿到稍旧的 list（窗口 <200ms）；测试中调用 `__clearSessionListCacheForTests()` 后又被 [A] 复活旧缓存，可能造成测试间状态污染或调试时 confusion。不影响数据一致性，但与显式 clear 语义相违。
- 修复建议：
  ```ts
  .then((value) => {
    if (listAllCache?.inflight === inflight) {
      listAllCache = { at: Date.now(), value };
    }
    return value;
  })
  ```
  对 then 与 catch 都加 `inflight === ` 守卫，让 `__clearSessionListCacheForTests` / 失败重置真正生效。

## Finding 7 — `isSessionUnread` 时间比较依赖 server/client 时钟一致性，无法分辨"同一毫秒已读/未读"

- 严重度：**Low**
- 位置：`lib/sessions/unread.ts:18-37`
- 代码片段：
  ```ts
  const seenMs = Date.parse(args.seenAt);
  const unreadMs = Date.parse(unreadAt);
  if (!Number.isFinite(seenMs) || !Number.isFinite(unreadMs)) {
    return args.seenAt < unreadAt;     // 字符串比较 fallback
  }
  return seenMs < unreadMs;
  ```
- 触发条件：
  1. `seenAt` 由客户端 `new Date().toISOString()` 写，`unreadAt` 由服务端从 `lastAgentEndAt`（服务器时钟）/ `session.modified`（文件 mtime）派生。两端时钟漂移 >1s 时，已读会被错判为未读或相反。
  2. 老 session 没有 `lastAgentEndAt` 时回退到 `session.modified`，但 `session.modified` 也包括用户自己发消息引起的 mtime 更新——发消息瞬间 modified 更新但 seenAt 还没刷新，会看到一闪而过的"自己消息触发的未读蓝点"。
  3. fallback 分支 `args.seenAt < unreadAt` 假设字符串均为合法 ISO；非法但等长字符串会按字典序比较，结果不可预期。
- 影响：未读蓝点出现假阳/假阴，不影响数据正确性；多端时钟同步差时体验下降。
- 修复建议：
  1. `seenAt` 由后端在 `PATCH lastSeenAt` 时写入，使用与 `unreadAt` 同源的服务器时钟；客户端只发"现在已读"动作。
  2. fallback 比较时若任一边非法，直接 `return true`（按未读处理）+ 打 warn，避免依赖字符串字典序。
  3. 派生 `unreadAt` 时优先用 `lastAgentEndAt`，没有时返回 null（不再回退到 modified），上层根据 null 决定不闪未读。

## Finding 8 — `upsertOptimisticSession` 不感知服务器侧的 "session 已被删除" 状态，可能复活已删 session

- 严重度：**Medium**（未确认实际触发频率）
- 位置：`lib/sessions/optimistic.ts:33-86`
- 代码片段：
  ```ts
  // 不存在同 id：插到顶部
  const optimistic: SessionInfoLite = {
    id: input.id, ...
    runtimeState: "loading",
    runtimeUpdatedAt: Date.now(),
  };
  return [optimistic, ...list];
  ```
- 触发条件：
  1. 用户开启会话 A → 服务器返回 sessionId/sessionFile；
  2. 在客户端发起删除 A 的请求（DELETE /api/sessions/A），但删除请求与"agent 第一条消息发完后回填 sessionFile"几乎同时；
  3. 客户端接到 `/api/agent/new` 返回后调用 `upsertOptimisticSession`，发现本地 list 已被删除（idx<0），于是把 A 重新插到顶部。结果 sidebar 出现"已删除但又冒回来"的幽灵会话，直到下一次 `refreshSessions` 才消失（如果 jsonl 已被 unlink，listAllSessions 不会返回它，optimistic 项会一直留在客户端 state 中，因为 idx<0 -> 走插入分支，没有 TTL）。
  4. 同样问题：网络抖动重发 `/api/agent/new` 时，optimistic 重新插到顶部，覆盖现有状态。
- 影响：UI 出现幽灵 session；`refreshSessions` 拉到的服务器列表如果做的是 merge 而非 replace，幽灵不会自然消失。
- 修复建议：
  1. `upsertOptimisticSession` 增加一个 `knownDeletedIds: Set<string>` 入参（或全局 store 维护），命中则跳过插入；
  2. optimistic 项引入 TTL（例如 30s），到点未被服务器列表覆盖则自行剔除；
  3. 客户端在 DELETE 成功回调中把该 id 加入"已删除墓碑集"，下一次 refresh 服务器列表前禁止任何 upsert。



---

# Session 持久化与并发审计（补充）

审计范围（只读）：
- lib/sessions.ts
- lib/sessions/optimistic.ts
- lib/sessions/unread.ts
- lib/meta/store.ts
- lib/runtime/event-store.ts

审计重点：文件读写原子性 / 并发写竞态 / 反序列化失败处理 / session 删除后资源遗留 / optimistic 与服务器结果冲突 / unread 计数边界。
按严重度排序，最多 8 条。

## P-Finding 1 — `deleteMeta` 与 in-flight `updateMeta` 之间没有串行化，删除后可能复活孤儿 meta

- 严重度：**High**
- 位置：`lib/meta/store.ts:226-265`（`updateMeta`）+ `lib/meta/store.ts:268-275`（`deleteMeta`）
- 代码片段：
  ```ts
  // updateMeta：用 metaUpdateChains 串行化同 id 的 read-merge-write
  const prev = (metaUpdateChains.get(sessionId) ?? Promise.resolve()).catch(...);
  const run = prev.then(async () => {
    const release = await acquireMetaFileLock(sessionId);
    ...
    await writeMeta(merged);   // 重新创建 meta 文件
  });

  // deleteMeta：直接 unlink，没有进 chain，没拿文件锁
  export async function deleteMeta(sessionId: string): Promise<void> {
    try { await fs.unlink(metaFilePath(sessionId)); } ...
  }
  ```
- 触发条件：客户端先发 `PATCH /api/sessions/:id`（pin/title），紧接着发 `DELETE /api/sessions/:id`。`deleteMeta` 先到 `unlink`，但前一个 `updateMeta` 仍在 chain 上排队 / 拿到文件锁后才 `writeMeta` —— rename 完成时 jsonl 已被删除，meta 文件却被重新创建。
- 影响：产生与已删除 session 对应的孤儿 `~/.diga-agent/sessions/{id}.meta.json`；`listAllSessions` 看不到 SDK session（因 jsonl 已删），`batchReadMeta` 不会主动回收，meta 文件长期遗留；同时 `metaUpdateChains` 也不会被 deleteMeta 清空，已经排队的写仍会执行。
- 修复建议：
  1. 让 `deleteMeta` 进入 `metaUpdateChains` + `acquireMetaFileLock`，把 unlink 串到队尾；
  2. 删除时一并 `metaUpdateChains.delete(sessionId)`，并在 `writeMeta` 前快速 `fs.stat` 校验目标 jsonl 是否仍在；
  3. 路由层面在 deleteMeta 之后任何同 id 的 PATCH 直接返回 404。


## P-Finding 2 — `writeMeta` 是 public 入口但不持锁，绕过 `updateMeta` 时会丢字段

- 严重度：**Medium**
- 位置：`lib/meta/store.ts:178-200`
- 代码片段：
  ```ts
  export async function writeMeta(meta: SessionMeta): Promise<void> {
    ...
    const handle = await fs.open(tmp, "wx");
    await handle.writeFile(JSON.stringify(sanitized, null, 2));
    await handle.sync();
    await fs.rename(tmp, fp);
    await fsyncDir(dir);
  }
  ```
- 触发条件：调用方直接 `import { writeMeta }` 写整份 meta（如导入工具、重置工具、Phase B 自动摘要），同时另一处 `updateMeta` 在做 read-merge-write。`writeMeta` 既不进 `metaUpdateChains` 也不拿 `acquireMetaFileLock`，两侧并发互不互斥。注释强调"调用方负责 merge"，但只是文档约束。
- 影响：跨调用点的同 session 写并发会静默丢字段（用户刚改的 title 可能被并发的 summary 覆盖回旧值）。
- 修复建议：
  1. 把 `writeMeta` 改为内部函数（去 `export`），所有外部调用走 `updateMeta`；或者
  2. 在 `writeMeta` 内同样获取 `acquireMetaFileLock` + 串行化到 `metaUpdateChains`；
  3. 增加 "并发 writeMeta + updateMeta 不丢字段" 的回归用例。


## P-Finding 3 — meta 文件锁基于目录 mtime 判停滞，长写会被错误抢锁

- 严重度：**Medium**（未确认是否在生产 workload 下命中；逻辑上可触发）
- 位置：`lib/meta/store.ts:80-115`（`acquireMetaFileLock`）
- 代码片段：
  ```ts
  await fs.mkdir(lockDir);
  ...
  const st = await fs.stat(lockDir);
  if (Date.now() - st.mtimeMs > META_LOCK_STALE_MS) { // 30s
    await fs.rm(lockDir, { recursive: true, force: true });
    continue;
  }
  ```
- 触发条件：锁目录是空目录，mtime 在创建后不再变化。任何持锁 >= 30s 的合法 holder（慢盘、fsync 阻塞、debugger 暂停、GC stall、被 SIGSTOP 的进程）都会被另一进程误判 stale，强行 rm 抢锁；原 holder 仍在临界区继续 writeMeta。
- 影响：跨进程写并发互斥被打破，可能丢字段（pinned/title/lastSeenAt）。dev 多进程 + 热重载、桌面多窗口场景风险更高。
- 修复建议：
  1. lock 目录内放 holder.json（PID + 启动 epoch），stale 判定改为"PID 不存在"；
  2. 持锁期间周期性 fs.utimes(lockDir, now, now) 心跳；
  3. 拿锁后再 fs.stat 比较 inode / btime，确认仍是自己创建的。


## P-Finding 4 — runtime event-store 没有按 sessionId 清理的入口，删除 session 后仍可能遗留事件

- 严重度：**Medium**（未确认实际泄漏量，缺口在逻辑层确认存在）
- 位置：`lib/runtime/event-store.ts:118-127`（仅 `disposeRuntimeEventsForAgent`）+ `lib/runtime/events.ts:25`（`RuntimeEvent.sessionId`）+ 调用方 `lib/agent-registry.ts:2361`
- 代码片段：
  ```ts
  // event-store 仅按 agentId 清：
  export function disposeRuntimeEventsForAgent(agentId: string): number { ... }

  // 但 event 自身可挂 sessionId：
  // events.ts:25  sessionId?: string | null;
  ```
- 触发条件：`DELETE /api/sessions/:id` 路由（`app/api/sessions/[id]/route.ts:91-103`）只对 registry 中 `sessionFile` 命中的 agent 调用 `disposeAgent` → `disposeRuntimeEventsForAgent(agentId)`。如果某些 RuntimeEvent 写入时 `agentId == null`（source 为 `browser` / `workflow` / `goal` 的跨 agent 共享事件），或事件归属 agent 已先 dispose 之后再被 append（边缘竞态），删除 session 后无法连带清理。
- 影响：`listRuntimeEvents({ sessionId })` 仍可查到已删 session 的事件；UI 可能展示"幽灵事件"。事件总数受 `MAX_EVENTS=50_000` 限制，泄漏不会无限放大，但语义不一致。
- 修复建议：
  1. 新增 `disposeRuntimeEventsForSession(sessionId)`，DELETE 路由对每个 target 调用；
  2. 维护 `Map<sessionId, Set<eventId>>` 索引，使按 session 清 O(k)；
  3. `appendRuntimeEvent` 强制要求至少 sessionId 或 agentId 非空（schema 校验）。


## P-Finding 5 — `enforceAgentCapacity` 每次 append 都做两遍 O(N) 扫描

- 严重度：**Low**（性能 nit；非正确性问题）
- 位置：`lib/runtime/event-store.ts:60-72` + `:79-83`
- 代码片段：
  ```ts
  function enforceAgentCapacity(agentId): void {
    if (!agentId) return;
    let count = 0;
    for (const event of store.byId.values()) {              // 第一遍 O(N)
      if (event.agentId === agentId) count += 1;
    }
    let excess = count - MAX_EVENTS_PER_AGENT;
    if (excess <= 0) return;
    for (const [id, event] of store.byId) {                 // 第二遍 O(N)
      if (event.agentId !== agentId) continue;
      ...
    }
  }
  ```
- 触发条件：单 agent 高频 append（streaming token / progress event）。每次 append 都遍历整个全局 store（默认上限 50 000），即使该 agent 自己事件只有几十条，也要 O(N) 两遍。
- 影响：长生命周期进程 + 多 agent 并发时 append 路径退化到 O(N)；接近容量上限时会出现"越多越慢"的尾延迟。
- 修复建议：
  1. 维护 `Map<agentId, Set<eventId>>` 副本索引，append/delete 同步维护，cap 检查 O(1)；
  2. 或改为只有 `byId.size` 跨阈值倍数时才 enforce；
  3. 至少把 enforceAgent + enforce 全局合并成一次 O(N) 遍历。


## P-Finding 6 — `listAllSdkSessions` 缓存写入存在 stale-cache 重写竞态

- 严重度：**Low**
- 位置：`lib/sessions.ts:39-61`
- 代码片段：
  ```ts
  const inflight = SessionManager.listAll()
    .then((value) => {
      listAllCache = { at: Date.now(), value };       // [A] 无条件覆盖
      return value;
    })
    .catch((e) => {
      if (listAllCache?.inflight === inflight) listAllCache = null;
      throw e;
    });
  listAllCache = { at: now, inflight };               // [B]
  ```
- 触发条件：
  1. `__clearSessionListCacheForTests()` 在 inflight 进行中清空 `listAllCache`，本次 `.then` 仍会无条件 [A] 复活旧 value；
  2. 多次并发调用：上一次的 `.then` 在更新到来后再触发 [A]，把更新的状态写回旧 value。
- 影响：极小概率拿到稍旧 list（窗口 <200ms）；测试中 `__clearSessionListCacheForTests` 后被复活的旧缓存可能造成测试间状态污染或调试 confusion。不影响业务正确性。
- 修复建议：
  ```ts
  .then((value) => {
    if (listAllCache?.inflight === inflight) {
      listAllCache = { at: Date.now(), value };
    }
    return value;
  })
  ```
  对 then / catch 都加 `inflight === ` 守卫。


## P-Finding 7 — `isSessionUnread` 时间比较依赖客户端/服务端时钟一致性，且 fallback 路径不可靠

- 严重度：**Low**
- 位置：`lib/sessions/unread.ts:18-37` + `:8-13`
- 代码片段：
  ```ts
  const seenMs = Date.parse(args.seenAt);
  const unreadMs = Date.parse(unreadAt);
  if (!Number.isFinite(seenMs) || !Number.isFinite(unreadMs)) {
    return args.seenAt < unreadAt;          // 字符串字典序 fallback
  }
  return seenMs < unreadMs;
  ```
- 触发条件：
  1. `seenAt` 由客户端 `new Date().toISOString()` 写、`unreadAt` 由服务器（`lastAgentEndAt` / `session.modified`）派生；两端时钟漂移 >1 s 就会出现假阳/假阴。
  2. 老 session 没 `lastAgentEndAt`，回退到 `session.modified`，但用户自己发消息也会更新 mtime，会闪一次"自己消息触发的未读"。
  3. fallback 假设两边都是合法 ISO；非法字符串走字典序，结果不可预期。
- 影响：未读蓝点出现假阳/假阴，不影响数据正确性；多端时钟同步差时体验下降。
- 修复建议：
  1. `seenAt` 由服务器在 `PATCH lastSeenAt` 时写入，使用与 `unreadAt` 同源时钟；
  2. fallback 分支若任一端非法，直接 `return true` 并打 warn，不依赖字典序；
  3. 派生 `unreadAt` 时若没有 `lastAgentEndAt` 直接返回 null，上层据此不闪未读（不再回退到 modified）。


## P-Finding 8 — `upsertOptimisticSession` 不感知"已被删除"状态，可能复活幽灵 session

- 严重度：**Medium**（未确认实际触发频率；逻辑上确认）
- 位置：`lib/sessions/optimistic.ts:67-86`
- 代码片段：
  ```ts
  // 不存在同 id：直接插到顶部
  const optimistic: SessionInfoLite = {
    id: input.id, ...
    runtimeState: "loading",
    runtimeUpdatedAt: Date.now(),
  };
  return [optimistic, ...list];
  ```
- 触发条件：
  1. 用户在 sidebar 删了 session A（DELETE 请求已发出），与此同时 `/api/agent/new` 返回 sessionId/sessionFile 的回调晚一步触发 `upsertOptimisticSession`；本地 list 中 A 已被剔除（idx<0），走插入分支把 A 重新塞回顶部。
  2. 网络抖动重发 `/api/agent/new`，optimistic 再次插到顶部覆盖现有状态。
- 影响：sidebar 出现"已删但又冒回来"的幽灵会话；如果服务器侧 jsonl 已 unlink，下次 `refreshSessions` 拉到的列表里也没有它，幽灵 optimistic 项会一直留在客户端 state（没有 TTL，没有墓碑集）。
- 修复建议：
  1. 增加 `knownDeletedIds: Set<string>` 入参（或 store 全局），命中则跳过插入；
  2. optimistic 插入项设 TTL（如 30 s），到点未被服务器列表覆盖即剔除；
  3. 客户端在 DELETE 成功回调里把 id 加入"墓碑集"，下一次 refresh 前禁止任何 upsert。

---

## 注意事项 / 已知缺口

- 本审计严格限定在指定 5 个文件，跨文件影响（如 DELETE 路由 / agent-registry / 客户端 hook）仅在追溯触发条件时点到为止，不展开。
- `app/api/sessions/[id]/route.ts:91-128` 的级联删除流程是"deleteMeta / deletePersistedProgress / removeBatchesByParentSessionPath"按顺序执行，与 P-Finding 1/4 直接相关，但属上层调用方，未列入本次 finding 主体。
- 反序列化失败处理：`readMeta` 对 ENOENT/解析失败均返回 null（仅 console.warn），符合"损坏文件不挂全表"语义；未发现额外问题。
- writeMeta 已实现 tmp+rename+fsync+fsyncDir，原子写本身是正确的；本次 finding 集中在锁 / 调用边界。


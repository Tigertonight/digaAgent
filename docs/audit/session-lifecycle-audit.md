# UI 会话生命周期审计报告

审计范围：`app/ChatApp.tsx`、`app/ChatMinimap.tsx`、`app/components/Sidebar.tsx`、
`app/hooks/useSessions.ts`、`app/hooks/useSessionMeta.ts`、`app/hooks/useChatStream.ts`、
`app/hooks/useSseManager.ts`、`app/hooks/useAgentEvents.ts`、`app/hooks/useRunners.ts`、
`app/hooks/useForkable.ts`、`app/hooks/useComposerInput.ts`、`lib/composer/input-store.ts`、
`lib/preview-store.ts`、`lib/session-runner.ts`、`lib/sessions/optimistic.ts`，
以及与 `sessionId` 隔离相关的 `lib/clarification/*`、`lib/goal/*` 服务端入口（仅核对 UI 联动语义）。

只读审计，未修改源码。结论按严重度分组。文件路径与行号基于审计时仓库快照
（commit-time `git status` 干净，未做修改）。

## Critical

### C1. 切换会话时上一会话的 streaming **不会被中断**——是产品策略，但带来"幽灵 turn"风险

- 文件：`app/hooks/useRunners.ts` L143-167（`switchTo`），`app/hooks/useSseManager.ts` L23-26 注释，`app/ChatApp.tsx` L1762-1788（switch effect）
- 代码（`switchTo`，节选）：
  ```ts
  const switchTo = useCallback((newKey) => {
    if (newKey === activeKeyRef.current) return;
    const target = runnersRef.current.get(newKey);
    if (!target) { …兜底建空 runner… }
    runnersRef.current.set(newKey, touched);
    activeKeyRef.current = newKey;
    setActiveKey(newKey); setActiveSnapshot(touched);
    lruEvictRef.current?.();
  }, []);
  ```
- 触发条件：A 会话 streaming 中，用户切到 B 会话。代码注释明示"不动 SSE，让后台流式继续"
  （`useSseManager.ts` L23、`ChatApp.tsx` L1762）。前端确实不调 `onAbort`、不 `closeSseFor(A)`。
- 影响：
  1. 这是设计意图（多会话并发），但 LRU 上限是 8（`useRunners.ts` L31），且 `streaming` runner 不可被淘汰
     （`useRunners.ts` L210）。如果用户在 8 个会话上各点过一次发送然后忘了切回去，
     第 9 个会话切过来后没有被淘汰对象，命中 `console.warn` 跑路（`useRunners.ts` L240-246），
     连接池会突破上限，**SSE 连接和 RAF pending 队列都会无限增长**，直到刷新页面。
  2. 用户切走 A 后再切回 A，A 期间的 token 已经在 reducer 里通过
     SSE 持续累积；但只要 A 的 SSE 在切走时丢包（onerror → state 'lost'），
     RFC-2 的 since-seq 重连虽然有重试，重连前的 token 会丢——而用户切走时 UI 是不显示
     这条 lost 事件的（`onStatusChange` 写到非 active runner 的 `sseStatus`，UI 看不见）。
- 建议：
  - 对 `useRunners.ts` 加 hard-cap 告警：突破 maxRunners 后立即在 UI banner 提示
    "并发会话上限已满，部分会话不再后台跟踪"，并强制 abort 最久未触达的 streaming runner。
  - 或者文档中明示该上限并把 `MAX_RUNNERS` 配置化。
- 严重度：High（资源累积无上限），但因有 console.warn 兜底而非立即崩，故定 High 而非 Critical。
  *校正：见严重度归类 H1。*

### C2. 删除 active session 后 `executeDeleteSession` 的"切回 draft"路径，对 **未 await 的级联 fetch** 无防御

- 文件：`app/hooks/useSessions.ts` L431-475
- 触发条件：用户删除当前 active session（已带 streaming runner）。
- 代码：
  ```ts
  for (const did of deletedIds) {
    const sel = sessionsRef.current.find((s) => s.id === did);
    if (!sel) continue;
    const key: RunnerKey = sel.path;
    closeSseFor(key);
    deleteInput(key);
    if (activeKeyRef.current === key) activeWasDeleted = true;
    runnersRef.current.delete(key);
  }
  ```
- 问题：`closeSseFor(key)` 会清掉 SSE 连接和 pendingDispatchRef 中该 key 的事件
  （`useSseManager.ts` L196-204），但如果删除发生时正有 in-flight 请求引用该 ownerKey
  （例如 `useChatStream.ensureAgent` 创建了 agent、`updateRunner(ownerKeyAtStart, …)` 还没来得及写）：
  - 后端 agent 已被 DELETE 路由的 `disposeAgent` 清掉（`app/api/sessions/[id]/route.ts` L82-95）
  - 但前端 `ensureAgent` 内的 `updateRunner` / `attachSseFor` 的执行依赖 `runnersRef.current.has(key)`
    校验非常稀薄，仅在 `useRunners.updateRunner` 里检查 `cur` 存在（L130）；
    `attachSseFor` 不做 runner 存在性校验（`useSseManager.ts` L228-260），会用一个孤儿 key 建立 EventSource，
    再被永远不被消费。
- 影响：删除瞬间发起的"创建新 agent"请求在响应回来后会建立一条孤儿 SSE 连接 + 孤儿 lastSeqRef
  + 孤儿 generationRef，且因为 `runnersRef.delete(key)` 已发生，`updateRunner` 直接 `return`
  （`useRunners.ts` L130：`if (!cur) return`），后端 agent 已 dispose，连接立即 onerror，
  S2 重连定时器仍然会被安排（`useSseManager.ts` L327-336：只校验 `esMapRef.current.get(key) !== es`），
  在重试间隔过后再 attach 一次到一个不存在的 agentId，触发 404 风暴。
- 建议：
  1. `attachSseFor` 入口处校验 `runnersRef.current.has(key)`（需要从 ChatApp 注入），
     否则拒绝 attach。
  2. `useChatStream.ensureAgent` 在 await 后增加 "ownerKey 仍在 runnersRef 中" 校验，
     失败则同步调用 `agentAction(aid, { type: 'abort' })` + dispose（或前端只调 dispose 接口）。
- 严重度：Critical（孤儿连接 + 重连风暴）

### C3. `executeDeleteSession` 拿 `selectedId` 闭包值判断兜底，但 deps 漏 `setSelectedId`，旧引用风险

- 文件：`app/hooks/useSessions.ts` L463-468、L477-486
- 代码：
  ```ts
  } else if (selectedId && deletedIds.has(selectedId)) {
    setSelectedId(null);
  }
  refreshSessions();
  …
  }, [refreshSessions, selectedId, switchTo, runnersRef, activeKeyRef, closeSseFor, onError]);
  ```
- 问题：
  1. 这里用 `selectedId`（闭包值）而非 `selectedIdRef.current`。`selectedIdRef` 在 hook 内部存在
     （L249-256），但本回调没有用它。点击删除按钮到 await 返回之间，用户可能已切到其他 session，
     这时 `selectedId` 是旧值，会错误地 `setSelectedId(null)`，把用户从无关 session 切走。
  2. `setSelectedId` 是 React state setter，引用稳定，不写进 deps 不会失效；
     但 `selectedId` 写进 deps 又导致 `executeDeleteSession` 每次 selectedId 变化都重建——
     引用不稳定，下游 `useEffect/useCallback` 受牵连。
- 影响：删除过程中切会话会出现"无关会话被取消选中"。
- 建议：用 `selectedIdRef.current` 读最新值，`selectedId` 从 deps 里移除；
  或者像同文件的 `markSessionSeen` 一样不依赖闭包 selectedId，只依赖入参。
- 严重度：High


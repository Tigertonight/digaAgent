# 多会话多任务 P1 实现计划

## 目标

A 会话流式输出中，切到 B 会话后：
- A 仍在后台接收事件、累积消息（不被中断）
- B 拥有独立的输入框、可立即输入并发送
- 切回 A 时，A 期间累积的内容立刻可见、流式继续
- 同时常驻 runner 上限 8 个，超出 LRU 退出（仅断 SSE，不 abort 后端 agent）

P2 范围（本计划不涉及，下一轮做）：
- Sidebar 给运行中会话加运转指示
- 会话切换 200ms fade

---

## 现状盘点

### 后端（不需要改）
- `lib/agent-registry.ts` 每个 agentId 独立 ring buffer + `nextSeq`，`getEventsSince(aid, seq)` 已支持续传
- `/api/agent/:id/events` 是独立的 SSE，每个 agent 一个
- 多 agent 完全可以并发跑，前端没用上而已

### 前端单会话状态（要拆）
ChatApp.tsx 当前持有的"全局只一份"的状态（按行号）：
- `chatState` (176)
- `forkableUserMessages` (181), `forkingIndex` (185), `forkText` (186), `forkBusy` (187)
- `agentId` (241), `agentSessionId` (242)
- `input` (243), `pendingImages` (252), `pendingFiles` (253)
- `streaming` (254), `agentPhase` (255)
- `compacting` (257), `compactError` (258), `retryInfo` (259)
- `stats` (271)
- `currentSessionFile` (596)
- `availableThinkingLevels`, `supportsThinking`, `thinkingLevel`（在 271 上下，需复查）
- `sseStatus`（attachSse 内部）
- 这些都属于"runner-bound"

**保留全局**：
- `cwd`, `selectedId`, `sessions`, `providers`, `providerId`, `modelId`, `theme`, `right panel state`, `sidebar open`, `lastSeen` 等

### 切换/创建路径（要重写）
- `useEffect [selectedId]` (835): 选已有 session → 清状态、关 SSE、拉 context、重建
- `startNewSession` (983): "+New chat" → 立刻 create agent
- `send` (1170): 第一次发送时如果没 agentId 就 create
- `attachSse` (1032): 打开 SSE，写入 `esRef`
- `handleAgentEvent` (1056): SSE 事件分发到 `setChatState/setStreaming/...`
- `agentAction` (965): POST `/api/agent/:id` 通用
- 切 fork 路径：1631、1730 也会重置 chatState
- `forkToNewSession`、各种 retry 路径

### 已知的隐藏依赖
- `attachSse` 是 `useCallback([])`，里面 `handleAgentEvent` 引用了大量 setter — handleAgentEvent 当前以 `aidForEvents` 区分调用，但 `setChatState` 只有一份，所以即使带 aid 它也只能改活跃那份。我们要把它变成"按 aid 改对应 runner 的 chatState"。

---

## 设计

### 数据模型

```ts
// runner key 规则:
//   - selectedId 非空 → key = selectedId(就是 session path)
//   - selectedId === null → key = "draft"(只有一个草稿槽,对应"新建会话页")
type RunnerKey = string;

// 一个 runner 持有的"全部 per-session" 状态
interface RunnerState {
  agentId: string | null;
  agentSessionId: string | null;
  sessionFile: string | null;      // 后端 SDK 写的 .jsonl path,首次发送后才有

  chatState: ReducerState;
  forkableUserMessages: ForkableUserMessage[];
  forkingIndex: number | null;
  forkText: string;
  forkBusy: boolean;

  streaming: boolean;
  agentPhase: AgentPhase;
  compacting: boolean;
  compactError: string | null;
  retryInfo: RetryInfo | null;
  stats: StatsSnapshot | null;
  toolsCount: ToolsCountSnapshot | null;

  thinkingLevel: ThinkingLevel | null;
  availableThinkingLevels: ThinkingLevel[];
  supportsThinking: boolean;

  // 输入框
  input: string;
  pendingImages: ImageContentLite[];
  pendingFiles: PendingAttachment[];

  // SSE
  sseStatus: "idle" | "active" | "lost";
  lastSeq: number;                  // 用于 since-seq 重连/续传
  lastTouched: number;              // LRU 时间戳(切到/收到事件时更新)
}
```

### Runner 容器

```ts
// 在 ChatApp 顶层维护:
const runnersRef = useRef<Map<RunnerKey, RunnerState>>(new Map());
const esMapRef = useRef<Map<RunnerKey, EventSource>>(new Map());

// "当前可见 runner" 用 React state 触发渲染:
const [activeKey, setActiveKey] = useState<RunnerKey>("draft");
const [activeSnapshot, setActiveSnapshot] = useState<RunnerState>(initialDraftRunner());
```

**单一可见原则**：`activeSnapshot` 就是"当前展示给 UI 的"那一份，所有现有的 useState（chatState/streaming/...）合并成这一个对象。UI 渲染、effect、回调全部从 `activeSnapshot.xxx` 读。

**变更路径**：
1. SSE 事件来 → 找到对应 RunnerKey → 在 `runnersRef.current` 里 mutate 那份 RunnerState（**immer 风格不可变更新**或浅拷贝） → 如果该 key === activeKey，同步把新对象 set 给 `setActiveSnapshot`
2. 用户操作（input/pendingFiles/...）→ 用一个 helper `updateActive(patch)`：合并 patch、写 runnersRef + setActiveSnapshot
3. 切换 → `switchTo(newKey)`：先把 activeSnapshot 写回 runnersRef（保险，正常路径已经同步），再从 runnersRef 取 newKey 的 RunnerState 作为新 active；如果不存在则触发"懒加载"（fetch context + attachSse）

### Runner 生命周期

#### 1. 创建：草稿 (`draft`)
- 应用启动时初始化一个 `runnersRef.set("draft", emptyDraftRunner())`
- 用户没选任何 session 时显示这个

#### 2. 用户在草稿里发送（草稿升级）
- send() 走原有 `/api/agent/new` 流程，拿到 `data.id` (agentId), `data.sessionFile`
- 草稿 runner 的 agentId/sessionFile 被填上
- **关键**：把这个 runner 在 Map 里**重命名 key** —— `runnersRef.delete("draft")` + `runnersRef.set(sessionFile, runner)`
- `setActiveKey(sessionFile)` + `setSelectedId(extractIdFromPath(sessionFile))`
- `runnersRef.set("draft", emptyDraftRunner())` 重新建一个空草稿（用户下次 +New chat 就用它）
- 启动 SSE：`attachSse(runner.agentId, sessionFile)`

#### 3. 选已有 session
- `setActiveKey(session.id)` —— session.id 就是 path
- 如果 `runnersRef.has(session.id)` → 直接切，把 snapshot setActive
- 否则：lazyOpenRunner(session) —— fetch context, set 上 chatState; create agent if needed (可懒到第一次 send 才 create)... actually 这里有歧义见下

**懒 create agent 还是切到就 create？** 当前代码切到已有 session 不立即 create agent —— send 时才 create（带 sessionPath 让后端续接）。**保留这个行为**：切已有 session = lazy，runner 里 agentId 仍是 null，没 SSE；用户开始发送/切回原本就在跑的 agent 时再处理：
- 已经在跑的 agent（之前没断 SSE）→ runner 已存在于 Map，直接切，不变
- 没在跑的（冷启动选历史会话）→ 不 create agent，仅 chatState 显示历史；用户发送时走"create with sessionPath"
- 但是！如果要支持"A 在跑、我冷启动开 B"，B 切回 A 时 SSE 不能丢。所以 SSE 的生命周期是 **per-runner-with-agentId**，跟切换无关：只要 runner 有 agentId，SSE 就保持连。

#### 4. LRU 退出
- 退出条件：`runnersRef.size > 8`
- 候选：所有非 active、非 streaming 的 runner，按 lastTouched 升序，淘汰最久的
- 退出动作：关掉那个 runner 的 SSE、从 esMapRef 删；从 runnersRef 删；保留后端 agent（不调 abort）
- 用户下次切回该 session 时走"冷启动选历史会话"路径

#### 5. SSE 生命周期
- `attachSseFor(key, agentId)`：打开 EventSource、写入 esMapRef、绑定 onmessage
- onmessage 里要用闭包里的 `key`，把事件路由到 `runnersRef.get(key)` 那份 RunnerState
- 不再使用 `esRef.current`（单实例）；换成 esMapRef
- 在切换时**不**关 SSE
- 在 LRU 退出 / 用户主动 abort / agent_end 后某种条件 / 应用卸载时 关
- 关键：**重连**。原来 onerror 时只是 setSseStatus("lost")。现在需要带 `since=seq` 重连。带 lastSeq 重新 `new EventSource('/api/agent/:id/events?since=' + lastSeq)`。后端 GET 路由要支持 `?since=`，**先确认**

### 后端待确认
- `/api/agent/:id/events` 是否支持 `?since=N` 查询参数？源在 `app/api/agent/[id]/events/route.ts`。要在 P1 里读一下。如果不支持，加上（这是后端小改）。
- 否则 SSE 重连会丢事件。

### 改动总览

#### `app/ChatApp.tsx`
- **删除**：`useState` for chatState/forkable*/agentId/agentSessionId/streaming/agentPhase/compacting/compactError/retryInfo/stats/toolsCount/thinkingLevel*/supportsThinking/input/pendingImages/pendingFiles/sseStatus/currentSessionFile —— 全部合到 RunnerState
- **新增**：
  - `runnersRef = useRef<Map<RunnerKey, RunnerState>>` 
  - `esMapRef = useRef<Map<RunnerKey, EventSource>>`
  - `[activeKey, setActiveKey]`
  - `[activeSnapshot, setActiveSnapshot]` 或者用 `useReducer` 把 active 也包起来
  - helper: `getRunner(key)`, `updateRunner(key, patch)`, `updateActive(patch)`, `switchTo(key)`, `attachSseFor(key)`, `closeSseFor(key)`, `lruEvict()`
- **重写**：`send`, `startNewSession`, `useEffect[selectedId]`, `attachSse`, `handleAgentEvent`, `agentAction`, fork 各路径, retry, compact, abort 这些；从 `state.xxx` 读值改成 `activeSnapshot.xxx` 或 `runnersRef.get(key).xxx`
- **保留**：渲染部分尽量不改 —— 把 `activeSnapshot` 解构出来用同名变量
  ```ts
  const {
    chatState, agentId, streaming, agentPhase, input, pendingImages, /* ... */
  } = activeSnapshot;
  ```
- **新增 setter wrappers**：
  ```ts
  const setInput = (v: string | ((p:string)=>string)) => 
    updateActive(s => ({ input: typeof v==='function' ? v(s.input) : v }));
  ```
  对所有原 setter 提供同名 wrapper，这样 1500 行的下面的 callbacks 几乎不用改

### 边界情况

1. **草稿在 send 中（agent 创建中）切到 B**：
   - 草稿 runner 的 agentId 还没 fetch 回来 → 不能 attachSse
   - 解决：send 内部把"创建 agent"的 promise 存到 runner.creatingAgentPromise，切回 draft 时 await 它
   - 或简单点：send 期间 setActiveKey 仍然是 draft，await create 完成才升级 key —— 用户切走时 promise 在后台跑，回来时如果已升级就 setActiveKey 到新 key，否则仍是 draft 等创建完
   - 选简单方案：**send 期间不阻塞用户切换**，draft 升级在后台异步完成。如果完成时 user 已经离开了 draft，仅更新 runnersRef 不动 activeKey
   
2. **A 流式中、用户在 A 输入框打了一半字**：
   - input 已是 runner-local，自然保留
   - 切到 B 不影响 A

3. **A 流式 + 收到 message_end 时 user 在 B**：
   - handleAgentEvent 的 `setStreaming(false)` 现在等于 `updateRunner(aKey, { streaming: false })`，不影响 B 的 active snapshot
   - `playDoneSound()` 仍触发（全局一次性副作用，符合"完成提示音"语义）
   - `refreshSessions()` 仍触发
   - `refreshForkList(aidForEvents)` 仍触发，但要把结果写到那个 runner 的 forkableUserMessages 而非全局
   - `refreshStats(aidForEvents)` 同理

4. **handleAgentEvent 的 "owner key" 解析**：
   - SSE attach 时把 key 作为闭包变量绑进 onmessage
   - handleAgentEvent 改签名 `(ev, ownerKey)`；setChatState 等改成 `updateRunner(ownerKey, patch)`

5. **SSE 重连 + since-seq**：
   - 每个 runner 维护 lastSeq（在 onmessage 里更新：`event.seq` 来自后端事件 envelope —— 需确认 envelope 是否带 seq；目前看 `lib/agent-registry.ts` 是 emit 时带 seq 的，SSE route 应该也透出来了）
   - onerror 时不立即 reconnect（原来也只是 setSseStatus）—— 浏览器 EventSource 自带重连，但 server-side EventSource 端可能不带 since 参数。需确认 SSE route 实现
   - **第一版可以简化**：onerror → 1s 后手动 close + new EventSource(?since=lastSeq)，最多重试 N 次

6. **fork 路径**：
   - submitFork → 后端可能产生新 agentId / 新 sessionFile
   - 当前代码"原地刷新 chatState"，对 P1 也行 —— 视为"在当前 runner 上重置 chatState 并续 attachSse"
   - 需细看 1631、1730 处实现确认

7. **forkToNewSession**：
   - 创建一个**新 runner**(新 sessionFile)，老 runner 保留（用户可切回）
   - sidebar 会显示 parent + child

### 不在 P1 范围
- Sidebar 运转指示器（P2）
- 切换 200ms fade（P2）
- 多 runner 并行渲染（不做）

---

## 实施步骤（下一轮对话）

按以下顺序写，每步可独立验证（tsc + 手动）：

1. 定义 `RunnerState` 类型 + `emptyRunner()` factory + `runnersRef` / `esMapRef` / `[activeKey, activeSnapshot]`
2. 写 `updateRunner(key, patch)` / `updateActive(patch)` / `switchTo(key)` 三个 helper
3. 写所有原 setter 的同名 wrapper（`setChatState` → `updateActive(s => ({chatState: typeof v==='function' ? v(s.chatState) : v}))`），让现有 callbacks 几乎不用改
4. 重写 `attachSseFor(key, agentId)` 取代 `attachSse`
5. 重写 `handleAgentEvent(ev, ownerKey)`：所有 set 改为 `updateRunner(ownerKey, ...)`
6. 重写 `startNewSession`：先确保 draft runner 存在，把活跃切到 draft；不立即 create agent（保留原行为：发送时再 create）
7. 重写 `send`：草稿升级路径 + agentId 创建后 attachSseFor + 把 draft renamed 到 sessionFile key + 新建空草稿
8. 重写 `useEffect[selectedId]`：找已有 runner 直接切；否则 lazyOpen（fetch context、把 chatState 写入新 runner、不 attachSse）
9. fork / retry / compact / abort：调整为 per-runner
10. LRU eviction：在 `updateRunner` 或 `setActiveKey` 后检查 runnersRef.size，超 8 就踢
11. SSE since-seq 重连：先确认后端是否支持，再决定要不要做

最后跑 tsc + 手动验证：

- [ ] 在 A 发送一条长 prompt → 切到 B 输入框打字 → 验证 B 能输入
- [ ] B 发送一条 prompt → 切回 A → 验证 A 后续 token 连续显示，没丢
- [ ] B 流完成、切回 B → 看到完整内容
- [ ] +New chat → 切到 A → 切回 New chat 看到草稿输入还在
- [ ] 开 9 个 session 切来切去 → LRU 退出最旧的，无报错

---

## 风险

- ChatApp.tsx 体量太大，重构容易碰其他无关功能。**缓解**：用同名 setter wrapper，让下半部分代码（callbacks/render）几乎不动。
- SSE since-seq 后端可能不支持。**缓解**：第一版不重连（依赖 EventSource 自动重连），事件丢失风险存在但小。
- handleAgentEvent 的事件类型很多（compact/retry/thinking_level_changed），漏一个就 bug。**缓解**：实施步骤 5 完成后写一个测试场景：发起一条会触发 thinking + tool 的 prompt，对照修改前后行为。

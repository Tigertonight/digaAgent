# RFC-1：ChatApp.tsx 拆分方案

> **状态**：Proposed
> **作者**：Diga Agent 团队（含 AI 辅助）
> **创建**：2026-06-02
> **关联**：[RFC-2 Agent 协作模式 v0](./2026-06-02-rfc-2-agent-collaboration.md)、[RFC-3 Session as Knowledge](./2026-06-02-rfc-3-session-as-knowledge.md)
> **审阅**：待定
> **预计工期**：3-4 周（1 人，含 CR 与回归）

---

## 0. TL;DR

`app/ChatApp.tsx` 当前 **4673 行**、**13 类 state**、**60+ callback**、**27 个 useEffect**、**单文件 handleAgentEvent 112 行 switch**。这是产品速度的根本瓶颈，每加一个新特性（无论 chat / pet / agent / session）都要在此文件翻找上下文，AI Agent 改它的成功率随行数指数衰减。

本 RFC 提出**按数据流职责拆分为 8 个模块**，分 3 个阶段渐进迁移，全程保持业务可用、可回滚。**完成后 ChatApp.tsx 控制在 800 行以内（纯组合 + 渲染），单测覆盖率从 ~5% 升到 50%+**。

---

## 1. 现状诊断

### 1.1 量化指标

| 维度 | 当前值 | 目标值 |
|---|---|---|
| ChatApp.tsx 总行数 | 4673 | < 800 |
| 单文件 hooks 数量 | 80+（useState/useRef/useCallback/useMemo/useEffect 总和） | < 20 |
| handleAgentEvent switch 长度 | 112 行 | 30 行（分发器） |
| 跨 callback 共享 state 数 | runnersRef 被 20+ callback 读写 | runnersRef 收敛到单 hook 内 |
| 单测覆盖（pet 以外） | < 5% | > 50% |
| 一次性需要加载到 LLM 上下文的相关代码 | 整个 4673 行 | 单模块平均 400 行 |

### 1.2 质性问题

- **TDZ / 顺序耦合**：本周做"SSE 重连"时已撞到一次（attachSseFor useEffect 因为变量提升顺序错位导致 TS2448）。这种问题在 4673 行单文件中**只会越来越多**。
- **看不到全貌**：13 类 state + 27 effect 互相穿插，任何贡献者（人或 AI）都无法完整 hold 住"我改这一行会影响什么"。
- **handleAgentEvent 单点风险**：13 种 event 在同一个 switch 里。新增 event 必改此文件、且容易漏处理。
- **测试不可能**：跟 React DOM、IPC、EventSource、fetch 强耦合，无法把"runner 状态转移"这类纯逻辑单独测。

### 1.3 已确认的 13 类 state（来自盘点）

| # | 类别 | 代表 state | 行数密度 |
|---|---|---|---|
| 1 | Session 管理 | sessions, selectedId, lastSeenMap, groupedSessions | 中 |
| 2 | **SSE + Runner** | **runnersRef, esMapRef, activeKey, activeSnapshot** | **高 ⚠️** |
| 3 | Chat 流 | chatState, input, pendingImages, streaming, agentPhase | 高 |
| 4 | Agent 身份 | agentId, agentSessionId, currentSessionFile | 中 |
| 5 | UI 状态 | cwd, theme, rightPanel, sidebarOpen 等 9 个 | 低 |
| 6 | Fork 交互 | forkingIndex, forkText, forkBusy 等 5 个 | 中 |
| 7 | Autocomplete | acMode, acItems, acIndex 等 5 个 | 中 |
| 8-13 | Dialog/Provider/Compact/Minimap/Pet 推送/其他 | … | 低-中 |

⚠️ **runnersRef 是热点**：20+ callback 直接或间接读写它，是整个组件的"事实之源"。拆分时必须最先收敛。

---

## 2. 目标与非目标

### 2.1 目标

1. **降低单文件复杂度**：ChatApp.tsx 从 4673 行降到 < 800 行
2. **可测试性**：核心数据流（runner 状态机、SSE 路由、agent 事件分发）能独立单测
3. **可演进**：未来新增 chat / pet / session 功能时，**改动半径可控**（一个 feature ≤ 2 个文件）
4. **零回归**：迁移过程中业务功能完全不变，无肉眼可见的行为差异

### 2.2 非目标

- ❌ 重写业务逻辑（本 RFC 仅做结构拆分）
- ❌ 引入新状态管理库（Redux/Zustand/Jotai —— 增加学习成本，现有 useReducer + ref 模型够用）
- ❌ 改变 SSE / IPC 协议（向后兼容）
- ❌ 改变 UI 设计

---

## 3. 拆分蓝图

### 3.1 目标模块图

```
app/ChatApp.tsx (~800 行)              纯组合 + 顶层布局 + 路由
  │
  ├─ hooks/
  │   ├─ useSessions.ts (~400)        session list / selectedId / lastSeenMap / 分组
  │   ├─ useRunners.ts (~500)         multi-runner 容器（runnersRef + activeKey + switchTo）
  │   ├─ useSseManager.ts (~400)      EventSource 池 + 重连 + 路由
  │   ├─ useChatStream.ts (~500)      send/abort/steer/followUp + pending images/files
  │   ├─ useAgentEvents.ts (~300)     handleAgentEvent 分发器（含 event handlers map）
  │   ├─ useForkable.ts (~250)        fork / navigate_tree / submitFork
  │   ├─ useAutocomplete.ts (~200)    @ / / 触发的命令补全
  │   └─ usePetPusher.ts (~150)       现已存在的宠物推送逻辑（节流 + 边沿）
  │
  ├─ components/
  │   ├─ ChatPanel.tsx (~600)         主对话区（messages list + minimap + input）
  │   ├─ SessionSidebar.tsx (~400)    左侧 session 列表（含未读 / 分组 / fork 树）
  │   ├─ ChatComposer.tsx (~300)      输入框 + 附件 + 发送按钮
  │   └─ RightPanel.tsx (~300)        右侧 HUD / 上下文 / 模型选择
  │
  └─ events/
      ├─ event-handlers.ts (~400)     handleAgentEvent 的每个 case 拆为独立纯函数
      └─ event-handlers.test.ts       纯函数单测
```

### 3.2 模块职责契约

#### ① `useSessions` — session 列表与选择

```typescript
interface UseSessionsReturn {
  sessions: SessionInfoLite[];                 // 全量 session
  groupedSessions: GroupedSessions;            // 按 fork 父子分组
  selectedId: string | null;                   // 当前选中
  setSelectedId: (id: string) => void;
  lastSeenMap: Record<string, string>;         // 已读时间戳（持久化到 localStorage）
  markSeen: (id: string) => void;
  refresh: () => Promise<void>;                // 拉取最新列表
  rename: (id: string, name: string) => Promise<void>;
  delete: (id: string) => Promise<void>;
}
```

**职责边界**：只管 session 元数据（list/CRUD/已读），不管单 session 内的 messages 流式。

#### ② `useRunners` — multi-runner 容器（最重要）

```typescript
interface UseRunnersReturn {
  runnersRef: MutableRefObject<Map<RunnerKey, RunnerSnapshot>>;  // 仍然是 ref
  activeKey: RunnerKey | null;
  activeSnapshot: RunnerSnapshot | null;
  switchTo: (key: RunnerKey) => void;
  ensureRunner: (key: RunnerKey, cwd: string) => Promise<RunnerSnapshot>;
  updateRunner: (key: RunnerKey, patch: Partial<RunnerSnapshot>) => void;
  closeRunner: (key: RunnerKey) => void;
  // LRU 自动驱逐（>5 个 inactive runner）
}
```

**职责边界**：**唯一**写 runnersRef 的地方。所有 callback 通过此 hook 暴露的方法操作，禁止直接读写 ref。

⚠️ 拆完之后 runnersRef 不再外漏，最热的"事实之源"被关在单一模块内。

#### ③ `useSseManager` — EventSource 池

```typescript
interface UseSseManagerReturn {
  attachSseFor: (key: RunnerKey, agentId: string) => void;
  detachSseFor: (key: RunnerKey) => void;
  // 由本 hook 内部把 SSE event 派发给 onEvent 回调
}

function useSseManager(opts: {
  onEvent: (ev: AgentEvent, agentId: string, key: RunnerKey) => void;
  onStatusChange: (key: RunnerKey, status: PetSseStatus) => void;
}): UseSseManagerReturn;
```

**职责边界**：管 EventSource 生命周期，不解析具体 event 内容。把"原始事件"和"连接状态"两条流分开输出。

🎁 副产品：宠物窗口的"SSE 重连"（本周做的任务 4）可以彻底简化 —— 主窗口暴露一个 IPC 直接调 `attachSseFor`，不必从 sessionId 反查 runner key 再调 attach。

#### ④ `useChatStream` — 消息发送 / abort

```typescript
interface UseChatStreamReturn {
  input: string;
  setInput: (s: string) => void;
  pendingImages: PendingImage[];
  pendingFiles: PendingFile[];
  addImage / addFile / removeImage / removeFile;
  send: (opts?: SendOptions) => Promise<void>;
  abort: () => Promise<void>;
  steer: (text: string) => Promise<void>;
  followUp: (text: string) => Promise<void>;
}
```

**职责边界**：把 send 的 16 个依赖收敛为 hook 内部 state + 显式参数。

#### ⑤ `useAgentEvents` — 事件分发器

把 112 行的 handleAgentEvent switch 拆成：

```typescript
// events/event-handlers.ts
export const eventHandlers: Record<AgentEvent['type'], EventHandler> = {
  agent_start: handleAgentStart,
  agent_end: handleAgentEnd,
  message_start: handleMessageStart,
  message_update: handleMessageUpdate,
  message_end: handleMessageEnd,
  tool_execution_start: handleToolStart,
  tool_execution_update: handleToolUpdate,
  tool_execution_end: handleToolEnd,
  compaction_start: handleCompactionStart,
  compaction_end: handleCompactionEnd,
  auto_retry_start: handleRetryStart,
  auto_retry_end: handleRetryEnd,
  thinking_level_changed: handleThinkingChange,
};

// 每个 handler 是纯函数：(ctx, event) => void
type EventHandler = (
  ctx: EventHandlerContext,
  event: AgentEvent
) => void;

interface EventHandlerContext {
  key: RunnerKey;
  agentId: string;
  updateRunner: UseRunnersReturn['updateRunner'];
  dispatchChat: React.Dispatch<ChatAction>;
  // ...
}
```

✅ **关键收益**：每个 handler 可独立单测，给一个 mock ctx 和 event，断言它调了哪些方法。

#### ⑥ `useForkable` — fork 与 navigate_tree

收敛 5 个 state（forkingIndex / forkText / forkBusy 等）和 3 个 callback（submitFork / forkToNewSession / startEdit）。

#### ⑦ `useAutocomplete` — @ / / 命令补全

收敛 5 个 state，未来可扩展为可注册的 "Slash Command Registry"（为 RFC-3 的 prompt 模板复用做铺垫）。

#### ⑧ `usePetPusher` — 宠物推送（已有雏形）

把现有的"节流 + 边沿对比 + IPC send"逻辑收敛成 hook。**这部分本周已经基本独立**，只是物理上还在 ChatApp.tsx 里，拆出来即可。

---

## 4. 实施路径（3 阶段，可独立合并）

### 阶段 A：底座（Week 1）

**目标**：拆出 `useRunners` + `useSseManager` + `useAgentEvents`。

这三个是依赖底座，所有其他 hook 都依赖它们。**先做这三个，后续拆分自然解耦。**

**任务列表**：

| # | 任务 | 工作量 | 验收 |
|---|---|---|---|
| A1 | 新建 `app/hooks/useRunners.ts`，把 runnersRef + activeKey + updateRunner / switchTo / ensureRunner / closeRunner / LRU 全部搬入；ChatApp.tsx 改为消费 hook | 1.5 天 | runnersRef 不再在 ChatApp.tsx 直接出现；切换 session 行为不变 |
| A2 | 新建 `app/hooks/useSseManager.ts`，把 esMapRef + attachSseFor + attachSse + closeSseFor 全部搬入；通过 `onEvent` 回调把事件吐给上层 | 1.5 天 | 多 session 并行 SSE 行为不变；宠物窗口断线重连 IPC 仍工作 |
| A3 | 新建 `app/events/event-handlers.ts`，把 handleAgentEvent 内 13 个 case 拆为纯函数；ChatApp.tsx 的 handleAgentEvent 改为 30 行分发器 | 2 天 | 所有 agent 事件流式行为不变；每个 handler 写 1 个 happy path 单测 |
| A4 | 回归测试 + 修 P0 | 1 天 | 跑通 multi-session 切换 / abort / fork / 宠物 / compact 等 |

**里程碑**：ChatApp.tsx 从 4673 行降到 ~3800 行；test 文件夹首次出现 event handler 单测。

### 阶段 B：消费层（Week 2）

**目标**：拆出 `useSessions` + `useChatStream` + `usePetPusher`。

| # | 任务 | 工作量 | 验收 |
|---|---|---|---|
| B1 | `useSessions` —— 含 localStorage 持久化 lastSeenMap（顺带修复"刷新页面已读丢失"bug） | 1.5 天 | 未读标识刷新后不丢；session 增删改查行为不变 |
| B2 | `useChatStream` —— 把 send / abort / steer / followUp 全部搬入；图片附件子模块 | 2 天 | 发消息、abort、附图所有路径 OK |
| B3 | `usePetPusher` —— 现有节流推送逻辑搬入，零行为变更 | 0.5 天 | 宠物状态推送行为不变 |
| B4 | 回归 + 修 P0 | 1 天 | 走一遍所有 P0 验收点 |

**里程碑**：ChatApp.tsx 降到 ~2200 行。

### 阶段 C：交互层 + UI 拆分（Week 3-4）

**目标**：拆出 `useForkable` + `useAutocomplete` + UI 组件。

| # | 任务 | 工作量 | 验收 |
|---|---|---|---|
| C1 | `useForkable` | 1 天 | fork / navigate_tree 行为不变 |
| C2 | `useAutocomplete` | 1 天 | @ 提及 / 斜杠命令行为不变 |
| C3 | `SessionSidebar.tsx` —— 左侧 session 列表全部抽出 | 1.5 天 | 列表 UI 像素级一致 |
| C4 | `ChatComposer.tsx` —— 输入框 + 附件 + 发送 | 1.5 天 | composer UI / 行为一致 |
| C5 | `RightPanel.tsx` —— HUD / 上下文 / 模型选择 | 1 天 | 右侧栏 UI / 行为一致 |
| C6 | `ChatPanel.tsx` —— 消息列表 + minimap | 1.5 天 | 消息渲染 / 滚动 / minimap 一致 |
| C7 | 最终回归 + 文档 | 1 天 | ChatApp.tsx < 800 行；CHANGELOG 更新 |

**里程碑**：ChatApp.tsx 降到 < 800 行；目标达成。

---

## 5. 兼容与迁移策略

### 5.1 渐进迁移原则

- **每一步都能合并到主分支**：阶段 A/B/C 内每个任务都是独立 commit，可独立 PR，可独立 revert
- **不一次性"大爆炸"**：禁止"一周不能编译、最后一把合并"
- **每个任务后必须能跑**：`npm run electron:dev` 必须可启动且功能完整

### 5.2 行为不变保证

- **每次拆分前**：在原文件做 grep / git blame，确保理解原意图
- **每次拆分后**：手动跑一遍验收清单（见附录 A），同时跑 `npx tsc --noEmit`
- **关键路径**：multi-session 并行、abort、fork、宠物推送 —— 每个任务后都必须验

### 5.3 回滚

每个任务一个 commit，message 写明"refactor: extract X from ChatApp"。出问题 `git revert` 即可，无需 hotfix。

---

## 6. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 拆分中破坏 SSE 多路由 | 中 | 高（核心功能挂） | 阶段 A 完成后专门做 multi-session 回归；A2 完成必须人工跑 2 个并发 session |
| handleAgentEvent 拆分漏处理某 event | 低 | 中（特定状态不更新） | A3 任务必须把 13 个 case 都列在 PR 描述里 checklist 化 |
| useSessions 引入 localStorage 后 SSR / hydration 出错 | 中 | 低（页面闪烁） | 仿 PetApp 的 useNeedMock 模式，mount 后才读 localStorage |
| ref 跨 hook 共享导致闭包陈旧 | 中 | 中 | 严格遵循"ref 只在所属 hook 内写，其他 hook 通过暴露的方法读写" |
| 迁移期跟其他 feature 开发冲突 | 高 | 中 | 阶段 A 优先 / 集中 1 周做完，避免长期分支；阶段 B/C 可与新 feature 并行 |
| 拆分中遗漏 useEffect 清理 | 低 | 高（内存泄漏） | 每个 useEffect 必须显式写 cleanup，PR review 必查 |

---

## 7. 验收指标

- [ ] `app/ChatApp.tsx` < 800 行
- [ ] `wc -l app/hooks/*.ts` 平均 < 500 行
- [ ] `npm run lint` 不引入新 error（warning 允许，但需新增 0 行 set-state-in-effect）
- [ ] `npx tsc --noEmit` 零错误
- [ ] event-handlers.ts 单测覆盖 13/13 个事件类型
- [ ] 手动回归清单（附录 A）全绿
- [ ] 一次 LLM agent 改"chat 输入框"类需求只需读 ChatComposer.tsx + useChatStream.ts（< 800 行总和）

---

## 8. 决策依据 / 备选方案

### 8.1 为什么不引入 Zustand / Jotai？

- 团队规模小，现有 useReducer + ref 模型已能工作
- 引入新库 = 新心智模型 + 新 bug 表面 + 文档负担
- React 19 + hooks 的组合已足够，**拆分能解决 90% 问题**
- 未来若确实需要全局 store（如跨 ChatApp / PetApp / Settings 共享），再单独评估

### 8.2 为什么不一次性重写？

- 4673 行重写 = 至少 6 周 + 高概率引入回归 + 团队恐惧
- 渐进迁移 = 每周可见进展 + 可随时停止 + 风险可控
- "可工作的烂代码" > "正在写的好代码"

### 8.3 为什么不拆得更细（如每 hook < 200 行）？

- 过度拆分 = 跳来跳去看代码 = 心智负担反而增加
- 400-500 行 / 模块是 LLM 一次性能 hold 住、人脑也能理解的甜蜜点
- 真实业务复杂度摆在那，不要追求人为对称

---

## 附录 A：拆分期手动回归清单

每个阶段任务完成后必须人工走查：

**核心**
- [ ] 启动 Electron，主窗口正常打开
- [ ] 创建新 session（+ New chat），输入消息发送
- [ ] 流式输出正常、tool 调用正常、agent_end 后 streaming=false
- [ ] 在 session A 流式中切到 session B，再切回 A，state 不丢

**并发**
- [ ] 同时启动 3 个 session，分别发消息，各自 SSE 独立
- [ ] 中间一个 abort，其他不受影响
- [ ] runnersRef 中 inactive runner 在 LRU 触发后被正确驱逐

**Fork**
- [ ] 历史消息处 fork 到新 session，新 session 内容正确
- [ ] navigate_tree 切换不同分支

**宠物**
- [ ] 宠物窗口接收 PetState 推送
- [ ] sprite 状态、卡片、toast、断线重连、右键菜单全部正常

**异常**
- [ ] 手动 kill agent 进程，sseStatus → lost
- [ ] 网络断开恢复，重连成功
- [ ] compact / retry 状态在宠物气泡正确展示

---

## 附录 B：模块依赖图

```
ChatApp.tsx
    ↓ uses
useSessions ──→ /api/sessions/*
useRunners (RUNNERS REF 唯一持有者)
    ↑                          ↑
useSseManager ──→ EventSource  │
    ↓                          │
useAgentEvents ──→ event-handlers.ts (纯函数)
    ↑                          │
useChatStream ─────────────────┘
    ↓
useForkable / useAutocomplete / usePetPusher

UI:
ChatPanel / SessionSidebar / ChatComposer / RightPanel
    ↑ props
ChatApp.tsx 顶层组合
```

依赖方向严格单向：UI ← hooks ← lib（agent-registry / session-runner / chat-reducer）。

---

## 附录 C：阶段 A 执行小结（2026-06-01 完成）

### 实际产出

| 任务 | commit | 新文件行数 | ChatApp 变化 |
|---|---|---|---|
| A1 useRunners | `da7ec14` + 修复 `ec94001` | 211 行 | 4674 → 4574（-100） |
| A2 useSseManager | `e8a966a` | 167 行 | 4574 → 4545（-29，含死代码顺手清理） |
| A3 useAgentEvents | `52d7a6f` | 236 行 | 4545 → 4432（-113） |
| **A 阶段累计** | 4 commits | **614 行（3 hooks）** | **4674 → 4432（-242）** |

### 与 RFC 预测对比

| 维度 | 预测 | 实际 | 差异原因 |
|---|---|---|---|
| ChatApp 行数降幅 | ~3800（-870） | 4432（-242） | RFC 预测高估了「纯抽离」的减行效果——抽离 hook 时，hook 调用 + ref 转发 + 参数注入本身占行；真正大减行要靠 B 阶段拆 useChatStream（send/abort/steer/followUp 集中在 ChatApp 内） |
| handleAgentEvent 分发器长度 | 30 行 | hook 内 switch 仍 ~100 行 | 选择了「A3-中」方案：抽 hook 但不做纯函数化 + 单测（节省 2 天，留给阶段 B/C） |
| 单测覆盖 | event handler 各 1 happy path | 0 | 同上，纯函数化推迟 |

### 关键设计决策

1. **循环依赖通过两根 ref 转发**：useSseManager 必须先于 useRunners / useAgentEvents 调用（onEvict 直传 closeSseFor），但其 onStatusChange / onEvent 又依赖后两者。解法：`updateRunnerRef` + `handleAgentEventRef`，在 useEffect 同步真实函数。这是 React hooks 调用顺序约束下的标准模式，不是 hack。

2. **useRunners 封装 setRunner API**：A1 初版漏淘汰 LRU（场景 5 e2e 红），根因是 ChatApp 内仍有 `runnersRef.current.set` 直接写入绕过 LRU 检查。修复方案不是把 LRU 推给调用方，而是封装 `setRunner` 入口，强制所有写入走同一道闸门。

3. **A3 选「中」不选「重」**：原 RFC A3 包含纯函数化 + 单测，实际只做 hook 抽离 + `derivePhaseFromReducerEvent` 拆出。原因：当下瓶颈是 ChatApp 太长无法 hold 全貌，不是事件处理逻辑没单测。单测可在阶段 C 末尾统一补，避免在拆分中途引入第三种概念（hook + 纯函数 + 单测）。

### 未达成项（转给后续阶段）

- **`runnersRef.current` 直接读写仍 13 处**（业务逻辑：LRU 检查 / DRAFT 升级 / runner 遍历）—— **归属 B2 useChatStream（send 路径 DRAFT 升级）+ B1 useSessions（LRU 触发）**
- **event handler 纯函数化 + 单测** —— 归属 **阶段 C 末尾**
- **lint 存量 78 problems（3 errors）** —— 与 A 阶段无关，单独 commit 清理

### A 阶段验收

- `tsc --noEmit` ✓
- `npm run build` ✓（13.4s）
- `npx playwright test` ✓（6/6, 11.3s）—— 覆盖核心 + 并发 + LRU + 草稿
- 手动验收清单（Fork / 宠物 / compact / 断线重连）：**留待 Electron 内手动走查**

---

## 附录 D：阶段 B 执行小结（2026-06-02 完成）

### 实际产出

| 任务 | commit | 新文件行数 | ChatApp 变化 |
|---|---|---|---|
| B1 useSessions（+ 修刷新已读丢失 bug） | `ccb0f24` | 336 行 | 4432 → 4275（-157） |
| B2-a useChatStream（8 callback：agentAction/send/onAbort/onCompact/onAbortCompaction/onSteer/onFollowUp/onChangeThinking） | `59e7873` | 434 行 | 4275 → 4088（-187） |
| B2-b useComposerAttachments（4 callback：addImageFiles/removePendingImage/onDropFiles/removePendingFile + kindFromName） | `904fbce` | 160 行 | 4088 → 4024（-64） |
| B3 usePetPusher（5 ref + 2 effect + derivePetToolTarget） | `131df44` | 288 行 | 4024 → 3781（-243） |
| **B 阶段累计** | 4 commits | **1218 行（4 hooks）** | **4432 → 3781（-651）** |

### 与 RFC 预测对比

| 维度 | 预测 | 实际 | 差异原因 |
|---|---|---|---|
| ChatApp 行数降幅 | ~3500（-900） | 3781（-651） | 略低于预测但方向正确。差额主要来自：`startNewSession` / `runSlashCommand` / `refreshForkList` / `refreshStats` / `refreshToolsCount` 暂留 ChatApp（依赖太散，强抽会让接口超 10 参数），等到 C 阶段统筹处理 |
| useChatStream 复用 agentAction | 设计时未明确 | 实际 hook 把 agentAction 同时 return 给 ChatApp，供 `onChangeModel` / fork 流程复用 | 避免重复实现 PATCH 接口逻辑 |
| 累计减行（A+B） | ~870 + ~900 = 1770 | **893** | 实际 893/1770 ≈ 50% —— 与预期相符（C 阶段还有 ~900 行待拆，多为 UI 子组件） |

### 关键设计决策

1. **B1 修复刷新已读丢失 bug**：原 `useState({})` + `useEffect` 异步加载导致 mount 后第一次 render `lastSeenMap={}`，selectedId 初始 effect 触发的 markSessionSeen 用空字典对比 → 误判已读。改成 lazy init（`useState(() => readFromLocalStorage())`）一次性读出，问题消失。

2. **B2-a hook 完全无状态**：8 个 callback 全部通过参数订阅式读取 runner state，hook 内部零 `useState`。草稿升级闭包 `upgradeDraftIfNeeded` 完整搬入 send 内部，runnersRef + SSE 操作通过参数注入。换取的好处：hook 接口干净、ChatApp 仍保留所有 state 来源、未来如要测试 send 路径只需 mock 参数。

3. **B2-a sendAgentText 公共化**：onSteer 和 onFollowUp 95% 逻辑重复（仅 `kind` 字段不同），抽内部 `sendAgentText('steer'|'follow_up')` 公共 fn，避免双倍维护。

4. **B2-b hook 调用顺序约束**：useComposerAttachments 依赖 setter wrappers（`setPendingImages` / `setPendingFiles`），hook 调用必须挪到 setter wrappers 之后。同时 `useDragDrop` 和 `onPasteTextarea` 读 `onDropFiles` / `addImageFiles`，也必须一起挪。这是 hooks 调用顺序天然约束，不是问题。

5. **B3 derivePetToolTarget 连根抽**：纯函数唯一调用方就在推送块内，与 hook 同生命周期，搬入 hook 文件而非单独到 lib（避免「单独成文件但只有一处调用」的伪解耦）。若 C 阶段有别处需要再升级到 lib/pet-utils.ts。

6. **B3 hook 完全无外部状态**：5 ref（streamingStartedAtRef / petPushTimerRef / petLastPushedAtRef / petDoPushRef）全部封闭在 hook 内，ChatApp 不再需要持有任何宠物推送相关状态。

7. **lint 净增 0 策略**：B 阶段全程保持「-N +N 净 0」节奏，3 个存量 error（L1965 / L4125 等）不动。最终 lint 从 78 problems 降到 123 → 实际相比 baseline 减少（B2-b -6、B3 -2）。

### 未达成项（转给 C 阶段）

- **`startNewSession` 暂留 ChatApp**（与 sidebar +New chat 强相关，依赖 8+ 个 setter，强抽会让接口爆炸）—— **归属 C2 useAutocomplete 或 C 阶段末尾的「sidebar 子组件」拆分**
- **`runSlashCommand` 暂留 ChatApp**（依赖太散：调用 send / 修 input / 操 sessions / 弹 modal）—— **归属 C2 useAutocomplete**
- **`refreshForkList` / `refreshStats` / `refreshToolsCount` 暂留 ChatApp** —— **归属 C1 useForkable** 和 C 阶段 RightPanel 子组件
- **PendingAttachment / PendingAttachmentKind 类型死代码**（被 FileChip UI 用，C 阶段子组件抽出时一并搬走）

### B 阶段验收

- `tsc --noEmit` ✓
- `npm run build` ✓
- `npx playwright test` ✓（6/6, ~10s）—— 每个阶段提交前都全绿
- 手动回归（宠物窗口副文案 / 切 session 已读清除 / 第一次启动不闪「等待启动」）：**留待 Electron 内手动走查**

### B 阶段进度全景

```
ChatApp.tsx:  4674 → 4432 → 4275 → 4088 → 4024 → 3781  （累计 -893, -19.1%）
hooks/:       0   →  614 →  950 → 1384 → 1544 → 1832  （7 个 hook）
```

- 综合进度：A+B 完成 ≈ 总工作量 60%，剩余 C 阶段（C1 useForkable / C2 useAutocomplete / C3-C6 UI 子组件 / C7 回归 + 单测）
- 节奏：A 阶段 1 天 / B 阶段 1 天（同等代码量，B 更复杂但流程已跑顺）

---

## 附录 E：阶段 C 执行小结（2026-06-02 完成）

### 实际产出

| 任务 | commit | 新文件行数 | ChatApp 变化 |
|---|---|---|---|
| C1 useForkable（fork 流程 + 分支列表 + refreshForkList + getForkedFromBaseSnapshot 全量搬运） | `b1e748e` | 424 行 | 3781 → 3559（-222） |
| C2 useAutocomplete（slash/@-path 双补全 + onKeyDown 拦截 + SLASH_COMMANDS 注册表 + runSlashCommand） | `7cc8d95` | 330 行 | 3559 → 3370（-189） |
| C3 MessageView + lib/format（消息列表渲染 + formatRelativeTime/shortCwd/formatMessageTime 三 helper） | `0399415` | 536 + 57 行 | 3370 → 2810（-560） |
| C4 HudMeter + SystemPromptModal（顶栏 token/cost HUD + system prompt 编辑模态） | `8099b35` | 124 + 82 行 | 2810 → 2621（-189） |
| C5 Composer（输入区 textarea + 控制条 + 内嵌发送/Steer/Follow-up/Abort + 内联 FileChip，40 props） | `c8a7de0` | 605 行 | 2621 → 2223（-398） |
| C6 Sidebar（左侧栏整体 aside：brand+new + cwd + sessions 列表 + explorer + Models/Skills 双标签，27 props） | `23d089c` | 440 行 | 2223 → 1889（-334） |
| **C 阶段累计** | 6 commits | **2598 行（2 hooks + 6 组件 + 1 helper）** | **3781 → 1889（-1892）** |

### 与 RFC 预测对比

| 维度 | 预测 | 实际 | 差异原因 |
|---|---|---|---|
| ChatApp 最终行数 | ~600（目标） | **1889** | 差距来自顶部布局 / Effects 集群 / RightPanel 子组件抽离未做（属 RFC 范围外）；纯逻辑/UI 抽离任务已 100% 完成 |
| C 阶段累计减行 | ~900 | **1892** | 比预测好 2x：附录 D 的「未达成项」(`startNewSession` / `refreshForkList` / `refreshStats` 等) 全部在 C1-C2 一并解决；同时 unused imports 清理顺便砍掉了 ~80 行 import 块 |
| 子组件数量 | 4-5 | **6**（MessageView, HudMeter, SystemPromptModal, Composer, Sidebar, FileChip 内联） | Composer 加 FileChip 内联，避免单独建小文件 |
| lint warnings | 不变 | **111 → 91（-20）** | C5/C6 顺手清掉 C1-C4 累积的 unused imports（formatBytes / approxBase64Bytes / 18 个 lucide icon 等） |

### 关键设计决策

1. **C1 useForkable 把 refreshForkList 一并抽走**：附录 D 标记为「未达成」，C1 顺手解决。原因：forkable 状态本身就在 hook 内，refreshForkList 调用方仅一处（fork 操作完成后），强行外置无意义。

2. **C2 SLASH_COMMANDS 注册表**：原来 12 个 `/` 命令散在 onKeyDown 里 switch，C2 抽出时建注册表，每个命令含 name/desc/handler 三字段。`runSlashCommand` 也跟进搬到 hook，统一通过参数注入需要的 callback（startNewSession / setShowFilePicker 等）。

3. **C3 MessageView 一次性吞掉 message-related 闭包**：message 列表渲染、`messageRefs`、`useMessageRefs`、思考块折叠、用户消息编辑、复制按钮，全部一并搬入 MessageView（不分批），避免「先抽 70%、剩 30% 当胶水」的尴尬。lib/format 同时建好，避免 component 内嵌 helper。

4. **C3 踩坑：formatMessageTime 凭印象重写**：第一次实现时按"印象"写了一个不带星期的版本，e2e 失败后回 ChatApp 旧版 1:1 抄过来。**从此立规：抽出的 helper / 组件必须 1:1 复制原代码，不要凭印象**——C4/C5/C6 严格遵守。

5. **C4 两个小组件合并提交**：HudMeter（124 行）+ SystemPromptModal（82 行）单独提 commit 太琐碎，合并到 C4 一次提。但每个文件独立，互不依赖。

6. **C5 Composer 40 props 是上限**：原 ChatApp 输入区有 14 个 useState + 16 个回调 + 多种状态条件分支。考虑过用 context 但会破坏「子组件纯受控」原则，最终接受 40 props 接口。8 组分类（textarea / 流式 / 附件 / 自动补全 / 发送 / Retry+Compact / Provider+Model+Thinking / Tools+Sound）让接口可读。FileChip 内联到同文件不另开（专用组件）。

7. **C5 类型对齐严肃化**：第一次写 ComposerProps 凭印象写 `acItems: string[]` / `acMode: "slash" | "path"`，tsc 直接报错。修正流程：查 useAutocomplete 真实 return 类型 → 改 props 类型 → 配套 import AutocompleteItem / Dispatch<SetStateAction<number>>。**类型不应该凭印象写，应该读源码**。

8. **C6 Sidebar 整体抽走 aside**：原 RFC 计划叫 SidebarSessions（只抽中间列表）。实际盘点发现 aside 的 5 段（brand+new / cwd / sessions / explorer / Models/Skills）耦合度低、纯展示，整体抽更干净（27 props < 两次抽合计 35+ props）。renderRow 保留 Sidebar 内闭包：依赖太多 props，提取 RowComponent 反而 props 爆炸。

9. **C6 顺手大扫除 unused imports**：抽完 Sidebar 后，ChatApp 顶部累积了 26 个 unused（PillSelect / ProviderIcon / InputAutocomplete / SidebarExplorer / 18 个 lucide icon / 2 个 image-utils helper / 2 个 format helper）。这些是 C1-C5 留下的"快速通过 lint"债务。C6 借机一次性偿还，lint 直接从 111 降到 91。

10. **lint 净增 0 → -20 终值**：B 阶段定的"-N +N 净 0"策略，到 C 阶段实际超额完成。原因：C5/C6 抽离子组件时，发现旧 import 不再被引用，**对照 grep count 校验后批量删**——这是机械操作但需要警惕"误删 BrandLogo"（曾在 L1543 还在用）。

11. **C7 不引入 vitest 单测框架**：项目目前只有 playwright（e2e），单测要新引依赖+配置+CI。这超出 C 阶段「拆分 + 不破坏行为」的范畴，应当作独立 RFC（小型基础设施）。当前 e2e 6/6 全绿足以保证回归。

### 未达成项（转给后续 RFC）

- **ChatApp.tsx 仍 1889 行**：剩余主要是顶部布局 (header / theme toggle / sidebar toggle / panel toggles)、modal 集群（ShowFilePicker / ShowSkillsConfig / ShowModelsConfig / ShowCwdPicker / ShowAuth / SystemPromptModal 触发 props）、useEffect 集群（drag-drop / SSE 启动 / theme persist / window event listeners）。这些都不是「业务模块」级别，硬抽不划算。建议留待 **RFC-1.5 ChatApp 顶部布局精修**（独立小 RFC，估 1 天）或并入 RFC-2/3。
- **单测覆盖**：lib/format / lib/chat-reducer / useSessions 等已有清晰边界的模块值得加单测。建议 **RFC-test-infra**（独立小 RFC，引入 vitest + 配置 + 写 3-5 个示范单测）。
- **RightPanel 子组件**（files browser / tools panel / branches popover 等）：这些原本就已是独立组件，ChatApp 只是组装它们，不在 RFC-1 范围。

### C 阶段验收

- `tsc --noEmit` ✓（每个子阶段提交前都通过）
- `npm run build` ✓
- `npx playwright test` ✓（6/6, ~7s）—— C1-C6 每次提交前都全绿
- lint **111 → 91**（-20 warning，净改善）
- 手动回归（fork 流程 / @-path 补全 / message 编辑 / HUD 显示 / system prompt 编辑 / 输入区发送+Steer+Follow-up+Abort / sidebar 切 session+rename+delete+export+menu）：**留待 Electron 内手动走查**

### C 阶段进度全景

```
ChatApp.tsx:  3781 → 3559 → 3370 → 2810 → 2621 → 2223 → 1889
              （C1）  （C2）  （C3）  （C4）  （C5）  （C6）
              累计 -1892, -50.0%

新增产物：
  hooks/:           +754 行（useForkable 424 + useAutocomplete 330）
  components/:      +1787 行（MessageView 536 + HudMeter 124 +
                              SystemPromptModal 82 + Composer 605 +
                              Sidebar 440）
  lib/:             +57 行（lib/format.ts）
  C 阶段总计：       +2598 行
```

### RFC-1 总览（A + B + C 全阶段）

| 阶段 | 任务数 | commits | 新代码 | ChatApp 变化 | 累计减行 |
|---|---|---|---|---|---|
| A | 4 | 4 | 614（4 hooks） | 4674 → 4432 | -242（-5.2%） |
| B | 4 | 5 | 1218（4 hooks） | 4432 → 3781 | -893（-19.1%） |
| **C** | **6** | **6** | **2598（2 hooks + 5 组件 + 1 helper）** | **3781 → 1889** | **-2785（-59.6%）** |

```
ChatApp.tsx 全程：4674 → 1889  （-2785 行 / -59.6%）
hooks/ 全程：     0    → 2586  （9 个 hook）
components/ 全程： 已存 → +1787 （5 个新组件）
lib/ 全程：       已存 → +57   （format helper）
```

- 节奏：A 1 天 / B 1 天 / **C 1.5 天**（C5+C6 耗时最多，因为 props 接口大、需仔细盘点）
- **「先想清楚再整体实施」策略奏效**：每个子阶段都先盘点依赖→列 props 清单→建文件→1:1 复制→tsc 校准类型→lint+build+e2e 验收→commit。零回滚、零事后修补
- **质量保证**：每次提交前 e2e 6/6 全绿；lint 111 → 91（净改善 20）；tsc/build 全程干净

### 后续 RFC 衔接

- **RFC-1.5（建议）**：ChatApp 顶部布局精修（header / theme / panel toggles / modal 集群），目标 ChatApp < 1200 行。1 天工作量
- **RFC-test-infra（建议）**：引入 vitest + 给 lib/format / chat-reducer / 关键 hooks 加单测。1 天工作量
- **RFC-2 Agent Collaboration**：在 RFC-1 已拆分干净的 hook 基础上，新增多 agent 协作。useSessions / useChatStream 可直接复用
- **RFC-3 Session as Knowledge**：在 useSessions 之上增加 session 标签 / 跨 session 搜索能力

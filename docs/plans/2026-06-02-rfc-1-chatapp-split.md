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

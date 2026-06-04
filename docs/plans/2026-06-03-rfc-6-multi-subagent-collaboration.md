# RFC-6: Multi-Subagent Collaboration

> **状态**：Draft
> **创建**：2026-06-03
> **目标**：让主 agent 在识别到任务可拆分、可并行、需多角色协作时，自动派发多个 subagent 独立处理子任务，并把结果收束回主 agent 综合输出。
> **范围**：Subagent 编排器、内部委派工具、事件协议、Chat UI 状态卡、同进程 MVP 与独立进程演进路线。
> **预计工期**：MVP 4-6 人天；独立进程版另计 5-8 人天。

---

## 0. TL;DR

mini-pi-web 当前已经具备多 session、工具审批、主动追问、SSE 自定义事件等协作基础，但所有复杂任务仍由一个 agent 串行完成。对于批量 RAG 问答、规则制度查询、代码审查、竞品分析这类任务，一个 agent 往往会在多个问题之间来回切换，导致速度慢、上下文混杂、答案不易归因。

本 RFC 建议新增 **Multi-Subagent Collaboration** 能力：

```text
用户提出复杂任务
  -> 主 agent 判断任务适合拆分
  -> 主 agent 调用 delegate_subagents 内部工具
  -> SubagentOrchestrator 创建 N 个 child AgentSession
  -> 每个 child 独立处理一个子任务
  -> UI 实时展示每个 subagent 状态
  -> Orchestrator 收集结果
  -> 主 agent 基于结构化结果综合回答
```

**核心判断**：第一版不直接做独立进程。当前 `agent-registry` 已经能在同一 Node 进程创建多个 `AgentSession`，且每个 session 有独立 `agentId`、session 文件、SSE ring buffer、extension 注入链。先做 **同进程多 AgentSession MVP**，能最快验证产品形态；独立进程放到 Phase D，用于资源隔离、崩溃隔离和后台长任务。

| Phase | 主题 | 一句话目标 | 工期 |
|---|---|---|---|
| **A** | Subagent 数据模型 + Orchestrator | 后端能创建、运行、收集多个 child agent | 1.5-2d |
| **B** | `delegate_subagents` 内部工具 | 主 agent 能主动派发子任务 | 1-1.5d |
| **C** | SSE 事件 + UI 状态卡 | 用户看到每个 subagent 的启动、完成、失败 | 1.5-2d |
| **D** | 独立进程 Worker | 把 child agent 搬到独立进程，支持隔离与并发上限 | 5-8d |

---

## 1. 现状盘点

### 1.1 已有基础设施

当前代码里已经有几条非常关键的能力链：

| 能力 | 当前实现 | 对 subagent 的价值 |
|---|---|---|
| 多 AgentSession | `lib/agent-registry.ts#createAgent` | 可以创建多个 child agent，不需要重写 SDK |
| SSE ring buffer | `pushExternalEvent` / `getEventsSince` | subagent 状态可以复用自定义事件推给前端 |
| Inline extension | `createCollabExtension` / `createClarificationExtension` | 可以继续给 child agent 注入工具审批、追问、浏览器等能力 |
| Chat reducer custom part | approval / clarification 已接入 | subagent batch 可以作为新的 message part 渲染 |
| Session 文件 | `session.sessionFile` | 每个 child 的上下文天然可追踪、可恢复 |

这意味着 subagent 不需要从零发明一套运行时。正确方向是新增一个 **编排层**，让它复用现有 agent 创建、事件、审批和 UI 管线。

### 1.2 当前缺口

当前系统不支持：

- 主 agent 判断“这个任务应该拆给多个 agent”。
- 将一个用户任务拆成多个结构化子任务。
- 子任务并行运行与状态汇总。
- 子 agent 的答案回流给主 agent 综合。
- UI 展示 subagent checklist。
- 子 agent 与主 agent 的权限隔离。
- child agent 出错后的重试、降级、取消。

### 1.3 为什么不第一版就独立进程

独立进程的长期价值很明确：

- child agent 崩溃不拖垮主进程。
- 可以限制并发、CPU、内存、超时。
- 可以把长任务放后台。
- 可以为 coding subagent 分配独立 worktree。

但第一版直接上独立进程会多出很多非核心复杂度：

- 进程间事件转发。
- AgentRecord 跨进程同步。
- SSE owner 归属。
- Pending approval / clarification 跨进程唤醒。
- Worker 生命周期、日志、回收。

MVP 的产品风险不是“进程不够独立”，而是“主 agent 何时拆分、拆分后答案是否更好”。所以第一版先验证编排协议。

---

## 2. 目标与非目标

### 2.1 目标

**G1：主 agent 能主动委派。**

当任务包含多个互相独立的问题、多个角色视角或明显可并行子任务时，主 agent 可以调用内部工具派发 subagent。

**G2：每个 subagent 有清晰边界。**

每个 child agent 只处理一个子任务，有自己的 prompt、role、权限、状态和最终结果。

**G3：用户能看见协作过程。**

Chat 中出现 subagent batch 状态卡，展示每个子任务的状态、标题、耗时、摘要和失败原因。

**G4：主 agent 负责最终综合。**

subagent 的结果不直接拼接给用户，而是作为结构化 tool result 交回主 agent，由主 agent统一校验、去重、补充和表达。

**G5：默认安全。**

MVP 默认只开放 read/search/RAG 类能力。涉及写文件、shell、浏览器自动化的 subagent 必须额外启用或经过审批。

### 2.2 非目标

- 不在 MVP 做独立进程 worker。
- 不在 MVP 让多个 subagent 同时改同一份代码。
- 不在 MVP 做跨 agent 长期记忆。
- 不在 MVP 做复杂多轮辩论或投票机制。
- 不把 subagent 暴露成用户可直接手动管理的 session。

---

## 3. 触发策略

### 3.1 显式触发

用户直接要求时必须触发：

```text
帮我分 N 个 subagent 回答以下问题
每个 subagent 回答一个问题
并行处理这些条目
让不同 agent 分别从规则、流程、风险角度分析
```

### 3.2 隐式触发

主 agent 可在以下场景主动触发：

| 场景 | 判断信号 | 示例 |
|---|---|---|
| 批量问答 | 问题列表 >= 4，彼此独立 | “回答这 31 个采购制度问题” |
| RAG 分散检索 | 每个问题需要查不同文档片段 | “分别查合同、报价、付款规则” |
| 多角色分析 | 用户要求多个视角 | “从产品、工程、运营角度看” |
| 大型代码审查 | 多个模块可独立读 | “审查 app/hooks、lib/collab、api 路由” |
| 调研对比 | 多个对象可并行研究 | “比较 8 个竞品” |

### 3.3 不应触发

| 场景 | 原因 |
|---|---|
| 子任务强依赖上一个结果 | 并行会制造错误 |
| 用户要求单一连贯创作 | 多 agent 语气和结构容易漂移 |
| 小任务 1-3 步可完成 | 委派开销大于收益 |
| 写文件且修改边界不清 | 容易产生冲突 |
| 需要连续交互式审批 | subagent 等待会打断主流程 |

---

## 4. 总体架构

### 4.1 MVP 架构

```text
Main AgentSession
  |
  | calls delegate_subagents(input)
  v
SubagentOrchestrator
  |
  | create child AgentSession x N
  v
Child AgentSession[]
  |
  | subscribe SDK events
  | collect final assistant answer
  v
SubagentResult[]
  |
  | returned as tool result
  v
Main AgentSession synthesizes final answer
```

### 4.2 模块划分

```text
lib/subagents/
  ├── types.ts              # 纯 JSON 协议类型
  ├── planner.ts            # 可选：规则式拆分/校验
  ├── orchestrator.ts       # 创建 child agent、并发运行、收集结果
  ├── server-store.ts       # batch/task 运行态 store
  ├── extension.ts          # delegate_subagents 内部工具
  └── events.ts             # custom SSE event 构造辅助

app/api/agent/[id]/subagents/route.ts
  GET                       # 查询 batch/task 状态，用于刷新恢复
  POST                      # abort / retry 单个 task

app/components/SubagentBatchCard.tsx
  # 渲染 checklist 状态卡
```

### 4.3 与现有模块关系

| 现有模块 | 关系 |
|---|---|
| `agent-registry` | 提供 agent 创建与事件推送；需要新增 child agent metadata |
| `collab` | child agent 复用工具审批规则 |
| `clarification` | MVP 默认不允许 child agent 主动追问；后续可开启 |
| `budget` | child batch 应有独立预算上限 |
| `chat-reducer` | 新增 `subagent_batch` part |
| `useAgentEvents` | 识别 `subagent_*` custom event |

---

## 5. 数据协议

### 5.1 SubagentTask

```ts
export type SubagentRole =
  | "general"
  | "rag"
  | "research"
  | "code-review"
  | "implementation";

export interface SubagentTask {
  id: string;
  title: string;
  prompt: string;
  role?: SubagentRole;
  cwd?: string;
  allowedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
}
```

### 5.2 DelegateSubagentsInput

```ts
export interface DelegateSubagentsInput {
  reason: string;
  tasks: SubagentTask[];
  concurrency?: number;
  synthesisInstructions?: string;
}
```

约束：

1. `tasks.length` 默认上限 8，显式批量问答可放宽到 32。
2. `concurrency` 默认 4。
3. `title` 必须短，适合 UI checklist 展示。
4. `prompt` 必须完整，不依赖主 agent 隐式上下文。
5. `implementation` role 默认禁用，除非用户显式允许。

### 5.3 SubagentResult

```ts
export interface SubagentResult {
  taskId: string;
  agentId: string;
  sessionFile?: string;
  status: "completed" | "failed" | "aborted" | "timeout";
  answer?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  usage?: {
    turns?: number;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}
```

### 5.4 SubagentBatch

```ts
export interface SubagentBatch {
  id: string;
  parentAgentId: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  reason: string;
  tasks: SubagentTaskRuntime[];
  createdAt: number;
  endedAt?: number;
}

export interface SubagentTaskRuntime extends SubagentTask {
  agentId?: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted" | "timeout";
  startedAt?: number;
  endedAt?: number;
  answerPreview?: string;
  error?: string;
}
```

---

## 6. 事件协议

所有事件都通过 parent agent 的 SSE ring buffer 推给前端。这样 UI 只需要监听当前主 agent，不需要为每个 child agent 建 SSE 连接。

```ts
export type SubagentEvent =
  | SubagentBatchStartEvent
  | SubagentTaskStartEvent
  | SubagentTaskUpdateEvent
  | SubagentTaskEndEvent
  | SubagentBatchEndEvent;

export interface SubagentBatchStartEvent {
  type: "subagent_batch_start";
  batch: SubagentBatch;
}

export interface SubagentTaskStartEvent {
  type: "subagent_task_start";
  batchId: string;
  taskId: string;
  agentId: string;
  title: string;
  role: SubagentRole;
  startedAt: number;
}

export interface SubagentTaskUpdateEvent {
  type: "subagent_task_update";
  batchId: string;
  taskId: string;
  answerPreview?: string;
}

export interface SubagentTaskEndEvent {
  type: "subagent_task_end";
  batchId: string;
  taskId: string;
  status: SubagentResult["status"];
  answerPreview?: string;
  error?: string;
  endedAt: number;
}

export interface SubagentBatchEndEvent {
  type: "subagent_batch_end";
  batchId: string;
  status: SubagentBatch["status"];
  results: SubagentResult[];
  endedAt: number;
}
```

### 6.1 为什么事件挂在 parent agent

如果前端同时监听 N 个 child agent SSE，会带来几个问题：

- ownerKey 难归属：child agent 不一定在 sidebar 中有可见 session。
- UI 容易被 child 的完整 message stream 淹没。
- 页面刷新恢复要重新发现所有 child agent。

MVP 只把 child 的状态摘要转发到 parent agent。child 的完整 session 仍保留在本地，可用于 debug，但默认不进入主聊天流。

---

## 7. 后端设计

### 7.1 Orchestrator 流程

```text
runSubagentBatch(parentAgentId, input)
  1. validate input
  2. create batch store record
  3. push subagent_batch_start
  4. 按 concurrency 创建 child AgentSession
  5. 为每个 child prompt(task.prompt)
  6. 监听 child message/tool/agent_end
  7. 提取最终 assistant answer
  8. push subagent_task_end
  9. 全部完成后 push subagent_batch_end
  10. return SubagentResult[] 给主 agent 工具调用
```

### 7.2 child AgentSession 创建策略

MVP 可以复用 `createAgent`，但需要增加 options：

```ts
export interface CreateOptions {
  provider: string;
  modelId: string;
  cwd: string;
  sessionPath?: string;
  thinkingLevel?: ThinkingLevel;
  parentAgentId?: string;
  childRole?: SubagentRole;
  hidden?: boolean;
}
```

`hidden: true` 表示 child agent 不作为 sidebar 主 session 展示，只作为 batch 子任务存在。session 文件仍然落盘。

### 7.3 child prompt 模板

每个 child agent 的 system/context 需要强约束：

```text
You are a subagent working on one delegated task.

Rules:
- Answer only the assigned task.
- Do not solve sibling tasks.
- Prefer concise, evidence-backed output.
- If information is missing, state what is missing instead of asking the user.
- Return a final answer with: conclusion, key evidence, caveats.

Task:
{task.prompt}
```

中文场景可使用中文模板：

```text
你是一个 subagent，只负责当前被委派的一个子任务。

规则：
- 只回答当前子任务，不要扩展到其他问题。
- 优先给出可核验依据。
- 信息不足时直接说明缺口，不要向用户追问。
- 最终输出包含：结论、依据、注意事项。

子任务：
{task.prompt}
```

### 7.4 结果提取

MVP 不需要读取完整 child chat tree，只需要监听最后一个 assistant `message_end`，提取 text parts 拼成 `answer`。

后续可以增强为：

- 抽取引用来源。
- 抽取 tool usage。
- 抽取 confidence。
- 抽取结构化 JSON。

---

## 8. 内部工具设计

### 8.1 delegate_subagents

给主 agent 增加一个内部工具：

```ts
delegate_subagents({
  reason: string,
  tasks: SubagentTask[],
  concurrency?: number,
  synthesisInstructions?: string
}) -> {
  batchId: string,
  results: SubagentResult[]
}
```

### 8.2 工具描述

工具描述要明确什么时候用、什么时候不用：

```text
Use this tool when the user's request contains multiple independent sub-tasks
that can be answered in parallel, especially batch Q&A, multi-document RAG,
multi-role analysis, or modular code review.

Do not use it for small tasks, tightly sequential tasks, or tasks where multiple
agents would edit the same files.
```

### 8.3 与 ask_user 的关系

`ask_user` 用于信息不足时让当前 agent 等用户选择。

`delegate_subagents` 用于信息足够但工作量可并行时派发子任务。

二者不要混用：

- 如果问题不清楚，先 `ask_user`。
- 如果问题清楚但很多，`delegate_subagents`。

---

## 9. 前端设计

### 9.1 MessagePart 扩展

在 `lib/types.ts` 的 `MessagePart` union 增加：

```ts
{
  kind: "subagent_batch";
  id: string;
  reason: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  tasks: Array<{
    id: string;
    title: string;
    role?: SubagentRole;
    status: "pending" | "running" | "completed" | "failed" | "aborted" | "timeout";
    agentId?: string;
    answerPreview?: string;
    error?: string;
    startedAt?: number;
    endedAt?: number;
  }>;
  createdAt: number;
  endedAt?: number;
}
```

### 9.2 Chat reducer

`lib/chat-reducer.ts` 新增处理：

| event | reducer 行为 |
|---|---|
| `subagent_batch_start` | `ensureAssistant` 后插入 `subagent_batch` part |
| `subagent_task_start` | 找到 batch，更新 task status 为 running |
| `subagent_task_update` | 更新 `answerPreview` |
| `subagent_task_end` | 更新 task status、preview、error、endedAt |
| `subagent_batch_end` | 更新 batch status、endedAt |

### 9.3 UI 卡片

新增 `SubagentBatchCard.tsx`，形态参考：

```text
Subagents
并行处理 5 个子任务

✓ general  Q1: 小额快速采买金额上限
✓ general  Q2: 集采和自采的区别
… rag      Q3: 供应商报价截止后可以延期吗
× research Q4: 合同纸质签要求

查看结果 / 重试失败项
```

MVP 功能：

- 展示状态。
- 展示 title、role、耗时。
- 展示失败原因。
- batch 完成后可展开 answerPreview。

暂不做：

- 点击进入 child session。
- 单 task 手动 retry。
- 拖拽调整任务。

---

## 10. 权限与安全

### 10.1 默认权限矩阵

| role | 默认工具 | 禁用工具 | 说明 |
|---|---|---|---|
| `general` | read/search | bash/write/edit/browser | 普通问答 |
| `rag` | read/search/grep | bash/write/edit/browser | 文档检索 |
| `research` | read/search/browser? | write/edit/destructive bash | 需要后续审批浏览器 |
| `code-review` | read/grep/find | write/edit/bash | 只读审查 |
| `implementation` | read/edit/bash | destructive bash | MVP 默认禁用 |

### 10.2 写操作策略

MVP 不允许 subagent 直接写文件。后续如需开放：

1. 每个 implementation subagent 在独立 git worktree 运行。
2. 产出 patch，不直接合并。
3. 主 agent 汇总 patch 并执行冲突检查。
4. 用户审批后才应用。

### 10.3 Budget 策略

新增 batch 级预算：

```ts
export interface SubagentBudget {
  maxTasks?: number;
  maxConcurrency?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
  maxTurnsPerTask?: number;
}
```

默认值：

| 项 | 默认 |
|---|---|
| maxTasks | 8 |
| maxConcurrency | 4 |
| maxDurationMs | 10 分钟 |
| maxTurnsPerTask | 6 |
| maxCostUsd | 继承 parent session budget 的剩余额度 |

---

## 11. 失败处理

### 11.1 单个 task 失败

单个 child agent 失败时：

- 标记 task `failed`。
- 保存 error。
- 继续等待其他 task。
- batch 最终仍返回 completed-with-failures 语义，交给主 agent 决定如何解释。

MVP 的 `SubagentBatch.status` 没有 `completed_with_failures`，可用：

- 全部失败：`failed`
- 至少一个成功：`completed`
- results 中保留单项失败状态

### 11.2 超时

每个 task 有 `timeoutMs`。超时后：

1. 调 child `session.abort()`。
2. task 标记 `timeout`。
3. 返回 error：`Subagent task timed out after X ms`。

### 11.3 用户 abort parent

用户 abort 主 agent 时，应同时 abort 当前 batch 下所有 running child agent。

需要在 `app/api/agent/[id]/route.ts` 的 `abort` case 中调用：

```ts
abortRunningSubagentBatches(parentAgentId)
```

---

## 12. 恢复与持久化

MVP 可以先只做进程内 store，与当前 approval/clarification 一致。

```ts
interface SubagentStore {
  batches: Map<string, SubagentBatch>;
  byParentAgentId: Map<string, Set<string>>;
}
```

刷新页面时：

```text
GET /api/agent/[id]/subagents
  -> 返回 parent agent 下仍存在的 batches
  -> useAgentEvents.restorePendingSubagentBatches
  -> reducer 恢复状态卡
```

后续 Phase D 可持久化到：

```text
~/.mini-pi/subagents/{batchId}.json
```

---

## 13. 实施计划

### Phase A: Subagent Orchestrator MVP

**Commit**

```text
feat(subagents): add in-process subagent orchestrator
```

**Files**

- Add: `lib/subagents/types.ts`
- Add: `lib/subagents/server-store.ts`
- Add: `lib/subagents/orchestrator.ts`
- Modify: `lib/agent-registry.ts`

**验收**

- 单元测试可创建 2-3 个 mock task 并得到 result。
- 支持 concurrency。
- task timeout 会 abort child session。
- parent abort 能取消 child batch。

### Phase B: delegate_subagents internal tool

**Commit**

```text
feat(subagents): expose delegate_subagents internal tool
```

**Files**

- Add: `lib/subagents/extension.ts`
- Modify: `lib/agent-registry.ts`

**验收**

- 主 agent 能通过 tool 调起 batch。
- tool result 返回结构化 `SubagentResult[]`。
- child prompt 包含明确边界约束。

### Phase C: SSE events and UI card

**Commit**

```text
feat(subagents): render subagent batch progress in chat
```

**Files**

- Add: `app/components/SubagentBatchCard.tsx`
- Modify: `lib/types.ts`
- Modify: `lib/chat-reducer.ts`
- Modify: `app/hooks/useAgentEvents.ts`
- Modify: `app/components/MessageView.tsx`

**验收**

- Chat 中出现 subagent checklist。
- 每个 task start/end 状态正确更新。
- batch 完成后卡片显示 completed。
- 页面刷新后可恢复未完成 batch。

### Phase D: Process Worker

**Commit**

```text
feat(subagents): run child agents in worker processes
```

**Files**

- Add: `lib/subagents/worker-parent.ts`
- Add: `lib/subagents/worker-child.ts`
- Add: `lib/subagents/ipc.ts`
- Modify: `lib/subagents/orchestrator.ts`

**验收**

- child process 崩溃不会导致 parent agent 崩溃。
- worker stdout/stderr 可追踪。
- 支持 maxConcurrency。
- 支持 abort。
- approval/clarification 事件可跨进程转发。

---

## 14. 测试计划

### 14.1 Unit Tests

- `lib/subagents/types` schema validation。
- Orchestrator concurrency。
- timeout abort。
- single task failure does not fail whole batch。
- reducer correctly applies `subagent_*` events。

### 14.2 Integration Tests

- 通过 mock tool 调用 `delegate_subagents`，确认 parent agent 收到 tool result。
- parent abort 后 child 全部 aborted。
- child 失败后 batch 仍返回其他成功结果。

### 14.3 E2E Tests

新增 Playwright 用例：

```text
e2e/07-subagents.spec.ts
```

覆盖：

- 用户输入批量问题。
- mock agent 触发 `subagent_batch_start`。
- UI 显示多个 subagent rows。
- rows 从 running 变 completed。
- 最终 assistant 综合回答出现。

---

## 15. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| 主 agent 过度委派 | 小任务变慢、成本升高 | 工具描述写清不用场景；默认 task/concurrency/cost 上限 |
| child 答案质量参差 | 主回答综合困难 | child prompt 固定结构；主 agent synthesisInstructions |
| UI 噪音过大 | chat 被状态卡淹没 | 只显示 batch 摘要，不显示 child 全量 stream |
| 写文件冲突 | 代码损坏 | MVP 禁止 child 写文件 |
| 进程内 child 占资源 | 长任务拖慢主进程 | Phase D 独立进程；MVP 严格 concurrency |
| 审批链路复杂 | child 工具调用等待用户 | MVP child 默认禁用危险工具 |

---

## 16. 与现有 RFC 的关系

| RFC | 关系 |
|---|---|
| RFC-1 ChatApp Split | 已拆出 hooks/reducer，是接 UI card 的前置基础 |
| RFC-2 Agent Collaboration | subagent 复用 approval/budget/extension 基础设施 |
| RFC-3 Session as Knowledge | child session 后续可成为可检索知识资产 |
| RFC-5 Clarification | 主 agent 信息不足时先 ask_user，信息足够但工作量大时 delegate_subagents |

---

## 17. 最小可交付版本

如果只做 2-3 天，建议交付这个最小版本：

1. `delegate_subagents` 工具接受 tasks。
2. Orchestrator 同进程创建 child agents。
3. 每个 child 只运行一轮 prompt。
4. 收集每个 child 最终 assistant text。
5. 返回 results 给主 agent。
6. 暂不做 UI 卡，只在主 agent 最终回答里体现结果。

这个版本已经能验证最核心假设：多 subagent 是否能提升批量问答和多视角分析质量。

下一步再补 UI 卡，让用户看到协作过程。


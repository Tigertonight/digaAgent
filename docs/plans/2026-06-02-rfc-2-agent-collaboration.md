# RFC-2：Agent 协作模式 v0

> **状态**：Draft
> **作者**：Seal（Codewiz 角色：产品经理 + 体验设计师）
> **日期**：2026-06-02
> **预读时间**：约 25 分钟
> **关联文档**：
> - [RFC-1：ChatApp.tsx 拆分方案](./2026-06-02-rfc-1-chatapp-split.md)（本 RFC 强依赖 RFC-1 的 `useChatStream` / `useAgentEvents` 切面）
> - [RFC-Index](./2026-06-02-rfc-index.md)

---

## TL;DR

mini-pi-web 当前是「**单向喊话式**」的 Agent UI：用户按 Enter → agent 自己跑到死 → 用户看完结果再说话。这种模式在「短任务、强信任」场景里没问题，但只要任务跑到 5 分钟以上、或 agent 决定做用户不想做的事，体验就**立刻崩盘**——用户唯一的选择是「干等」或「abort 重来」。

本 RFC 提出 **Agent 协作模式 v0**，把 agent 从「黑箱执行体」变成「可对话的搭档」，由三个特性组成：

| # | 特性 | 一句话价值 | v0 路线 |
|---|------|----------|--------|
| F1 | **会话级 Budget**（时长 / 步数 / 成本上限） | 长任务自动停在用户可接受的边界，而不是无声烧钱 | ✅ 纯前端 + lib，**立刻可做** |
| F2 | **工具审批与改写**（Tool Approval） | 危险/可疑工具调用前由用户决定 allow / modify / deny | ✅ **SDK 已支持**（需架构改造，引入 inline extension） |
| F3 | **意图预览**（Plan-Before-Act） | 多步任务先给计划再执行，用户可在执行前修正方向 | ⏸️ **延后** —— SDK 当前 phase 信息不足，需先观察 F2 真实使用，再定形态 |

**最大认知更新**：在写本 RFC 前的盘点里，我把 F2 标为「需 SDK 配合 ~5 人天」。但**重新精读 SDK 类型定义后发现 SDK 已具备完整支持**——`tool_call` 事件可以 `block / mutate input` 且 handler 是 `async` 的（参见附录 B）。当前不能做 F2 的真正原因是 **mini-pi-web 的架构里没有用 extension 机制**，而是直接 `session.subscribe()` 拿事件（订阅是 read-only）。所以 F2 的成本从「等 SDK 升级」变成「**改造一次架构，永久解锁**」。

**推荐执行顺序**：
1. **Phase A**（与 RFC-1 阶段 B 并行 / 之后）：F1 会话级 Budget MVP — 1.5 人天
2. **Phase B**（在 RFC-1 完成后）：F2 工具审批 — 4 人天（含 inline extension 架构改造）
3. **Phase C**（F2 上线 2 周后，看数据再决定）：F3 意图预览（如果做）

**为什么是「v0」**：本 RFC 只覆盖 mini-pi-web **自己掌握全部决策权**的协作模式（用户审批 / 设上限）。**v1 才会做的**：跨 session 协作、agent 主动求助、人机角色切换 —— 这些都需要 v0 跑过真实数据后才知道形态。**v0 的目标是让用户敢把 agent 放手跑超过 10 分钟。**

---

## 1. 现状诊断：用户为什么不敢放手

### 1.1 三种典型崩盘场景

我把过去一个月（自己 + 团队的）使用日志按"中途想干预但干预不了"分类，得出三类：

**场景 A：长任务跑飞了**
> 让 agent "把 lib/ 下所有文件拆模块"。15 分钟后回头看，发现它把测试也一起重构了（你不希望动测试），但已经 edit 了 8 个文件。**用户选项**：abort 重新写 prompt（白跑 15 分钟，且新 session 没有上下文）/ 让它跑完再手动 revert。

**场景 B：危险操作差点出事**
> agent 准备执行 `git reset --hard HEAD~10`。当前 UI 看到 tool call 时它已经在执行了，等用户反应过来 → 已经丢了 10 个 commit。**用户选项**：靠肌肉记忆 Ctrl+C，但前端的 abort 不一定能赶上 bash 已经 fork 出去的进程。

**场景 C：成本失控**
> 跑了个 deep research，没注意到模型选的是 opus。等 sidebar 红字提示「$12.40」时已经用完了一天 budget。**用户选项**：下次记得切模型。

> ⚠️ 这三种场景的共同根因**不是 bug**，是**协作契约缺失** —— 系统从不主动停下来让用户校准。

### 1.2 当前能阻断 agent 的唯一手段

只有一个：**点 abort 按钮**。它有四个问题：

| 问题 | 后果 |
|-----|------|
| 粒度太粗（全停） | 想说"测试别动，其他继续"做不到 |
| 时机太晚（看到坏事才点） | 危险 bash 已经在跑了 |
| 不可恢复（abort 后必须重 prompt） | 长任务里损失上下文 |
| 没有"软上限" | 不会自动停，全靠用户盯着 |

### 1.3 当前 SDK 提供了什么（重新盘点结论）

**这次 RFC 盘点的最大修正**：上一轮盘点报告说"SDK 不支持 approve/intercept tool calls"，**这是错的**。重新精读 `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:624-720` 后发现：

```ts
/**
 * Fired before a tool executes. Can block.
 *
 * `event.input` is mutable. Mutate it in place to patch tool arguments before execution.
 * Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation.
 */
export type ToolCallEvent = BashToolCallEvent | ReadToolCallEvent | ...;

export interface ToolCallEventResult {
  /** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
  block?: boolean;
  reason?: string;
}
```

并且 runner 的 `emitToolCall` 签名是 `Promise<ToolCallEventResult | undefined>`——**handler 可以是 async 的，agent 会 await 它的返回**。这就是"暂停等用户审批"的完整技术底座。

**为什么我们用不上**：mini-pi-web 当前通过 `session.subscribe()` 订阅事件（lib/agent-registry.ts:155），这是 **read-only 的事件流**，无法返回 block / mutate 结果。要拦截工具调用，必须改为**注入一个 inline extension**，通过 `pi.on("tool_call", handler)` 拿到可干预的事件。SDK 已经提供了入口：

```ts
// DefaultResourceLoaderOptions（dist/core/resource-loader.d.ts:63）
extensionFactories?: ExtensionFactory[];

// 以及独立的 inline factory loader（dist/core/extensions/loader.d.ts:15）
loadExtensionFromFactory(factory, cwd, eventBus, runtime, extensionPath?)
```

所以本 RFC 的 F2 不是"等 SDK 升级"，而是"**一次架构投入，永久解锁 SDK 的全部能力**"。这也是 F2 价值密度最高的原因——它顺便也为未来的 F3、自定义工具、自定义 system prompt 等开了大门。

### 1.4 SDK 还做不到什么（诚实标注）

为避免画饼，明确列出 v0 **不能**做、需要 SDK 后续支持才能做的事：

| 想做的事 | 当前 SDK 是否支持 | 说明 |
|---------|----------------|------|
| `tool_call` 前阻断 / 改写参数 | ✅ 支持 | 见 1.3 |
| 整个 turn 开始前阻断（"先看计划再开跑"） | ⚠️ 部分 | 有 `before_agent_start` 事件，但只能看到原始 prompt，看不到 agent 计划要做什么 |
| 暂停-继续（不 abort 也能让 agent 停下来） | ❌ 不支持 | 只有 `abort()`，且 abort 后必须重新 prompt |
| 看到 agent 「准备调用哪些工具」的预览 | ❌ 不支持 | 没有 tool planning phase，模型直接进入 tool_call |
| 跨 session 的全局 budget | ⚠️ 需自实现 | `getSessionStats()` 只看单 session，跨 session 需 mini-pi-web 自己聚合 |

→ **结论**：F1（Budget）和 F2（Approval）是 v0 完全可做的；F3（Plan）不行，延后。

---

## 2. 目标与非目标

### 2.1 目标

**G1**：让用户敢把 agent 放手跑超过 10 分钟而不必盯着屏幕。
- 验收信号：长会话（>15 turn）占比从 X% 提升到 Y%（待 RFC-3 上线后才有数据）。

**G2**：把"危险操作前的恐慌"从用户的工作流里移除。
- 验收信号：`git reset --hard` / `rm -rf` / `npx ... --force` 等高危 bash 至少先弹审批，**默认 deny**。

**G3**：成本可预期。
- 验收信号：会话首次跑超过用户预设上限时**自动停**并通知，而不是默默继续。

**G4**：不破坏现有"高信任快路径"的体验。
- 验收信号：开关全关时，新版 UX 与现在**完全一致**（zero-overhead opt-in）。

### 2.2 非目标

- ❌ **不做** agent 主动向用户求助的协议（agent 现在不会"我不确定，请你拿主意"）
- ❌ **不做** 多 agent 协作 / 角色切换（这是 v1+ 的事）
- ❌ **不做** 跨 session 的全局 budget（v0 只做单 session 内的）
- ❌ **不做** 工具审批的"组策略"（团队级规则、CI 集成等）
- ❌ **不重写** Agent SDK；所有改动必须通过 SDK 的现有公共 API

### 2.3 约束

- 必须能与 RFC-1 拆分后的架构无缝衔接（不能拖 RFC-1 后腿）
- 必须保持 mini-pi-web 「本地优先」「单机可跑」原则，不引入任何外部服务
- 必须在 web UI 和未来 Electron 桌面端都能工作（审批弹窗不能依赖 web-only 的 API）

---

## 3. 方案设计

### 3.1 总体架构变化

```
当前架构（read-only）:
  AgentSession ──subscribe──→ AgentRecord.events ring buffer ──SSE──→ 前端
                                                                     (只能看)

目标架构（双向可干预）:
  AgentSession ──subscribe──→ ring buffer ──SSE──→ 前端 (看 + 触发 budget)
       ▲
       │ 注入 inline ExtensionFactory
       │
  CollabExtension（mini-pi-web 自己写）
       ├─ on("tool_call") → 查询前端审批状态 → block? mutate? allow?
       ├─ on("turn_end")  → 累加 stats，触发 budget 检查
       └─ on("agent_end") → 释放等待中的审批 promise
```

**关键变更**：mini-pi-web 从「SDK 的消费者」升级为「SDK 的扩展开发者」。**这一次性的架构投入，是 v0 之后所有 agent 协作能力的基石**。

### 3.2 三个特性的数据模型

#### 3.2.1 会话级 Budget（F1）

**数据**（前端 + lib 侧，**不需要 SDK 改造**）：

```ts
// lib/budget/types.ts （新增）
export interface SessionBudget {
  /** 单 session 内最大花费（美元） */
  maxCostUsd?: number;
  /** 单 session 内最大 turn 数 */
  maxTurns?: number;
  /** 单 session 内最长时长（秒，从首次 prompt 算起） */
  maxDurationSec?: number;
  /** 触发上限时的动作：'pause'（弹窗询问继续/停止）| 'stop'（直接停） */
  action: "pause" | "stop";
}

export interface BudgetStatus {
  budget: SessionBudget;
  spent: { costUsd: number; turns: number; durationSec: number };
  remaining: { costUsd?: number; turns?: number; durationSec?: number };
  /** 已触发的上限种类（可能多个） */
  triggered: Array<"cost" | "turns" | "duration">;
}
```

**检查时机**：在 `turn_end` 事件里聚合（前端 `useAgentEvents` 里做，零 SDK 改动）。

**触发后行为**：
- `action: 'stop'` → 直接调 `POST /api/agent/[id]/abort`
- `action: 'pause'` → 调 abort + UI 弹窗「已用 X，要继续吗？」→ 用户点继续 → 重新 prompt 续跑

**默认值**（产品决策）：
| 上限项 | 默认 | 理由 |
|-------|-----|------|
| maxCostUsd | $5.00 | 一杯咖啡，符合"快任务" sense |
| maxTurns | 30 | 经验值，超过通常意味着 agent 陷入循环 |
| maxDurationSec | 600（10 分钟） | 用户离开屏幕的常见时长 |
| action | pause | 给用户选择，比直接停温柔 |

> 🎁 **彩蛋**：可以加个「狂奔模式」开关，全关 budget——这是核心用户 retention 钩子。

#### 3.2.2 工具审批（F2）

**数据**：

```ts
// lib/collab/types.ts （新增）
export type ApprovalDecision = "allow" | "modify" | "deny";

export interface ApprovalRequest {
  id: string;                     // = toolCallId
  agentId: string;
  toolName: string;
  toolDisplayName: string;        // 例 "bash"
  input: Record<string, unknown>; // mutable，传出去给 UI 编辑
  /** 触发原因（用于 UI 高亮） */
  reason: "rule" | "manual" | "first-time";
  /** 命中的规则名（如 "dangerous-bash"） */
  ruleId?: string;
  /** 默认推荐决策 */
  defaultDecision: ApprovalDecision;
  createdAt: number;
}

export interface ApprovalResponse {
  decision: ApprovalDecision;
  /** decision = 'modify' 时的新 input */
  modifiedInput?: Record<string, unknown>;
  /** decision = 'deny' 时给 agent 看的原因，让它知道为什么被拒 */
  denyReason?: string;
  /** 是否记住这个决策（针对相同模式自动应用） */
  remember?: "this-session" | "always";
}

/** 审批规则：决定哪些工具调用需要弹审批 */
export interface ApprovalRule {
  id: string;
  name: string;
  /** 用 JSONPath / 简单 matcher 描述匹配条件 */
  match: ToolCallMatcher;
  /** 命中后做什么 */
  on: "ask" | "auto-allow" | "auto-deny";
  /** auto-deny 时的解释 */
  denyReason?: string;
}

interface ToolCallMatcher {
  toolName?: string | string[];
  /** 例 `{ command: { contains: ["rm -rf", "reset --hard"] } }` */
  inputMatch?: Record<string, { contains?: string[]; regex?: string }>;
}
```

**内置规则**（开机即生效，可关）：

| 规则 ID | 匹配 | 默认动作 |
|--------|------|---------|
| `dangerous-bash-destructive` | `bash` + command contains `rm -rf` / `git reset --hard` / `:(){:\|:&};:` | **ask**（默认 deny） |
| `dangerous-bash-network` | `bash` + command contains `curl ... \| sh` / `wget ... \| bash` | **ask** |
| `dangerous-bash-credentials` | `bash` + command matches `aws ... delete` / `gcloud ... delete` | **ask** |
| `write-outside-cwd` | `write` / `edit` + path 不以 cwd 开头 | **ask** |
| `first-time-tool` | 该 session 内首次出现的工具 | **ask** |

**审批 UI**（chat 流内联，不弹模态框）：
```
┌──────────────────────────────────────────────────┐
│ ⚠️  agent 想运行 bash:                            │
│                                                  │
│   git reset --hard HEAD~10                       │
│                                                  │
│  匹配规则: dangerous-bash-destructive            │
│                                                  │
│  [ Allow ]  [ Edit & Allow ]  [ Deny ]           │
│  ☐ 本次 session 不再问                            │
└──────────────────────────────────────────────────┘
```

**关键体验细节**：
- 审批气泡**就长在 chat 流里**，不浮在上面 —— 这样审批和 agent 对话是一条时间线（用户回顾时能看清"我那时拒了什么"）
- agent 端会感受到「工具被拒」**带原因**，下次它会换策略，而不是无限重试
- `denyReason` 会作为 tool result 返回，content 是 `"Permission denied by user: <reason>"`，让 agent 自然 reflect

#### 3.2.3 意图预览（F3，**v0 不做**）

> ⏸️ **决策：F3 在 v0 中延后。**

理由：
1. SDK 没有 plan phase 事件，agent 直接发 tool_call。要做"先看计划"必须**自己构造**——通过修改 system prompt 让 agent 先输出 `<plan>...</plan>` 再调用工具，然后我们 parse。但这是**模型行为的强约束**，不同 model（Sonnet vs Opus vs Haiku）遵守程度差异极大，会变成产品的"看脸"特性。
2. 真正能做出可靠 plan-before-act 的产品（Cursor 的 Composer Plan、Cline 的 Plan/Act 模式），都是 model + framework 协同调优出来的，不是 mini-pi-web 这个体量能短期搞定的。
3. **F2 已经能解决 80% 的"我不想让它做 X"场景** —— 让我们先看 F2 上线后用户还痛不痛，再决定 F3 的形态。

非决策：F3 不是永远不做，是 v0.5 / v1 再回头看。

### 3.3 inline extension 的注入方式

这是 F2 的架构底座。当前 `lib/agent-registry.ts:113` 的 `createAgent` 是这样：

```ts
const { session } = await createAgentSession({
  cwd: opts.cwd,
  model,
  thinkingLevel: opts.thinkingLevel ?? "medium",
  sessionManager,
  authStorage: getAuth(),
  modelRegistry: mr,
});
```

改造后：

```ts
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createCollabExtension } from "./collab/extension";

// 在 module scope 维护"待审批请求"和"决策结果"
const pendingApprovals = new Map<string, ApprovalRequest>();
const decisionResolvers = new Map<string, (r: ApprovalResponse) => void>();

export async function createAgent(opts: CreateOptions) {
  // ...

  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    settingsManager: getSettingsManager(opts.cwd),
    extensionFactories: [
      createCollabExtension({
        // 注入回调，让 extension 在 tool_call 时把请求挂到上面两个 Map 里
        onApprovalNeeded: (req) => {
          pendingApprovals.set(req.id, req);
          // 同时通过 ring buffer 推一条 custom event 给前端
          pushCustomEvent(opts.id, { type: "approval_request", request: req });
          return new Promise<ApprovalResponse>((resolve) => {
            decisionResolvers.set(req.id, resolve);
          });
        },
      }),
    ],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    model,
    thinkingLevel: opts.thinkingLevel ?? "medium",
    sessionManager,
    authStorage: getAuth(),
    modelRegistry: mr,
    resourceLoader: loader,
  });

  // ...
}

/** 前端审批后调这个：POST /api/agent/[id]/approval { id, decision, ... } */
export function resolveApproval(approvalId: string, response: ApprovalResponse) {
  const r = decisionResolvers.get(approvalId);
  if (!r) throw new Error("approval not found or already resolved");
  decisionResolvers.delete(approvalId);
  pendingApprovals.delete(approvalId);
  r(response);
}
```

`createCollabExtension` 长这样：

```ts
// lib/collab/extension.ts
import type { ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";

export interface CollabExtensionOptions {
  onApprovalNeeded: (req: ApprovalRequest) => Promise<ApprovalResponse>;
  getRules: () => ApprovalRule[];
}

export function createCollabExtension(opts: CollabExtensionOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      const matched = matchRule(event, opts.getRules());
      if (matched?.on === "auto-allow") return; // 让 agent 直接执行
      if (matched?.on === "auto-deny") {
        return { block: true, reason: matched.denyReason ?? "denied by rule" };
      }

      // 走人工审批
      const req: ApprovalRequest = {
        id: event.toolCallId,
        agentId: pi.getSessionName() ?? "",
        toolName: event.toolName,
        toolDisplayName: event.toolName,
        input: event.input as Record<string, unknown>,
        reason: matched ? "rule" : "manual",
        ruleId: matched?.id,
        defaultDecision: "deny",
        createdAt: Date.now(),
      };

      const resp = await opts.onApprovalNeeded(req);

      if (resp.decision === "allow") return;
      if (resp.decision === "deny") {
        return { block: true, reason: resp.denyReason ?? "denied by user" };
      }
      if (resp.decision === "modify") {
        // mutate in place（SDK 文档要求）
        Object.keys(event.input).forEach((k) => delete (event.input as any)[k]);
        Object.assign(event.input, resp.modifiedInput ?? {});
        return;
      }
    });
  };
}
```

### 3.4 前端集成（与 RFC-1 的接入点）

RFC-1 拆出的两个 hook 是 F1/F2 的天然落点：

**`useAgentEvents`** —— 新增对 custom event `approval_request` 的处理：
- 把请求 push 到 `pendingApprovals` state
- chat reducer 同步把一条"approval message"注入消息流（带 `type: "approval"`，UI 渲染为审批气泡）

**`useChatStream`** —— 新增 budget tracking：
- 监听 `turn_end` → 调 `session.getSessionStats()` → 算 cost/turns/duration
- 命中上限 → 调 abort + 触发"已达上限"事件

**新增 hook `useApprovals(agentId)`**：
- 暴露 `{ pending: ApprovalRequest[], approve, modify, deny }`
- 内部封装 `POST /api/agent/[id]/approval`

**新增 hook `useBudget(agentId)`**：
- 暴露 `{ status: BudgetStatus, setBudget, override }`
- 内部封装从 localStorage 读 + 写

**新增 UI 组件**：
- `ApprovalBubble` —— 审批气泡（在 ChatTranscript 里识别 `type: "approval"` 渲染）
- `BudgetIndicator` —— 顶部进度条（cost / turns / duration 三段）
- `BudgetExceededModal` —— 命中上限的弹窗（仅 `action: 'pause'` 时显示）

### 3.5 API 变化

新增三个 API 路由：

```
POST /api/agent/[id]/approval
  body: { approvalId, decision, modifiedInput?, denyReason?, remember? }
  -> 200 { ok }

GET /api/agent/[id]/budget
  -> 200 { status: BudgetStatus }

PUT /api/agent/[id]/budget
  body: SessionBudget
  -> 200 { ok }
```

复用已有：
- `POST /api/agent/[id]/abort`（Budget action=stop 时用）
- `GET /api/agent/[id]/events`（推送 `approval_request` custom event）

---

## 4. 实施路径

按"独立可上、可灰度、出问题可单独 revert"切分。**强烈建议先做 RFC-1**，否则 F2 改造会变成往 4673 行巨石里再塞一坨。

### Phase A：会话级 Budget MVP（1.5 人天）

**前置条件**：建议 RFC-1 阶段 A 完成（有 `useChatStream` hook），但不强制。

| 任务 | 工时 | 验收 |
|------|-----|------|
| A1 | `lib/budget/types.ts` + 默认值 + localStorage 读写 helper | 0.3d | 类型可 import，默认 $5 / 30 turn / 10 min |
| A2 | `useBudget` hook + `BudgetIndicator` 组件 | 0.4d | 顶部出现 3 段进度条，会随 turn_end 更新 |
| A3 | 命中上限自动 abort + `BudgetExceededModal` | 0.4d | 跑一个长任务能在 10 分钟时自动停 |
| A4 | 设置页：让用户改默认 budget + 单 session override | 0.4d | 改完刷新还在；命中规则在沟通侧明确给出提示 |

**风险**：cost 计算依赖 `session.getSessionStats()`，需确认返回结构稳定（已确认 SDK 0.78 提供）。

**上线策略**：默认开 + 默认值宽松（30 turn / 10 min / $5），先让用户感受"自动停"的存在感而非"被打断"。

### Phase B：工具审批架构改造 + 内置规则（4 人天）

**前置条件**：RFC-1 阶段 B 完成（有 `useAgentEvents` + chat reducer 隔离），强烈推荐。

| 任务 | 工时 | 验收 |
|------|-----|------|
| B1 | 改造 `lib/agent-registry.ts:113` `createAgent` 引入 `DefaultResourceLoader` + `extensionFactories` 注入 | 0.5d | 现有测试全绿，没 inline extension 时行为不变 |
| B2 | 写 `lib/collab/extension.ts` + `matchRule` 规则引擎 + 单元测试 | 1.0d | 规则匹配的 8 个 case 全绿 |
| B3 | 内置 5 条规则（见 3.2.2 表格） + 暴露 `GET/PUT /api/settings/approval-rules` | 0.5d | 5 条规则默认开，可在设置页关 |
| B4 | `useApprovals` hook + `ApprovalBubble` 组件 + chat reducer 注入 approval message | 1.0d | 触发 `rm -rf /tmp/x` 能看到审批气泡 |
| B5 | `POST /api/agent/[id]/approval` 路由 + `resolveApproval` server 函数 | 0.3d | allow / deny / modify 三条路径手动测过 |
| B6 | 「本 session 不再问」记忆 + 跨刷新持久化（localStorage per-agentId） | 0.4d | 拒一次 + 勾不再问 → 下次同输入不弹 |
| B7 | E2E：跑 `bash "rm -rf /tmp/test"` 全链路 | 0.3d | UI 弹审批 → deny → agent 收到 "Permission denied"，自然 reflect 不重试 |

**风险**：
- ⚠️ **inline extension 的 hot-reload**：Next.js dev 模式会 reload module，`pendingApprovals` Map 重启 → 已悬挂的 promise 会孤儿。**缓解**：把 Map 也挂到 `globalThis.__miniPi`（与现有 agent registry 一样）。
- ⚠️ **审批超时**：用户离开屏幕 30 分钟回来，agent 还在等。**缓解**：approval 默认 5 分钟超时 → 视为 deny，给 agent 返回 "approval timeout"。

**上线策略**：默认**只开 1 条规则**（`dangerous-bash-destructive`），灰度 1 周观察误报率，再逐步开放其他 4 条。

### Phase C：F3 决策点（不实施，只评估）

F2 上线 2 周后，跑以下评估：
- F2 弹审批的频率：**用户希望弹 → 实际弹** 的覆盖率
- 用户日均拒绝次数 + 拒绝后 agent 是否能自然换策略
- 「本 session 不再问」点击率（如果 > 40%，说明规则过于敏感）

满足 _全部_ 以下条件才上 F3：
- F2 误报率 < 10%
- 用户拒绝后 agent 换策略成功率 > 70%
- 用户访谈中至少 3 人主动提"希望先看计划"

否则维持 F2-only。

### 时间合计

| Phase | 工时 | 必须先做 |
|-------|-----|---------|
| A | 1.5d | — |
| B | 4.0d | RFC-1 阶段 B |
| **总计** | **5.5d** | — |

按 1 人全职推进，约 **1.5 周** 完成 F1 + F2。

---

## 5. 风险与缓解

| # | 风险 | 概率 | 影响 | 缓解 |
|---|------|-----|-----|-----|
| R1 | inline extension 改造影响现有 agent 行为 | 中 | 高（炸所有 session） | B1 单独 PR，灰度 1 天回看；保留快速 revert |
| R2 | `tool_call` async handler 阻塞 agent 太久（用户半小时不回） | 高 | 中 | 审批 5 分钟超时 → 视为 deny |
| R3 | 内置规则误报多 / 用户嫌烦 | 高 | 中 | 默认只开 1 条最严的，灰度铺开 |
| R4 | Budget 计算依赖的 SDK API 变 | 低 | 中 | 锁版本 + 在 `lib/budget/` 内做一层适配 |
| R5 | 多 agent 并发时审批 Map 串号 | 低 | 高 | id 用 `agentId:toolCallId` 复合 key |
| R6 | extension 抛错导致 agent 卡死 | 中 | 高 | extension 内 try/catch，错误时默认 allow（不阻塞 agent） |
| R7 | 「本 session 不再问」误用变成"永远不问" | 中 | 中 | 持久化范围明确写 UI 上 + 给"清空记忆"按钮 |

---

## 6. 验收指标

### 6.1 工程指标（必须达成）

- [ ] 现有所有 E2E 测试通过
- [ ] `createAgent` 改造后，**关闭所有规则**时 agent 行为与改造前**完全一致**（用录屏 + 事件序列 diff 验证）
- [ ] 新增 5 条规则 100% 覆盖单元测试
- [ ] 审批超时 5 min 后能自动 release

### 6.2 体验指标（上线后 4 周观察）

- [ ] Budget 上限触发率：5%~30%（太低说明默认太宽，太高说明太严）
- [ ] 审批弹出后用户决策耗时 p50 < 8 秒
- [ ] 「allow」决策占比 > 60%（说明规则不是无脑误报）
- [ ] 用户使用 `agent` 跑长任务（> 10 min）的频率 +50% 以上
- [ ] 「abort 后立刻重新 prompt」的频率 -30% 以上

### 6.3 反指标（出现即回滚）

- [ ] 用户调研中超过 2 人主动抱怨"审批太烦"
- [ ] agent 异常退出率上升 > 1%
- [ ] 单审批响应耗时 p99 > 30 秒（说明系统性卡）

---

## 7. 备选方案与权衡

### 备选 A：用 polling 替代 inline extension

> agent 每个 tool_call 前，前端通过 polling 查询是否要 deny。

❌ 否决：需要 SDK 暴露 tool planning phase（当前没有），且 polling 对延迟敏感。

### 备选 B：把审批移到 bash executor 那一层

> 不动 SDK 架构，hook 一个自定义 bash executor，在执行前问。

❌ 否决：只能管 bash，管不了 edit/write/grep；规则系统就退化成"危险 bash 拦截"，价值大降。

### 备选 C：用 SDK 的 `customTools` 包一层 wrapper

> 用自定义 tool 替换内置 bash/edit/write/read，在 wrapper 里做审批。

⚠️ 技术可行但**强烈不推荐**：
- 失去 SDK 内置工具的所有细节优化（streaming、cancel、edit diff）
- 维护成本极高（SDK 升级要跟进所有内置工具）
- 与 inline extension 比无任何优势

### 备选 D：先做 F3（Plan）不做 F2（Approval）

> 让 agent 先列计划，用户调完再放它跑。

❌ 否决：（1）SDK 不支持 plan phase；（2）即便强约束 prompt 让 agent 输出 plan，模型遵守度不稳定；（3）F2 解决的是"危险瞬间"，F3 解决的是"方向修正"，前者更刚需。

---

## 8. 与 RFC-1 / RFC-3 的协同

### 8.1 RFC-1（必读 → 才能做 RFC-2 的 Phase B）

- F1 接入点：`useChatStream`（RFC-1 阶段 A1.4）
- F2 接入点：`useAgentEvents`（RFC-1 阶段 B2.1）+ chat reducer 注入 approval message（RFC-1 阶段 A1.3）
- 审批 UI：放进 `ChatTranscript` 组件（RFC-1 阶段 C3.1）

**如果不先做 RFC-1**：F2 的所有改动都得塞进 ChatApp.tsx 那 4673 行，会变成"在塌方山体上盖楼"。

### 8.2 RFC-3（Session as Knowledge）

- 审批历史会成为 session 知识的一部分（哪些工具被拒过 / 为什么）
- Budget 设置可以从历史 session 学习（"上次类似任务花了多少"）
- 审批规则未来可以从历史调用模式自动建议

→ 这些是 v1+ 才做的事，但 v0 的数据 schema 要为这些预留扩展位（已在 3.2 设计中考虑）。

---

## 附录 A：手动验收清单（QA 用）

### A.1 Budget

- [ ] 默认 budget 显示在顶部，3 段进度条颜色：绿 < 60% / 黄 60-90% / 红 > 90%
- [ ] 跑一个真实任务 30 turn，命中 turns 上限 → 出现弹窗，能选择"继续"或"停"
- [ ] action=stop 模式下，命中上限直接停，无弹窗
- [ ] 设置页改 budget 后，新 session 立即生效，旧 session 不变
- [ ] 关闭所有 budget（"狂奔模式"）后，进度条隐藏，无任何阻塞

### A.2 工具审批

- [ ] 触发 `bash "rm -rf /tmp/whatever"` → chat 流出现审批气泡
- [ ] 点 Allow → agent 立即执行，无延迟
- [ ] 点 Deny → agent 收到 deny reason，能在下一条 message 里 reflect
- [ ] 点 Edit & Allow → 弹编辑器，改完后 agent 执行的是改后的命令
- [ ] 勾「本 session 不再问」+ Allow → 再发一次相同命令，无审批直接执行
- [ ] 关闭浏览器再打开（同一 session）→ 「本 session 不再问」记忆还在
- [ ] 多个并发 session 各自的审批互不串号
- [ ] 5 分钟内不响应审批 → 自动 deny + 弹「审批超时」提示

### A.3 架构回归

- [ ] 关闭所有规则 + 关闭所有 budget → 新版与 RFC-1 之前的 master 行为完全一致
- [ ] inline extension 抛错（手动注入 throw）→ agent 继续工作，错误进 console
- [ ] 在 dev 模式下 hot-reload → 已悬挂审批不丢

---

## 附录 B：SDK 关键类型签名（盘点证据）

> 本附录用来佐证「F2 不需要等 SDK 升级」的判断。来源：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`。

```ts
// L624-630：tool_call 事件可阻断 + 可改 input
/**
 * Fired before a tool executes. Can block.
 *
 * `event.input` is mutable. Mutate it in place to patch tool arguments before execution.
 * Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation.
 */
export type ToolCallEvent = BashToolCallEvent | ReadToolCallEvent | EditToolCallEvent
                          | WriteToolCallEvent | GrepToolCallEvent | FindToolCallEvent
                          | LsToolCallEvent | CustomToolCallEvent;

// L716-720
export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}

// L811：handler 类型，注意可返回 Promise → 支持 async await user decision
on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;

// L781
export type ExtensionHandler<E, R = undefined> =
  (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
```

`resource-loader.d.ts:L63`：

```ts
export interface DefaultResourceLoaderOptions {
  // ...
  extensionFactories?: ExtensionFactory[];  // 注入入口
  // ...
}
```

`runner.d.ts`：

```ts
emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined>;
// agent loop 会 await 这个 promise → 实现"暂停等审批"
```

---

## 附录 C：示例 - 一个完整的审批流程时序

```
[t=0]    User 输入 "/run cleanup"
[t=0.1]  agent 开始 turn, 决定调 bash "rm -rf node_modules"
[t=0.2]  SDK emit tool_call event → CollabExtension handler 收到
[t=0.2]  handler 查规则 → 命中 dangerous-bash-destructive
[t=0.2]  pushCustomEvent(agentId, { type: "approval_request", request: req })
[t=0.2]  ring buffer 收到 → SSE 推给前端
[t=0.3]  前端 useAgentEvents 收到 → reducer 注入 approval message
[t=0.3]  ApprovalBubble 渲染在 chat 流里
[t=0.3]  agent loop 在 emitToolCall 的 await 上挂住
[t=5.0]  User 看到气泡, 改成 "rm -rf node_modules/.cache" + 点 Allow
[t=5.1]  前端 POST /api/agent/[id]/approval { decision: "modify", modifiedInput }
[t=5.1]  server 调 resolveApproval → resolver(resp) → handler 醒来
[t=5.1]  handler 把 modifiedInput mutate 到 event.input
[t=5.1]  handler return → agent loop 继续, bash 执行的是改后的命令
[t=5.5]  tool 完成, agent 返回 message "已清空 .cache"
```

整个流程**对 agent loop 完全透明**：它只是"调了个 bash，花了 5 秒"，不需要知道中间被 hook 了。

---

## 附录 D：术语表

- **inline extension**：通过 `extensionFactories` 选项注入的内联扩展，不需要打包成独立文件
- **approval bubble**：审批气泡，UI 概念，长在 chat 流里的审批组件
- **budget**：单 session 的资源上限（cost / turns / duration），到了就停或弹窗
- **collab mode**：本 RFC 提出的总称，指 F1+F2+(未来的)F3 的协作能力集合

---

> 📌 **审查须知**：
> - 本 RFC 强调"v0 完整可上"，不是"画大饼"。每个特性都有具体工时和验收。
> - 关键判断是 F2 不需要等 SDK，这把工作量从 5 天降到 4 天（多了架构改造、少了等 SDK 的不确定性）。
> - 如果只能做一个特性，**优先做 F2**（解决"我不敢放手"的 root cause）。Budget 是次优，意图预览延后。
> - 强依赖 RFC-1 阶段 B 完成，请勿跳序。

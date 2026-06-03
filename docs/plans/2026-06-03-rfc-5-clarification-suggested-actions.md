# RFC-5: Clarification & Suggested Actions

> 状态：Proposed
> 创建：2026-06-03
> 目标：让 Agent 在信息不足、风险较高或存在多条可行路径时，像 Claude Code 一样主动提出追问，并给出带推荐理由的选项。
> 范围：Agent 输出协议、SSE 自定义事件、Chat UI 追问卡片、Pet 联动状态、测试与恢复机制。

## 0. TL;DR

当前系统支持：

- 用户主动 `follow_up`：streaming 时把下一条 prompt 排队。
- 工具审批 `approval_request`：危险工具调用前让用户 Allow / Deny。
- Pet 展示 approval / budget / running / offline 等状态。

但当前系统不支持：

- Agent 主动提出澄清问题。
- Agent 给出多个下一步建议。
- Agent 标出推荐项和推荐理由。
- 用户点击建议后把选择回传给当前 agent turn。

本 RFC 建议新增一条 **Clarification & Suggested Actions** 能力链路：

```text
Agent 判断需要用户选择
  -> server 推 clarification_request SSE custom event
  -> chat reducer 注入 clarification part
  -> UI 渲染追问卡片（推荐项高亮）
  -> 用户点选 / 自定义输入
  -> POST /api/agent/[id]/clarification
  -> server 推 clarification_resolved
  -> agent 继续执行
```

设计原则：不要让 Pet 或 UI 假装有能力；只有 Agent 真发出 clarification 事件时才展示。

## 1. 产品行为

### 1.1 触发场景

Agent 可在以下场景主动追问：

| 场景 | 示例 | 是否推荐 |
|---|---|---|
| 信息缺失 | “你要改哪一个页面？” | 必做 |
| 存在多条实现路径 | “先做快速 patch，还是重构抽象？” | 必做 |
| 风险较高但不属于工具审批 | “删除缓存会影响当前索引，是否继续？” | 必做 |
| 范围过大 | “要先做 MVP 还是一次性做完整版本？” | 必做 |
| 用户目标矛盾 | “你要求保留原交互，但又要取消入口，应该以哪个为准？” | 必做 |
| 纯推荐下一步 | “下一步建议先补 e2e。” | 可选，避免噪音 |

### 1.2 UI 形态

追问卡片出现在 assistant message 中，和 `ApprovalBubble` 同级：

```text
┌─────────────────────────────────────────┐
│ 需要你确认下一步                         │
│ 目标有两种实现路径，我推荐先收口 MVP。     │
│                                         │
│ 推荐  先实现轻量状态栏                   │
│       更快闭环，不影响现有布局             │
│                                         │
│       直接重构整套导航                   │
│       长期更干净，但风险和工期更高         │
│                                         │
│ [自定义回复...] [发送]                    │
└─────────────────────────────────────────┘
```

### 1.3 用户操作

| 操作 | 结果 |
|---|---|
| 点击推荐项 | POST 用户选择，agent 继续执行 |
| 点击非推荐项 | POST 用户选择，agent 按该路径继续 |
| 输入自定义回复 | POST 自定义文本，agent 按用户补充继续 |
| 忽略 | agent 保持等待，不自动继续 |
| 停止任务 | 走现有 abort |

## 2. 事件协议

新增 `lib/clarification/types.ts`，保持纯 JSON、可序列化。

```ts
export interface ClarificationRequestEvent {
  type: "clarification_request";
  request: ClarificationRequest;
}

export interface ClarificationResolvedEvent {
  type: "clarification_resolved";
  id: string;
  selectedOptionId?: string;
  customText?: string;
  resolvedBy: "user" | "abort";
}

export interface ClarificationRequest {
  id: string;              // `${agentId}:${requestId}`
  agentId: string;
  requestId: string;       // server 内部等待队列 key
  title: string;           // “需要你确认下一步”
  question: string;        // 具体问题
  context?: string;        // 为什么需要问
  options: ClarificationOption[];
  recommendedOptionId?: string;
  createdAt: number;
}

export interface ClarificationOption {
  id: string;
  label: string;           // 短选项
  description?: string;    // 影响/取舍
  value: string;           // 回传给 agent 的自然语言指令
}

export interface ClarificationResponse {
  selectedOptionId?: string;
  customText?: string;
}
```

约束：

1. `options.length` 建议 2-4 个。
2. `recommendedOptionId` 必须属于 `options`。
3. `label` 不超过 24 中文字符。
4. `description` 不超过 80 中文字符。
5. `selectedOptionId` 和 `customText` 至少一个存在。

## 3. 后端设计

### 3.1 Clarification Store

新增 `lib/clarification/server-store.ts`，参考 `lib/collab/server-store.ts`：

- `registerPendingClarification(req, resolve)`
- `resolveClarification(id, response)`
- `listPendingClarifications(agentId)`
- `clearAgentClarifications(agentId)`

用途：

1. 保持 request pending 状态。
2. 页面刷新后可通过 HTTP snapshot 恢复 UI。
3. 用户点击选项后能唤醒等待中的 agent 流程。

### 3.2 API 路由

新增：

```text
GET  /api/agent/[id]/clarification
POST /api/agent/[id]/clarification
```

GET 返回：

```json
{
  "clarifications": []
}
```

POST body：

```json
{
  "requestId": "q1",
  "selectedOptionId": "mvp-first",
  "customText": ""
}
```

POST 行为：

1. 拼接 `clarificationId = ${agentId}:${requestId}`。
2. 调 `resolveClarification`。
3. resolver 成功后，server 推 `clarification_resolved` SSE event。
4. 返回 `{ ok: true }`。

### 3.3 Agent 触发方式

本项目目前没有 SDK 原生的 `clarification_request` 能力，因此分两阶段做。

#### Phase A：前端协议 + 手动注入测试

先完成事件协议、UI、恢复、Pet 联动和 e2e，用测试 route 或 mock event 验证端到端链路。

优点：不依赖 SDK 内核变更，先把产品承载层做稳。

#### Phase B：Agent 工具化触发

给 agent 增加一个内部工具或 extension：

```ts
ask_user({
  title,
  question,
  context,
  options,
  recommendedOptionId
})
```

工具 handler：

1. 生成 `ClarificationRequest`。
2. `registerPendingClarification`。
3. `pushExternalEvent(rec, { type: "clarification_request", request })`。
4. `await` 用户 response。
5. 把用户选择转成 tool result 返回给模型。

这样模型可以在不确定时主动调用 `ask_user`，并在拿到用户选择后继续当前任务。

## 4. 前端设计

### 4.1 MessagePart 扩展

在 `lib/types.ts` 的 `MessagePart` union 增加：

```ts
{
  kind: "clarification";
  id: string;
  requestId: string;
  title: string;
  question: string;
  context?: string;
  options: ClarificationOption[];
  recommendedOptionId?: string;
  status: "pending" | "resolved";
  selectedOptionId?: string;
  customText?: string;
  resolvedBy?: "user" | "abort";
  createdAt: number;
}
```

### 4.2 Chat Reducer

在 `lib/chat-reducer.ts` 支持：

- `clarification_request`
  - 找 active assistant。
  - 若无 active assistant，则 `ensureAssistant` 新建。
  - 防重复：同 `id` 已存在则 no-op。
  - push `kind: "clarification"` part。

- `clarification_resolved`
  - 从后往前找到对应 part。
  - `status` 改为 `resolved`。
  - 写入 `selectedOptionId/customText/resolvedBy`。

### 4.3 useAgentEvents

在 `app/hooks/useAgentEvents.ts` 增加两个 case：

```ts
case "clarification_request":
case "clarification_resolved":
  updateRunner(ownerKey, (s) => ({
    chatState: applyEvent(s.chatState, ev),
  }));
  return;
```

并增加：

```ts
restorePendingClarifications(requests, agentId, ownerKey)
```

### 4.4 useClarifications

新增 `app/hooks/useClarifications.ts`：

```ts
export interface UseClarificationsReturn {
  choose: (requestId: string, optionId: string) => Promise<void>;
  respond: (requestId: string, customText: string) => Promise<void>;
  loadPending: () => Promise<ClarificationRequest[]>;
}
```

职责类似 `useApprovals`：

- 只负责 POST / GET。
- 不做乐观更新。
- server 通过 SSE 回推 resolved，reducer 更新 UI。

### 4.5 ClarificationCard

新增 `app/components/ClarificationCard.tsx`。

设计要求：

1. 推荐项有明显但克制的 “推荐” 标记。
2. 每个选项显示 label + description。
3. pending 状态显示按钮。
4. resolved 状态显示用户已选择项，不再可点。
5. 支持自定义输入，不超过 500 字。

`MessageView.tsx` 增加 `p.kind === "clarification"` 分支。

## 5. Pet 联动

### 5.1 PetState 扩展

在 `PetSessionInfo` 增加：

```ts
pendingClarification: {
  count: number;
  title: string;
  question: string;
  recommendedLabel: string | null;
  createdAt: number;
} | null;
```

### 5.2 状态优先级

更新 Pet State Matrix：

```text
offline
error
approval
clarification
budget_blocked
budget_warning
...
```

`clarification` 高于 budget 的原因：它是当前任务继续执行的用户决策点。

### 5.3 Pet 文案

| 状态 | 主文案 | 副文案 | 用户操作 |
|---|---|---|---|
| `clarification` | 等待你确认 | 推荐：{recommendedLabel} | 点击回主窗口处理 |

单击 PetCard 时显示 “回主窗口确认下一步” banner。  
Pet 不直接渲染多选项，避免在小窗口里做复杂决策。

## 6. 恢复机制

当前审批已经有 `GET /api/agent/[id]/approval` 恢复 pending approval。Clarification 也应同构：

1. ChatApp mount / agentId 变化时调用 `loadPendingClarifications()`。
2. 返回非空则调用 `restorePendingClarifications()`。
3. reducer 用 `clarification_request` 复原 pending part。
4. Pet pusher 从 chat parts 派生 pending clarification。

这样刷新页面后，用户仍能看到等待确认的卡片和 Pet 状态。

## 7. 测试计划

### 7.1 单测

新增：

- `lib/clarification/server-store.test.ts`
- `lib/chat-reducer.test.ts` 增加 clarification request/resolved cases
- `app/pet/use-pet-state.test.ts` 增加 clarification 优先级

覆盖：

1. request 注入 clarification part。
2. 重复 request 不重复 push。
3. resolved 能更新旧 assistant message 中的 part。
4. 页面恢复时无 active assistant 也能生成 pending 卡片。
5. Pet `clarification` 高于 `budget_blocked`。

### 7.2 E2E

新增 `e2e/04-clarification.spec.ts`：

1. mock `/api/agent/*/clarification` GET 返回 pending request。
2. 刷新页面后出现 ClarificationCard。
3. 点击推荐项。
4. POST body 包含 `requestId` + `selectedOptionId`。
5. mock SSE resolved 后卡片变为已选择。

### 7.3 手动验证

1. Agent 触发追问，Chat UI 出现卡片。
2. Pet 显示 “等待你确认”。
3. 点击 Pet 回主窗口。
4. 用户选择推荐项后 agent 继续执行。
5. 刷新页面仍能恢复 pending clarification。

## 8. 分步 Commit 计划

### C1. 协议与 store

```text
feat(clarification): add request types and pending store
```

Files:

- Add `lib/clarification/types.ts`
- Add `lib/clarification/server-store.ts`
- Add `lib/clarification/server-store.test.ts`

### C2. API route

```text
feat(api): expose clarification resolve endpoint
```

Files:

- Add `app/api/agent/[id]/clarification/route.ts`
- Modify agent registry if needed to push resolved event

### C3. Chat reducer + event handling

```text
feat(chat): render clarification events in message stream
```

Files:

- Modify `lib/types.ts`
- Modify `lib/chat-reducer.ts`
- Modify `app/hooks/useAgentEvents.ts`
- Update reducer tests

### C4. Clarification UI

```text
feat(chat): add clarification card with recommended actions
```

Files:

- Add `app/components/ClarificationCard.tsx`
- Modify `app/components/MessageView.tsx`
- Add `app/hooks/useClarifications.ts`
- Modify `app/ChatApp.tsx`

### C5. Pending restore

```text
feat(chat): restore pending clarifications after refresh
```

Files:

- Modify `app/ChatApp.tsx`
- Add e2e restore test

### C6. Pet state

```text
feat(pet): surface clarification state
```

Files:

- Modify `lib/electron-bridge.ts`
- Modify `app/hooks/usePetPusher.ts`
- Modify `app/pet/use-pet-state.ts`
- Modify `app/pet/PetBubble.tsx`
- Modify `app/pet/PetCard.tsx`
- Modify `app/pet/PetMockPanel.tsx`
- Update Pet tests

### C7. Agent ask_user integration

```text
feat(agent): add ask_user clarification tool
```

Files:

- Modify `lib/agent-registry.ts`
- Add clarification tool / extension module
- Add integration fixtures or route-level tests

## 9. 风险与取舍

| 风险 | 影响 | 应对 |
|---|---|---|
| 模型过度追问 | 体验变慢 | system prompt 限制：只有阻塞继续执行时才 ask_user |
| 推荐项误导用户 | 信任下降 | 推荐项必须有 `description` 说明取舍 |
| 与 approval 混淆 | 用户不清楚是在授权还是选路径 | UI 文案明确区分：approval=工具授权，clarification=下一步选择 |
| 刷新后丢 pending | 任务卡住 | 必须实现 GET snapshot + restore |
| 小宠物承载复杂决策 | UI 拥挤 | Pet 只提示，复杂选择回主窗口 |

## 10. 非目标

- 不做多轮表单。
- 不做 option 编辑后再提交，用户可用自定义输入替代。
- 不让 Pet 直接展示多选按钮。
- 不自动替用户选择推荐项。
- 不把所有 assistant 结尾都变成建议；这不是“猜你想问”，而是“阻塞时请求确认”。

## 11. 验收标准

1. Agent 可以发出 `clarification_request` 并暂停等待。
2. Chat UI 能展示推荐项和其他选项。
3. 用户选择后 server 能 resolve，Agent 能继续。
4. 刷新页面后 pending clarification 可恢复。
5. Pet 能显示 `clarification` 状态并引导回主窗口。
6. 单测、类型检查、build、关键 e2e 通过。

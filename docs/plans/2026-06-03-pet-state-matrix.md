# Diga Pet State Matrix

> 日期：2026-06-03
> 状态：产品定义基线
> 关联文档：`docs/plans/2026-06-01-pet-interaction-design.md`

## 1. 产品定位

Diga Pet 不是装饰型桌宠，而是 coding copilot 的桌面状态代理。它保留“陪伴感”，但陪伴感来自对开发过程的及时反馈：任务进度、审批等待、预算风险、异常提醒、完成回执和快速回到主窗口。

**一句话定义**：Pet 是 Agent 工作流的低打扰前哨，负责把后台状态翻译成可见、可理解、可操作的桌面信号。

**产品原则**：

1. **状态真实**：每个视觉动作必须有明确触发字段，不能为了可爱而假装忙碌。
2. **低噪可控**：常态安静，只有用户需要知道或需要操作时才主动提示。
3. **动作可落地**：高优先级提示必须配套用户操作，例如重连、打开审批、调整预算、跳回主窗口。
4. **专业语气**：文案短、明确、任务导向，避免玩具化、卖萌化表达。
5. **主窗口兜底**：复杂操作回主窗口完成，Pet 只做快速入口和状态摘要。

## 2. 状态优先级

同一时间可能有多个信号，Pet 只展示一个主状态。优先级从高到低：

1. `offline`：SSE 连接丢失，无法确认 Agent 进度。
2. `error`：Agent 级错误或关键失败。
3. `approval`：等待用户授权工具调用。
4. `budget_blocked`：预算/轮次/时长达到硬上限，任务已暂停。
5. `budget_warning`：预算接近上限，但任务仍可继续。
6. `compacting`：上下文压缩中。
7. `retrying`：自动重试中。
8. `running`：正在执行工具。
9. `thinking`：等待模型或模型推理中。
10. `done`：刚从运行态完成，短暂回执。
11. `attention`：有未读新回复。
12. `complete`：已完成且用户已读，等待下一步。
13. `idle`：无活跃 Agent 或会话未启动。

当前实现已覆盖 `offline/error/running/thinking/done/attention/complete/idle`，并以 `retry`、`compacting` 覆盖一部分临时事件。`approval` 与 `budget_*` 是下一轮需要接入 PetState 的产品缺口。

## 3. Pet State Matrix

| 状态 | 触发条件 | 主文案 | 副文案 | 视觉动作 | 用户操作 | 当前数据源 |
|---|---|---|---|---|---|---|
| `idle` | 没有 session，或当前 session 无 `agentId` / 无历史回复 | 等待启动 | session 名称，可为空 | 低频呼吸，灰色状态点 | 点击打开主窗口 | `agentId`, `lastMessage` |
| `complete` | `streaming=false`，有 `lastMessage`，且 `read=true` | 已完成 | session 名称 | 低频呼吸，绿色状态点 | 点击打开卡片；双击回主窗口 | `streaming`, `lastMessage`, `read` |
| `attention` | `streaming=false`，有 `lastMessage`，且 `read=false` | 有新回复 | assistant 最新回复前 40 字 | 右上角蓝点脉动，保持克制 | 点击查看卡片；双击回主窗口并标记已读 | `lastMessage`, `read` |
| `done` | `streaming=true -> false` 的边沿，持续 2s | 已完成 | 共耗时 Xs | 绿色光晕扩散 + 轻微 pop 一次 | 无需操作；可点击查看结果 | `streaming`, `streamingStartedAt` |
| `thinking` | `agentPhase.kind=waiting_model` | 等待模型响应… | 已耗时 Xs | 靛蓝光晕脉动 | 点击查看当前 session | `agentPhase.kind`, `streamingStartedAt` |
| `thinking` | `agentPhase.kind=thinking` | 正在思考… | 已耗时 Xs | 靛蓝光晕脉动 | 点击查看当前 session | `agentPhase.kind`, `streamingStartedAt` |
| `running` | `agentPhase.kind=running_tools` 且单工具运行 | 正在读取文件 / 正在修改文件 / 正在执行命令 / 正在搜索 | 文件名、命令前缀或搜索词 | 紫色进度扫动 / 工作态光晕 | 点击展开卡片；运行中可暂停 | `agentPhase.tools`, `currentTool`, `currentToolTarget` |
| `running` | `agentPhase.kind=running_tools` 且多个工具并发 | 正在执行 N 个任务 | 第一个 tool 名 | 紫色进度扫动 / 工作态光晕 | 点击展开卡片；运行中可暂停 | `agentPhase.tools` |
| `retrying` | `retry != null` | 重试中 (X/Y) | 失败原因前 40 字 | 琥珀色短 toast；主 sprite 保持原工作态 | 点击回主窗口查看日志 | `retry.attempt`, `retry.maxAttempts`, `retry.errorMessage` |
| `compacting` | `compacting=true` | 正在压缩上下文… | 可为空 | 靛蓝短 toast；气泡可覆盖主状态 | 无需操作；点击查看上下文状态 | `compacting` |
| `approval` | 存在当前 session 的 pending approval | 等待授权 | 工具名 + 目标摘要 | 右上角小蓝点改为“待处理”强调；卡片顶部显示审批入口 | 点击打开审批气泡 / 回主窗口审批；可允许或拒绝 | 待接入：`pendingApprovalsCount`, `currentApproval` |
| `budget_warning` | 当前 session budget 使用率达到软阈值，例如 80% | 接近预算上限 | 剩余金额 / 剩余轮次 / 剩余时间 | 黄色状态点或短 toast，不打断运行态 | 点击打开预算设置或会话预算详情 | 待接入：`budgetStatus` |
| `budget_blocked` | Budget hard limit 命中，Agent 已暂停 | 已暂停：预算到达上限 | 命中的限制类型 | 红/琥珀强调，强制气泡 | 点击打开预算弹窗；调整后继续 | 待接入：`budgetStatus`, `budgetTrigger` |
| `error` | `error != null` | 出错了 | 错误前 40 字 | 红色光晕，卡片红色边框，强制高优先级气泡 | 点击回主窗口查看错误；必要时重试 | `error` |
| `offline` | `sseStatus=lost` | 连接已断开 | 距上次正常 Xs · 点击重连 | sprite 灰度降噪 + 右上角断连徽章 + 强制气泡 | 点击重连；右键回主窗口 | `sseStatus`, Pet 本地 lost timer |

## 4. 触发规则

### 4.1 主状态选择

Pet 默认展示 `focusedSessionId` 对应 session。如果该 session 不存在，则从所有 session 中选择最高优先级状态；优先级相同则选择最近发生变化的 session。

多 session 同时运行时，Pet 不轮播主状态，避免用户误解当前上下文。其他 session 只在卡片的会话列表中显示摘要。

### 4.2 气泡与 toast 分工

**气泡**展示当前主状态的人话翻译，适合持续状态：思考中、运行中、等待授权、连接断开、预算暂停。

**toast**展示事件边沿，适合短暂事件：重试开始/成功/失败、压缩完成、非致命工具失败、完成回执。

高优先级气泡不会自动消失，直到状态恢复或用户处理。普通气泡只在 hover、点击卡片前或短暂事件中出现。

### 4.3 文案规则

1. 主文案最长 24 个中文字符。
2. 副文案最长 40 个中文字符，超出截断。
3. 主文案使用任务动词，不使用拟人卖萌语气。
4. 错误和预算类文案必须说明下一步动作。
5. 同一事件不要同时用气泡和 toast 重复轰炸；高优先级用气泡，低优先级用 toast。

## 5. 用户操作矩阵

| 操作 | 可用状态 | 结果 |
|---|---|---|
| 单击 Pet | 全状态 | 打开/关闭 PetCard |
| 双击 Pet | 全状态 | 聚焦主窗口并切到当前 session |
| Hover Pet | 全状态 | 显示当前状态气泡 |
| 右键菜单 | 全状态 | 显示跳回主窗口、切 session、暂停、隐藏等操作 |
| 暂停 Agent | `thinking`, `running`, `retrying`, `compacting` | 调用 abort，任务停止 |
| 一键重连 | `offline` | 请求主窗口重新 attach SSE |
| 打开审批 | `approval` | 回主窗口定位到审批气泡 |
| 调整预算 | `budget_warning`, `budget_blocked` | 回主窗口打开预算设置或预算弹窗 |
| 快速回复 | `complete`, `attention`，且非 streaming | 从 PetCard 发送 prompt |

## 6. 下一轮实现缺口

1. **接入审批状态**：在 `PetSessionInfo` 增加 pending approval 摘要，让 Pet 可以把“等待授权”提升为主状态。
2. **接入预算状态**：把 Budget warning / blocked 从主窗口提示同步给 Pet，形成明确的桌面提醒。
3. **统一状态派生**：把 `retrying`、`compacting` 从文案覆盖提升为可测试的产品态，避免产品 Matrix 和代码状态口径分裂。
4. **补充 mock panel**：PetMockPanel 增加 approval、budget warning、budget blocked 三个演示态。
5. **补 e2e 场景**：覆盖 pending approval 触发 Pet attention、预算命中触发 Pet blocked、SSE lost 点击重连。

## 7. 验收标准

1. 每个 Pet 可见状态都能在 Matrix 中找到触发条件。
2. 每个高优先级状态都有明确用户操作。
3. Pet 文案不出现装饰性、卖萌式表达。
4. 状态优先级可用单测覆盖，避免新增事件破坏提醒顺序。
5. 视觉动作只表达状态，不额外添加无意义动画。

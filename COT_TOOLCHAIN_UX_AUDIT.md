# CoT / 工具链 / Goal·Workflow·SubAgent UI 审核报告

## 概述

本报告整合了 5 份针对 diga-agent 中"思维链 / 工具链 / Goal-Workflow-SubAgent UI"的独立审计输出，覆盖 thinking、toolchain、goal/plan/todo、workflow、subagent 五个 UI 模块。报告区分两类问题：

- **bug / 异常逻辑**：会导致渲染错误、信息丢失、安全风险或可访问性缺失的硬伤，必须修复。
- **可迭代优化点**：当前能跑通但 UX 与产品惯例（Codex / Claude / Cursor）有差距、信息架构可改进的方向。

每条 finding 含：严重度、`file:line`、问题一句话、证据短引用、修复建议。文末给出按优先级排序的迭代路线与可直接落地的中文文案模板。

## 范围与方法

**范围**：

- `app/components/MessageView.tsx`（Thinking、ProcessPartGroup、phase pill、聚合渲染）
- `app/components/ToolRender.tsx`（ToolFrame、各类 sub-renderer、StatusDot）
- `lib/narration/tool.ts`（工具调用自然语言摘要、`stripSecrets`）
- `lib/types.ts`（`MessagePart` schema）
- `lib/chat-reducer.ts`、`lib/progress/recovery.ts`、`lib/process-summary.ts`
- 输入侧：`app/components/Composer.tsx`、`useAgentEvents.ts`、`session-runner.ts`

**方法**：基于 5 份子审计（thinking / toolchain / goal-plan-todo / workflow / subagent）做去重与合并，按"展开收起规则 / 状态标识 / 自然语言渲染 / 信息结构与 UI 层级"四轴对齐，再交叉验证 file:line 证据。仅引用代码原文，不臆测未在审计中出现的实现细节。


## 严重问题 (High)

### H1. 流式 thinking 默认三层折叠，用户看不到思考过程
- **位置**：`app/components/MessageView.tsx:2386-2433`（`ThinkingBlock`）+ `:912-967`（`ProcessPartGroupRow` 默认 `useState(false)`）+ `:825-893`（`CollapsedPartProcessGroup`）
- **证据**：`ThinkingBlock` 的 `<details>` 不带 `open` 属性；`ProcessPartGroupRow` 的 `open` 默认 `false`。即便外层 `forceLive` 把组打开，仍需点 group row + 点 thinking 共 2 次才看到思考流。
- **修复**：`ThinkingBlock` 接受 `defaultOpen?: boolean`，调用方在 streaming 且 `endedAt` 未出现时传 `true`，`endedAt` 到达后自动收起；同时 `forceLive` 期间把当前 thinking 组的 `ProcessPartGroupRow` 也设为 `forceOpen`；当 group 仅含 1 个 thinking 时直出 `ThinkingBlock`，少一层。

### H2. Thinking 块本身缺"进行中"状态指示
- **位置**：`app/components/MessageView.tsx:2386-2433`
- **证据**：`<summary>` 仅一个静态 `<Lightbulb size={12}/>` + 文本"思考"，无 pulse、无 cursor、无 `aria-busy`。"思考中 vs 已完成"仅靠外部 phase pill（`:776`）和组级小蓝点（`:869-878`）区分；折叠后用户无法在 thinking 块本身分辨状态。
- **修复**：`endedAt === undefined` 时在 `<summary>` 末尾加 `<span className="animate-pulse">…</span>` 并设 `aria-busy="true"`，结束后切到固定 `Ns` 时长。

### H3. 空白 thinking 仍渲染空折叠按钮
- **位置**：`app/components/MessageView.tsx:2395`
- **证据**：`if (!text) return null;` 不处理纯空白；`chat-reducer.ts:225-231` 的 `appendToLastThinkingPart` 对纯空白 delta 不做裁剪。部分 provider 会发空 reasoning chunk，导致消息中多出空"思考"按钮。
- **修复**：改为 `if (!text || !text.trim()) return null;`；`appendToLastThinkingPart` 在 first-init 时跳过纯空白 delta。

### H4. `MessagePart.tool.status` 缺 cancelled / timeout / queued
- **位置**：`lib/types.ts:152-153`（`status: "running" | "done" | "error"`）；`lib/narration/tool.ts:122-125`；`app/components/ToolRender.tsx:80-91`（`StatusDot`）
- **证据**：仅三态。被 abort / agent stop / timeout 的工具只能塞进 `error`，与真实失败混淆；前置失败导致后续 tool 永挂在 `running`（参考 `lib/progress/recovery.ts` 兜底）。subagent / approval 已支持 `timeout`，工具不一致。
- **修复**：扩展为 `"queued" | "running" | "done" | "error" | "timeout" | "cancelled"`；`chat-reducer` 在 `tool_execution_aborted` / agent stop 时回填 `cancelled / timeout`；`narrateTool.phaseText` 增加"已超时：/已取消："；`StatusDot` 增加 amber/dim 两色；`process-summary.summarizeIssue` 把 cancelled 归为"未完成"而非"失败"。

### H5. 工具 args / result 详情未脱敏，`stripSecrets` 仅覆盖 4 关键字
- **位置**：`app/components/ToolRender.tsx:704-728`（`GenericTool` 直接 `<CodeBlock text={asString(tool.args)} />`）；`lib/narration/tool.ts:178`（`stripSecrets` 仅匹配 `cookie|token|secret|password`）
- **证据**：所有 sub-renderer 详情区原样输出 args / result；只有折叠头标题（`cleanCommandForDisplay` / `stripFlags`）走过 `stripSecrets`。`Authorization: Bearer …`、`x-api-key`、AWS `AKIA…`、OpenAI `sk-…`、JWT、PEM、URL `?token=` 等全部漏过。折叠头脱敏但展开后明文回归，是"信号假象"，比完全不脱敏更危险。
- **修复**：抽出 `lib/narration/redact.ts`，统一覆盖 Bearer / AWS / `sk-` / JWT / PEM / URL-query-token / `*api*key*` / `x-*-key`；所有 `CodeBlock` 入参前过滤；result 同样过滤；用 `<RedactedSpan>` 显式按钮揭示，而非默认明文。

### H6. phase 文案中英文混杂
- **位置**：`app/components/MessageView.tsx:768-776`（`Thinking…` / `Waiting for model…` / `Running X…`）vs `:1232-1244` 折叠组标题全中文（"正在读取 / 已读取 / 已整理思路"）；`Composer.tsx:13/922` 也是英文 "Thinking"
- **证据**：同一条消息上方 phase pill 英文，下方折叠组 / Tool 卡中文；`ToolFrame` 详情副标题直接打 raw `tool.status` 英文（`ToolRender.tsx:235-240`）。
- **修复**：建立 `lib/i18n/phase-label.ts` 统一字典（`thinking→思考中`、`waiting_model→等待模型回复`、`running_tools→执行 X…`）；`STATUS_LABELS` 覆盖 running/done/error/timeout/cancelled。

### H7. 移动端完全缺失 GoalBar，目标在手机上不可见也不可控
- **位置**：`app/mobile/MobileApp.tsx`（grep `GoalBar` / `goal\.objective` 均 0 命中；唯一相关代码是 `:2799-2800` 的 `case "goal": setInput("/goal ")`）
- **证据**：移动端无任何顶层 Goal UI；用户启动 goal 后无法看到 status/objective/turns，也无法 pause/resume/clear，只能再键入 `/goal` 命令读取错误反馈来探查当前 goal 文本。
- **修复**：`MobileApp.tsx` 在 sticky header 下方渲染移动版 `GoalBar` 摘要条（复用 `statusTone` 与同一份 `goal` props），操作按钮以 `MobileBottomSheet` 弹出 pause/resume/clear/timeline；最低限度做"objective truncate + status dot"一行点击展开。

### H8. `acceptanceCriteria` 数据已存在但 UI 完全不渲染——这是天然的 Plan/Todo 位
- **位置**：`lib/goal/types.ts:84-93,108`；对照 `app/components/GoalBar.tsx`、`app/components/GoalTimeline.tsx` 全文 grep `acceptanceCriteria` / `RubricEvaluation` / `rejectionNote` / `evaluation` 均在 `app/` 0 命中
- **证据**：类型层定义 `GoalAcceptanceCriterion { id, criterion, status: "pending"|"met"|"failed", verifiedAt?, evidence? }` 与 `acceptanceCriteria?: GoalAcceptanceCriterion[]`，`verifier.ts` 已经在写 `pending/met/failed`，前端却整段不消费；模型自我 complete 被 verifier 拒绝时（`GoalUpdateResult.rejectionNote` + `evaluation`，`lib/goal/types.ts:130-150`）用户也看不到原因。"目标驱动 + 验收"承诺只剩一个 24px chip。
- **修复**：在 `GoalTimeline` turns 区上方新增 Acceptance 区块，按 status 三态图标 + `met` 行删除线降权；空数组占位"该 goal 未定义验收标准"；扩展 `goal_timeline` API 或新增 `goal_acceptance` action，把 criteria + 最近一次 `evaluation` 一并下发；GoalBar 折叠态显示"已通过 m/n"摘要。

### H9. `workflow_run` 卡完全不展示 stage / parallel 结构
- **位置**：`app/components/MessageView.tsx:1574-1953`、`lib/types.ts:268-284`
- **证据**：`MessagePart.workflow_run` schema 字段仅 `objective/status/manifest/checkpoints/artifacts/logs/traceEvents?/error/warnings`，无 stages；`WorkflowRunCard` 渲染顺序 `header → rationale → manifest meta → Checkpoints/Artifacts grid → Worktrees → logs`，无任何 stage / parallel / synthesis 节点视觉。`WorkflowStage` / `WorkflowStep` / `strategy:"fan-out"|"verify"|"synthesize"` 仅存在于 `lib/workflows/types.ts:11-26`，前端注释直接写"实际子任务继续由 subagent_batch part 展示"（`lib/types.ts:265-266`）。
- **修复**：`WorkflowRunCard` 头部加 stage 进度条，从 `traceEvents` 中的 `workflow_stage_started/ended` / `workflow_parallel_*` 派生 `[{title,status,startedAt,endedAt,parallelCount}]`；或在 `subagent_batch` part 加 `parentWorkflowId`，由 `MessagesScrollArea` 折叠为子节点。

## 中等问题 (Medium)

### M1. 用户展开偏好不持久化（thinking + tool 通用）
- **位置**：`MessageView.tsx:851`（`manualOpen`）、`:922`（`ProcessPartGroupRow`）、`ToolRender.tsx:103`（`useState(defaultOpen)`）；全局未见 `localStorage` / `sessionStorage` 写入
- **证据**：三层展开状态全是组件局部 state；virtualization 重挂载、滚动出视口、刷新都会丢失。`forceLive` 期间 `if (!live) setManualOpen(...)`（`MessageView.tsx:870-877`）会反向锁住手动收起。
- **修复**：以 `tool.toolCallId` / `messageId+partIndex` 为 key 写 `sessionStorage` 或 Context store；历史消息（无 streaming）的 thinking 默认 `open=true`；`forceLive` 期间允许用户 override 一次。

### M2. Thinking 不区分 cancelled / aborted / failed
- **位置**：`lib/types.ts:116-126`（`MessagePart.thinking` 仅 `text/startedAt/endedAt`）；`chat-reducer.ts:393-401`（`sealLastThinkingIfOpen` 只盖 `endedAt`）
- **证据**：模型只有"未完成 / 完成"二元状态；abort / 网络断 / provider error 同样 seal `endedAt`，渲染端无法区分中断与正常完成。
- **修复**：`MessagePart.thinking` 加 `endedReason?: "ok" | "aborted" | "error"`；reducer 在 abort / error 路径写入；`ThinkingBlock` 用图标+文案分态（"思考已中断"灰色、"思考"默认）。

### M3. 工具卡缺 ARIA 状态语义
- **位置**：`app/components/ToolRender.tsx:139-238`
- **证据**：全文检索 `aria-busy|role="status"|aria-live` 在 ToolRender 0 命中。`StatusDot` 仅是色块。
- **修复**：`StatusDot` 包 `<span role="status" aria-live="polite">{statusLabel}</span>`（视觉 sr-only），running 时按钮 `aria-busy="true"`。

### M4. 错误工具不自动展开详情
- **位置**：`app/components/ToolRender.tsx:101-108`（`ToolFrame defaultOpen=false`）
- **证据**：所有 sub-renderer 默认折叠；错误也得手点。`ToolAggregateRow` 同理。
- **修复**：`defaultOpen = props.defaultOpen ?? (tool.status === "error" || tool.isError)`；当 `tool.truncation` 诊断为截断，强制露出 banner 一行预览。

### M5. 折叠头错误标题硬截 24 字，丢失关键参数
- **位置**：`lib/process-summary.ts:148-155`
- **证据**：`if (rawLabel.length > 24) rawLabel.slice(0, 23) + "…"`；长路径 / 长命令的失败对象在折叠态被截。
- **修复**：拆"动词 + 目标"两段，目标段独立 `shortPath` / `shorten(64)`；`title={fullLabel}` 提供 hover tooltip。

### M6. `stripSecrets` regex 不覆盖 header / env 形态
- **位置**：`lib/narration/tool.ts:178`
- **证据**：仅匹配 `--xxx VAL` 与 `xxx=VAL`，不处理 `Authorization: Bearer …`、`-H "x-api-key: …"`、`export FOO=…`。
- **修复**：扩展 regex；在 `lib/narration/tool.test.ts` 补 Bearer / AWS / `sk-` 用例固化。

### M7. 同一 turn 多段 thinking 间无视觉分隔 / 序号
- **位置**：`MessageView.tsx:435-444`（`renderPart` 平铺 `<ThinkingBlock>`）
- **证据**：Claude reasoning interleaved with tool 时连出多个相同 lightbulb 的 `<details>思考</details>`，无法区分第几段。
- **修复**：聚合为"思考 ①/②"序号，或在两段间加 0.5px 分隔线 + 段间距；当数量 ≥ 2 时显示总段数 badge。

### M8. 折叠组与块内 thinking 文案不一致
- **位置**：`MessageView.tsx:1236`（"已整理思路 / 正在整理思路"）vs `:2415`（"思考"）
- **证据**：同一对象在不同层级使用两套词汇，用户阅读路径上有语义跳跃。
- **修复**：统一为"思考"或"整理思路"二选一；推荐"思考"（更短、不暗示完成）。

### M9. `GoalBar` 嵌入在 Composer，长对话中目标随滚动离开视口
- **位置**：`app/components/Composer.tsx:529-538`、`app/components/GoalBar.tsx:55-58`
- **证据**：`GoalBar` 自身用普通 `<div className="mb-2">`，无 sticky/fixed；`Composer` 把它放在 `mx-auto w-full max-w-[820px]` 容器里，仅在输入区上方。用户向上滚动看历史时 goal 完全离开视口；`paused` 想确认目标得先滚回底部。`role="status"`（`GoalBar.tsx:62`）只对屏幕阅读器有效。
- **修复**：在 `MessagesScrollArea` 上方放独立 sticky-top GoalBar 摘要条（仅 `StatusIcon + chip + objective truncate + turns`），点击展开走 `GoalTimeline`；保留 Composer 内完整 bar 作为 pause/resume/clear 操作位。或滚动 > N px 时弹出 auto-hide mini chip。

### M10. `traceEvents` 字段定义但前端从不渲染
- **位置**：`lib/types.ts:281`（`traceEvents?: WorkflowTraceEvent[]`）；`app/components/MessageView.tsx` 全文 grep `traceEvents` 0 命中
- **证据**：`MessagePart.workflow_run` 携带 `traceEvents` 但 `WorkflowRunCard` 只读 `part.logs.slice(-5)`；harness 实际产生的执行轨迹（spawnAgent / parallel / requireSuccess / mcp）被序列化但完全藏起，失败排错时用户只能看到最后 5 条 log + 一个粗 `error` 字符串。
- **修复**：在 "Details" `<details>` 折叠里加 timeline，按时间渲染 trace events，按 `kind` 上色（spawn/parallel/checkpoint/artifact/error）；或单独加 "Run timeline" tab。

### M11. checkpoint / artifact 仅 `slice(-4)` 渲染，Resume 无法选目标 checkpoint
- **位置**：`app/components/MessageView.tsx:1773-1788, 1797-1817, 1607`
- **证据**：`part.checkpoints.slice(-4).map(...)` 与 `part.artifacts.slice(-4).map(...)` 让超过 4 条的早期记录在 UI 直接消失，无 "Show all (N)" 入口，无计数提示；长链路 workflow 常产 10+ checkpoint。`canResume` 仅看 `checkpoints.length > 0`（行 1607），点 Resume 时不让用户选 checkpoint，只能恢复 latest——而 Resume 又恰恰依赖 checkpoint 的可视性。
- **修复**：列表头加 `Checkpoints (N)` / `Artifacts (N)` 计数；超 4 时用 `<details>` "Show all"；Resume 改 split button：主 action `Resume from latest`，次菜单列出全部 checkpoint name + createdAt 让用户选。

### M12. workflow artifact 完全忽略 `kind` 与 `preview`，所有产物用 `shortJson` 同样展示
- **位置**：`lib/workflows/types.ts:91-105`（定义 `kind:"result"|"schema_output"|"worktree"|"diff"|"verification"|"debug"`、`preview?:string`）；`app/components/MessageView.tsx:1815`（`shortJson(artifact.value)`）；`app/components/MessageView.tsx` 全文 grep `artifact.preview` / `artifact.kind` 0 命中
- **证据**：所有 artifact 一律 `shortJson` 截到 900 字符塞 `<pre>`，无图标、无 kind 标签、无下载、无"在文件浏览器里打开"。`diff` 类型应走代码 diff 渲染、`verification` 应有 pass/fail 视觉、长 markdown `result` 被砍到 900 字——这是 successCriteria 反复报警的同一份产物。
- **修复**：用 `artifact.kind` 派生图标 + 渲染器：`diff → DiffView`、`schema_output → JsonView`、`result/string → MarkdownView`（带 expand-to-modal 与导出）、`worktree → 链接 worktree 区块`、`verification → 通过/失败徽标`；优先展示 `artifact.preview`，点开才载入 `value`。

### M13. `successCriteria` 警告全是英文且不与 artifact 列表联动
- **位置**：`lib/workflows/script-runtime.ts:328-340,357`、`app/components/MessageView.tsx:1738-1755`
- **证据**：服务端写死英文 `required artifact "X" is missing` / `... is empty` / `only N non-empty artifact(s); expected at least M` / `report artifact "X" is N chars …`，UI 原样展示；同一个被点名 missing/empty 的 artifact 在下方列表里没有错误高亮，用户得在两段文本间手动对照。
- **修复**：把 successCriteria 警告中文化并结构化（`{code, artifactName, expected, actual}`），UI 渲染时对应 artifact 行加 `aria-invalid` + 红边高亮，做"警告 ↔ 产物"可视联动；与 `lib/i18n/phase-label.ts` 同体系。

## 轻微 / 信息 (Low / Info)

### L1. 历史 thinking 永远不显示时长
- **位置**：`MessageView.tsx:2398-2402`；`chat-reducer.ts:246-247` / `:1762-1763` 反序列化时不带 `startedAt/endedAt`
- **证据**：`duration` 计算依赖两端时间戳，历史会话恢复后只显示"思考"二字，与当前 turn 的"思考 Ns"不一致。
- **修复**：反序列化路径补 `durationMs`（若 SDK 提供）；或在历史 thinking 上不显示 `Ns`，只在当前 turn 显示，避免视觉跳。

### L2. abort 后 phase 残留 `Thinking…`
- **位置**：`useAgentEvents.ts:199-200` 设 `phase=thinking`；`session-runner.ts` 上无 thinking 专用清理
- **证据**：phase 仅在收到 `text_delta` / `tool_execution_start` / `message_end` 时被覆盖；极端时序下 abort 后 phase 仍为 thinking，pill 闪烁但下方无内容。
- **修复**：`runner.cancelTurn` / `cancelTurnOnDisconnect` 显式置 phase=null。

### L3. `extractPlainText` 跳过 thinking（产品决策）
- **位置**：`MessageView.tsx:1429-1431`
- **证据**：`else if (p.kind === "thinking") { /* 不复制 thinking 内容 */ }`
- **建议**：保留默认行为，但额外提供"复制思考"按钮，因为 `<Markdown>` 渲染后用户无法选中带格式版本。

### L4. "执行失败：" 前缀双重叠加 / 文案漂移
- **位置**：`lib/narration/tool.ts:124`（`phaseText error→"执行失败："`）
- **证据**：与折叠头标题、详情副标题之间存在重复前缀风险；审计输入截断处提示存在"双重叠加"现象。
- **修复**：phaseText 与折叠头使用同一 `STATUS_LABELS`，避免上下文叠加。

### L5. Goal 状态 chip 直出大写英文 `goal.status`
- **位置**：`app/components/GoalBar.tsx:78-86`
- **证据**：chip 直接渲染 `{goal.status}`（`running/paused/blocked/complete`），与同 bar 内中文 tooltip / 错误提示混杂；`paused` / `complete` 状态完全不读 `pauseReason` / `completedAt`（`lib/goal/types.ts:96-104`）。
- **修复**：抽 `statusLabel(goal)` 工具函数返回 `{text, subText}`，chip 用中文短词，副文案接 objective 后；`complete` 时整条 bar 视觉降权（背景对比度降低、chip 走 success-bg）。

### L6. `blockedState.category` 直出英译大写词，与中文环境冲突
- **位置**：`app/components/GoalBar.tsx:135-141`、`lib/goal/types.ts:55-62`
- **证据**：`category.replace(/_/g, " ")` 直出 `NEEDS USER` / `TOOL ERROR` 等大写词；`category` 类型为 `GoalBlockedCategory = "needs_user" | "needs_approval" | "tool_error" | …`，未经 i18n 字典。
- **修复**：在 `lib/goal/types.ts` 旁新增 `GOAL_BLOCKED_CATEGORY_LABEL: Record<GoalBlockedCategory, string>`（`needs_user → 等待用户输入` 等），UI 用映射；与全局 `lib/i18n/phase-label.ts` 同体系。

### L7. `GoalTimeline` 全表面英文 + 时间格式漂移
- **位置**：`app/components/GoalTimeline.tsx:121-149,155-165,212-220`
- **证据**：`Loading timeline…` / `No turns or evidence recorded yet.` / `Turns (n)` / `Evidence (n)` / `blocked: …` 全英文；`formatTime → new Date(ms).toLocaleTimeString()` 仅时分秒，跨日 turn 无法区分。
- **修复**：所有用户文案走 `lib/i18n/phase-label.ts` 字典；`formatTime` 改用 `lib/format` 的相对时间或带日期格式。

## 各模块状态总览

### A. Thinking / CoT 块

| 维度 | 现状 | 主要问题 |
| --- | --- | --- |
| 展开/收起 | 三层嵌套折叠（外组 → group row → ThinkingBlock），均默认折叠 | H1（流式默认看不到）、M1（偏好不持久化） |
| 状态指示 | 仅外部 phase pill + 组级小蓝点；块内无 pulse / `aria-busy` | H2（块内无指示）、M2（无 cancelled / aborted）、L2（abort 后 phase 残留） |
| 自然语言 | summary "思考" + 可选 "Ns"；折叠组标题"已整理思路"/"正在整理思路" | M8（词汇不一致）、L1（历史无时长） |
| UI 层级 | 同 turn 多段 thinking 平铺，无序号 | H3（空白仍渲染）、M7（无视觉分隔） |

### B. 工具调用链

| 维度 | 现状 | 主要问题 |
| --- | --- | --- |
| 展开/收起 | `ToolFrame defaultOpen=false`，错误也默认折叠 | M4（错误不自动展开）、M1（偏好不持久化） |
| 状态指示 | `StatusDot` 仅 running/error 染色；详情副标题打 raw `tool.status` 英文 | H4（status 仅三态）、H6（中英混杂）、M3（无 ARIA） |
| 自然语言 | `narrateTool.phaseText` 三态映射；折叠头走 `cleanCommandForDisplay` + `stripSecrets` | H5（详情未脱敏）、M5（标题硬截 24 字）、M6（regex 覆盖窄）、L4（前缀叠加） |
| UI 层级 | 各 sub-renderer（Read/Edit/Write/Bash/Grep/Find/Ls/Generic）共享 `ToolFrame` | 详情头副标题缺 i18n |

### C. Goal / Plan / Todo

审计范围：`app/components/GoalBar.tsx`、`app/components/GoalTimeline.tsx`、`app/components/Composer.tsx`（嵌入位）、`app/ChatApp.tsx`（接线）、`lib/goal/types.ts`（数据模型）、`app/mobile/MobileApp.tsx`（移动端核验）。注意：产品并无独立 Plan / Todo 组件，所谓 "Plan" 的 source of truth 是 `GoalAcceptanceCriterion[]`，但前端 0 处消费。

- **展开/收起**：`GoalBar` 整体非折叠组件，`GoalTimeline` 是另一条独立入口；不存在"展开看 plan"路径——因为根本无 Plan 视图。空 plan 占位文案、已完成项视觉降权这组关注点全部落空（详见 C-F2）。
- **状态标识**：`statusTone` 仅对 `running/blocked/paused/complete` 着色（`GoalBar.tsx:78-86`），但只有 `blocked` 分支真正读 `blockedState`；`paused` / `complete` 的 `pauseReason` / `blockedReason` / `completedAt` 在类型层存在却 0 处渲染（`lib/goal/types.ts:96-104`），用户暂停后看不到原因，完成后无总结（C-F1）。
- **自然语言**：chip 直出 `goal.status` 大写英文（`running/paused/complete`），与 GoalBar 内中文 tooltip / 错误提示混杂；`blockedState.category` 直接 `replace(/_/g, " ")` 输出 `NEEDS USER`、`TOOL ERROR` 等英译大写词（`GoalBar.tsx:135-141`），未经 i18n 字典；`GoalTimeline` 的 `Loading timeline…` / `No turns or evidence recorded yet.` / `Turns (n)` / `Evidence (n)` / `blocked: …` 均为英文（`GoalTimeline.tsx:121-165`），且 `formatTime` 仅 `toLocaleTimeString()` 不带日期，跨日 turn 无法区分（C-F6）。
- **信息结构**：`GoalBar` 嵌入在 `Composer.tsx:529-538`，仅在输入区上方，长对话向上滚动时 goal 离开视口（C-F3）；移动端 `MobileApp.tsx` 全文 grep `GoalBar` / `goal.objective` 0 命中，唯一交互是 `setInput("/goal ")`（行 2799-2800），手机用户无法看见 status / objective / turns、无法 pause/resume/clear（C-F4）；`acceptanceCriteria` 与 `RubricEvaluation` / `rejectionNote` 全部不进 UI，"目标驱动 + 验收"承诺只剩一个 24px chip（C-F2）。
- **建议**：
  1. `GoalBar.tsx:78-86` 抽 `statusLabel(goal)` 工具函数，返回 `{text, subText}`，把 `pauseReason` / `blockedReason` / `completedAt-createdAt` 时长接到 objective 后；`complete` 时整条 bar 视觉降权（背景对比度降低、chip 走 success-bg），与"已完成项降权"原则对齐。
  2. `GoalTimeline.tsx:121-149` 在 turns 区上方新增 Acceptance 区块：每条 criterion 一行，`pending/met/failed` 三态图标染色，`met` 行 `text-decoration: line-through; opacity: 0.6`；空数组时占位"该 goal 未定义验收标准"。同步扩展 `goal_timeline` API（或新增 `goal_acceptance` action），把 criteria + 最近 `evaluation` 一并下发，`GoalBar` 折叠态显示"已通过 m/n"摘要。
  3. 在 `MessagesScrollArea` 上方放一个 sticky 的 GoalBar 摘要条（`StatusIcon + chip + objective truncate + turns`），点击展开走 `GoalTimeline`；保留 `Composer.tsx:529-538` 的完整 bar 作为操作位（pause/resume/clear）。
  4. `MobileApp.tsx` sticky header 下渲染移动版 GoalBar 摘要条，复用 `statusTone` 与同一份 props，操作走 `MobileBottomSheet`。
  5. 在 `lib/goal/types.ts` 旁新增 `GOAL_BLOCKED_CATEGORY_LABEL: Record<GoalBlockedCategory, string>`（`needs_user → 等待用户输入` 等），`GoalBar.tsx:135-141` 通过映射输出，与全局 `lib/i18n/phase-label.ts` 同体系。`GoalTimeline.tsx` 全文走字典，`formatTime` 改用 `lib/format` 的相对时间。

### D. Workflow 调用 UI

审计范围：`lib/types.ts:268-284`（`MessagePart.kind="workflow_run"` schema）、`lib/workflows/types.ts:91-170`（`WorkflowArtifact` / `WorkflowSuccessCriteria` / `WorkflowRunStatus`）、`lib/workflows/script-runtime.ts:316-360,2436-2510`（successCriteria 文案 / 终态决策）、`app/components/MessageView.tsx:1574-1953`（`WorkflowRunCard`）、`app/components/MessageView.tsx:1473-1480`（`shortJson` 900 字截断）、`app/components/MessageView.tsx:1974-2173`（`SubagentBatchCard`，stage / 并行实际承载位置）。

- **展开/收起**：`WorkflowRunCard` 主体直出 manifest meta + Checkpoints/Artifacts grid + Worktrees + logs，没有 stage 折叠层；checkpoint / artifact 仅 `slice(-4)` 渲染（`MessageView.tsx:1773-1788, 1797-1817`），超过 4 条早期记录直接消失，没有"Show all (N)"入口；`<details>` 折叠的"Details"区也不承载 `traceEvents`（D-F2、D-F3）。
- **状态标识**：顶部有 `WorkflowRunStatus` 总状态，但 stage / parallel / synthesis 节点级状态完全不可见——`MessagePart.workflow_run` schema（`lib/types.ts:268-284`）压根不带 stages 字段，注释直接写"实际子任务继续由 subagent_batch part 展示"，导致 Goal → Workflow → Stage → SubAgent → Tool 五层叙事在 UI 上塌成 Workflow + Batch 两层兄弟节点，无 anchor 关联（D-F1）。
- **自然语言**：`successCriteria` 服务端写死英文 `required artifact "X" is missing` / `... is empty` / `only N non-empty artifact(s); expected at least M` / `report artifact "X" is N chars …`（`lib/workflows/script-runtime.ts:328-340,357`），UI 原样展示（`MessageView.tsx:1738-1755`）；warning 不与 artifact 列表联动——同一个被点名"missing/empty"的 artifact 在下方列表里没有错误高亮，用户得自己在两段文本间对照（D-F5）。
- **信息结构**：所有 artifact 一律 `shortJson(artifact.value)` 截到 900 字符塞 `<pre>`（`MessageView.tsx:1815`），完全忽略 `WorkflowArtifact.kind` 与 `preview` 字段（`lib/workflows/types.ts:91-105` 已定义 `result/schema_output/worktree/diff/verification/debug` 六种 kind）：`diff` 应走 diff 视图、`verification` 应有 pass/fail 染色、长 markdown `result` 不应被砍——这是 successCriteria 反复报警的同一份产物（D-F4）。`canResume` 仅看 `checkpoints.length > 0`（`MessageView.tsx:1607`），点 Resume 时不让用户选 checkpoint，只能恢复 latest（D-F3）。
- **建议**：
  1. `app/components/MessageView.tsx:1574-1953` 在 `WorkflowRunCard` 头部增加 stage 进度条：从 `traceEvents`（`workflow_stage_started/ended`、`workflow_parallel_*`，见 `lib/workflows/types.ts` 中 `WorkflowTraceEvent`）派生 `[{title,status,startedAt,endedAt,parallelCount}]`；或在 `subagent_batch` part 加 `parentWorkflowId`，由 `MessagesScrollArea` 折叠为子节点（缩进 + 连接线）。
  2. `app/components/MessageView.tsx`（`traceEvents` 当前 0 命中）在 "Details" 折叠里加 timeline，按时间渲染 trace events，按 `kind` 上色（spawn/parallel/checkpoint/artifact/error）；或单独一个 "Run timeline" tab。
  3. `app/components/MessageView.tsx:1773-1788, 1797-1817` 列表头加 `Checkpoints (N)` / `Artifacts (N)` 计数，超 4 条用 `<details>` "Show all"；Resume 改 split button：主 action `Resume from latest`，次菜单列出全部 checkpoint name + createdAt 让用户选目标。
  4. `app/components/MessageView.tsx:1815` 用 `artifact.kind` 派生渲染器：`diff → DiffView`、`schema_output → JsonView`、`result → MarkdownView`（带 expand-to-modal 与导出）、`worktree → 链接`、`verification → 通过/失败徽标`；优先展示 `artifact.preview`，点开才载入 `value`。
  5. `lib/workflows/script-runtime.ts:316-360` 把 successCriteria 警告中文化并结构化（`{code, artifactName, expected, actual}`），UI 在 `MessageView.tsx:1738-1755` 渲染时把对应 artifact 行加 `aria-invalid` + 红边高亮，做"警告 ↔ 产物"的可视联动。

### E. SubAgent 调用 UI

审计范围：`app/components/MessageView.tsx:1974-2173`（`SubagentBatchCard`，是 stage / 并行的实际承载位置）、`lib/types.ts` 中 `subagent_batch` part schema、`lib/workflows/script-runtime.ts` 中 `spawnAgent` / `parallel` 路径。本节的完整审计原文未在本轮输入中提供，因此只对从 D 节交叉引用与已读代码可证实的项目落条；其余结构化结论（个体 subagent 卡的展开规则、timeout 与 cancel 文案、产物回填策略）需在补审后追加。

- **展开/收起**：`SubagentBatchCard` 与 `WorkflowRunCard` 在消息流中是**兄弟节点**而非父子（D-F1 已证），因此即便 batch 内多个子任务同时跑，外层也无统一折叠组；用户需要在多个并列卡之间来回滚动定位"哪个 batch 属于哪个 workflow"。批次内单个 subagent 的展开偏好同样未持久化（与 M1 同源）。
- **状态标识**：subagent 已有 `timeout` 状态枚举（H4 证据链中明确列出"subagent / approval 已支持 `timeout`，工具不一致"），但批次顶层是否有"n 成功 / m 超时 / k 取消"汇总徽标在源码中未见，`SubagentBatchCard` 与工具卡 `StatusDot` 是否共享同一 `STATUS_LABELS` 字典也未在已读片段中得到证实——需在补审中校验。
- **自然语言**：与 thinking / tool 同样存在中英文混杂风险（H6）；并发 batch 的标题、子任务命名、超时/取消文案是否走字典在已读片段中未确认。
- **信息结构**：当 subagent 内部产生 thinking / tool / 文本时，目前是否独立卡片承载、还是直接拼回主流，未在已读源码片段中确证；若是后者将与 H1 / H2 / M7 叠加（流式 thinking 默认折叠 + 块内无指示 + 多段无序号）。`MobileApp.tsx` 全文已确认无 subagent 卡片专用渲染（与 C-F4 移动端缺位同源）。
- **建议**（基于已证项，留待补审细化）：
  1. 在 `subagent_batch` part schema 加 `parentWorkflowId`，由 `app/components/MessageView.tsx` 在 `MessagesScrollArea` 渲染层把同一 workflow 下的 batch 折叠为子节点（缩进 + 连接线），消除 D-F1 中"workflow 与 batch 是兄弟"的层级断裂。
  2. `SubagentBatchCard`（`app/components/MessageView.tsx:1974-2173`）头部加汇总徽标 `{running n · done m · timeout k · cancelled j}`，复用即将统一的 `STATUS_LABELS` / `StatusDot`。
  3. 单个 subagent 卡复用 `useDisclosurePersistent`（M1 建议）以 `subagentId` 为 key 持久化展开态；错误 / timeout / cancelled 默认展开（与 M4 一致）。
  4. subagent 内部 thinking / tool 列表沿用 ProcessPartGroupRow 体系，但加"子任务上下文"前缀色块或左缩进以区分嵌套层级。
  5. 补审重点：①个体 subagent 卡 `defaultOpen` 现状；②是否存在脱敏与 `redact.ts` 接入点（H5 / M6 同源约束）；③移动端是否需要独立摘要条（与 C-F4 一致）。

> 信息缺口：本节缺 SubAgent 子审计原文。上述要点仅基于 D 节交叉引用与代码片段可直接证实的内容，其余结论标注为"需在补审中校验"。建议补充 `app/components/MessageView.tsx:1974-2173` 全段与 `subagent_batch` part schema 的完整审计后追加 finding。

## 跨模块的一致性问题

1. **状态枚举碎片化**：thinking 仅"未完成 / 完成"二元；tool 仅 `running/done/error`；subagent / approval 已含 `timeout`。同一产品里出现三套状态机，narration 与图标染色都得做特殊处理。 → 抽 `lib/types/status.ts` 统一 enum + `STATUS_LABELS` + `STATUS_COLORS`。

2. **中英文混杂**：phase pill / Composer 是英文，折叠组标题 / Tool 卡是中文，`tool.status` raw 英文穿透到 UI。 → 建立 `lib/i18n/phase-label.ts`，所有面向用户字符串走字典。

3. **展开偏好持久化缺失**：thinking、tool、process group 三处 `useState(false)` 重复实现，重挂载即丢，且 `forceLive` 单向覆盖手动操作。 → 抽 `useDisclosurePersistent(key)` Hook，统一 `sessionStorage` 写入策略。

4. **脱敏只覆盖标题不覆盖详情**：折叠头脱敏给用户"已脱敏"的错觉，但展开后明文回归。整个产品都需要"详情区入参前必过 redact"的硬性约束。 → 抽 `lib/narration/redact.ts` 并在 `<CodeBlock>` 包装层强制调用。

5. **a11y 基线分裂**：`GoalBar`、`Composer`、`MessagesScrollArea` 已有 `aria-live`，但 `ToolRender`、`ThinkingBlock` 完全缺位。同一会话里屏幕阅读器体验时好时坏。 → 在每个状态承载组件统一加 `role="status"` + `aria-busy`。

6. **文案动词不统一**：thinking 用"思考 / 整理思路"，tool 用"正在 / 已完成 / 执行失败"，phase 用 "Thinking / Running / Waiting"。 → 制定文案守则：进行时用"正在 X"，完成时用"已 X"，失败时用"X 失败"，全部主动语态。

7. **桌面 / 移动端能力裂口**：Goal 模块在桌面 `Composer.tsx:529-538` 嵌入 `GoalBar`，移动端 `MobileApp.tsx` 0 命中（H7）；类似的，`SubagentBatchCard` / `WorkflowRunCard` 在移动端是否有降级版本未在已读片段中确证。 → 把 `GoalBar` / `WorkflowRunCard` / `SubagentBatchCard` 都收敛到一组 "summary chip + sheet/dialog 详情" 的移动端模式，桌面与移动共享 props 与 status 字典。

8. **类型层 source of truth 不进 UI**：`acceptanceCriteria` / `RubricEvaluation` / `rejectionNote`（`lib/goal/types.ts:84-150`）、`WorkflowArtifact.kind` / `preview`（`lib/workflows/types.ts:91-105`）、`MessagePart.workflow_run.traceEvents`（`lib/types.ts:281`）— 这三组字段在数据层都已经存在，但前端 0 处消费。 → 建立 schema → UI 的"消费清单"检查项，CI 加 grep 守卫：`lib/**/types.ts` 中新增的可视字段必须在 `app/components/**` 至少一处被读到。

9. **层级断裂**：Goal → Workflow → Stage → SubAgent → Tool 在产品语义上是 5 层嵌套，但 UI 上塌成"GoalBar（与流分离）+ workflow_run 卡 + subagent_batch 卡（与 workflow_run 兄弟）+ 工具卡（在 process group 里）"四块互不关联的视觉单元（H9、D-F1）。 → 在 part schema 上加 parent 关联（`parentWorkflowId` / `parentSubagentId`），由 `MessagesScrollArea` 统一做缩进 + 连接线渲染，让用户能一眼看出"现在跑到第几层、哪些是兄弟、哪些是父子"。

10. **服务端文案直出 UI**：`lib/workflows/script-runtime.ts:328-357` 的 successCriteria 警告、`lib/goal/types.ts` 的 `GoalBlockedCategory` 枚举、`tool.status` raw 字符串都直接穿透到用户面前。 → 立一条产品红线："服务端枚举 / 错误码不进 UI"，所有面向用户的字符串必须在前端经过字典映射。

## 迭代优化建议（按优先级）

### P0 — 影响正确性/可读性的硬伤

1. **流式 thinking 默认展开**：`ThinkingBlock` 加 `defaultOpen`，streaming 期间为 `true`，结束后切回 `false`；同步打通外层 `forceLive`（H1）。
2. **空白 thinking 不渲染**：`if (!text || !text.trim()) return null;`，`appendToLastThinkingPart` 跳过纯空白 delta（H3）。
3. **扩 `tool.status` 枚举**：新增 `queued / timeout / cancelled`；reducer 在 abort / agent stop / 前置失败时正确回填，避免永挂 `running`（H4）。
4. **详情区脱敏**：抽 `lib/narration/redact.ts` 覆盖 Bearer / AWS / `sk-` / JWT / PEM / URL token；`<CodeBlock>` 强制过滤；提供"显示原文（敏感）"显式按钮（H5、M6）。
5. **错误工具自动展开**：`defaultOpen = isError || status==="error"`；截断时强制露出 banner 一行预览（M4）。

### P1 — 提升信息架构与可发现性

6. **统一中英文文案**：建立 `lib/i18n/phase-label.ts`；`Composer.Thinking` / phase pill / `tool.status` 副标题全部走字典（H6）。
7. **块内状态指示**：`ThinkingBlock` summary 加 pulse + `aria-busy`；`StatusDot` 包 `role="status"` + sr-only 文案（H2、M3）。
8. **展开偏好持久化**：抽 `useDisclosurePersistent`（key=toolCallId / messageId+partIndex），写 `sessionStorage`；历史 thinking 默认展开（M1）。
9. **折叠头标题改进**：拆"动词 + 目标"，目标段独立 `shortPath` / `shorten(64)`，加 `title={fullLabel}` tooltip（M5）。
10. **多段 thinking 视觉分隔**：聚合 ①/② 序号 badge + 段间 0.5px 分隔线（M7）。

### P2 — 文案与微交互打磨

11. **thinking 词汇统一**：折叠组与块内统一为"思考"（M8）。
12. **历史 thinking 时长**：反序列化补 `durationMs`，或不显示 `Ns` 避免视觉跳（L1）。
13. **abort 后 phase 清理**：`cancelTurn` 显式置 `phase=null`（L2）。
14. **复制思考按钮**：在 `ThinkingBlock` 末尾加"复制"icon 按钮，绕开 `extractPlainText` 的产品决策（L3）。
15. **错误前缀去重**：`phaseText` 与折叠头共用 `STATUS_LABELS`，避免"执行失败：执行失败"叠加（L4）。

## 关键文案 / 文档建议（自然语言模板）

下列模板可直接落地为 `lib/i18n/phase-label.ts` + `lib/narration/templates.ts` 字典；变量用 `{name}` / `{path}` / `{n}` 标注。

### 1. Phase pill（顶部实时状态）
- `phase.thinking` → `思考中…`
- `phase.waiting_model` → `等待模型回复…`
- `phase.running_tools` → `正在调用 {name}…`
- `phase.running_tools_multi` → `正在并行调用 {n} 个工具…`

### 2. 工具状态徽标（StatusDot 旁的 sr-only 文案）
- `status.queued` → `排队中`
- `status.running` → `执行中`
- `status.done` → `已完成`
- `status.error` → `执行失败`
- `status.timeout` → `已超时`
- `status.cancelled` → `已取消`

### 3. 折叠头自然语言摘要（动词 + 目标，主动语态）
- `tool.read.running` → `正在读取 {path}`
- `tool.read.done` → `已读取 {path}`
- `tool.bash.running` → `正在执行命令：{cmd}`
- `tool.bash.error` → `命令执行失败：{cmd}`
- `tool.edit.done` → `已修改 {path}（{n} 处）`

### 4. Thinking 块文案
- `thinking.idle` → `思考`
- `thinking.streaming` → `思考中…`
- `thinking.done` → `思考 {duration}s`
- `thinking.aborted` → `思考已中断`
- `thinking.error` → `思考异常`

### 5. 安全 / 脱敏提示
- `redact.banner` → `已隐藏 {n} 处可能的密钥/令牌。点击「显示原文」展开（请确认环境安全）。`
- `redact.button.show` → `显示原文（敏感）`
- `redact.button.hide` → `重新隐藏`

### 6. 截断 / 错误 Banner
- `truncation.banner` → `输出过长已截断，仅显示前 {n} 行。可在终端中查看完整内容。`
- `tool.error.banner` → `工具执行失败。错误已自动展开，请确认参数与权限。`
- `tool.cancelled.banner` → `任务已取消，部分工具未完成。`

### 7. SubAgent / Workflow 卡片
- `subagent.title` → `子任务：{title}`
- `subagent.status.running` → `子任务执行中…（已用时 {duration}s）`
- `subagent.status.timeout` → `子任务超时（{limit}s 未返回）`
- `workflow.step.running` → `第 {i}/{total} 步：{name}（执行中）`

### 8. Composer / Thinking level（去英文化）
- `composer.thinking_level.label` → `思考强度`
- `composer.thinking_level.options` → `关闭 / 标准 / 深度`

## 附录：审计输入摘要

本报告整合的 5 份子审计：

| 编号 | 模块 | 状态 | 字符数 | 主要贡献 |
| --- | --- | --- | --- | --- |
| 1 | thinking | completed | 5971 | A1-A4 共 9 条 finding，覆盖展开规则 / 状态指示 / 自然语言 / 信息层级 |
| 2 | toolchain | completed | 5996 | F-1~F-9 共 9 条 finding，覆盖 status 枚举 / 脱敏 / a11y / 持久化 / 截断 |
| 3 | goal-plan-todo | completed | ~5400 | C-F1~C-F6 共 6 条 finding，覆盖 status chip 文案 / 验收清单 0 消费 / GoalBar 非 sticky / 移动端缺位 / blocked category 未本地化 / Timeline 中英文混杂 |
| 4 | workflow | completed | ~5200 | F-D1~F-D5 共 5 条 finding，覆盖 stage/parallel 不可见 / `traceEvents` 字段 0 消费 / checkpoint·artifact `slice(-4)` / artifact `kind` 与 `preview` 被忽略 / successCriteria 英文且不联动 |
| 5 | subagent | partial | — | 仅依据 D 节交叉引用与已读源码片段（`MessageView.tsx:1974-2173`、subagent timeout 状态）落条，原文未在本轮提供，结构性结论标注为"待补审" |

> 注：F-9（"执行失败："前缀双重叠加）的原文在输入末尾被截断，已根据可见上下文推断为 L4。若需严格还原，请重新提供 toolchain 审计的完整 5996 字符版本。

---

**报告完结。** 共整合 9 个 High / 13 个 Medium / 7 个 Low / Info findings（含基于 C/D 完整审计补入的 H7-H9 / M9-M13 / L5-L7）；P0/P1/P2 三级共 15 条迭代建议；8 组共 30+ 条自然语言模板可直接落地。SubAgent 子审计原文未在本轮提供，相关结构性结论待补审后追加。


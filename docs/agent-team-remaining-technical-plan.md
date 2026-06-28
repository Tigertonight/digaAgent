# Agent Team 未完成部分技术方案

状态：待实现规划（2026-06-28）

目标：把 Agent Team 从“可运行但经常需要用户判断和兜底”的能力，收敛成“能自动推进、状态一致、结论可读、过程可查、失败可恢复”的协作体验。

本文只记录当前仍需要继续打磨的部分。已经落地的事实地图见 `docs/agent-team-state-map.md`。

## 1. 当前剩余问题

### 1.1 自动推进仍有不确定性

现状：

- 前端已有 `shouldAutoKickAgentTeamRun()`，会在 Team 停在 running + pending task + 无 active member 时触发 `run_until_idle`。
- UI 文案已经说明“负责人会继续自动安排”，但用户仍会看到“继续推进 / 手动推进一次”一类入口，并不确定是否必须点击。

剩余风险：

- 自动推进只在前端活跃时运行。页面刷新、窗口后台、SSE 中断时，调度不够稳定。
- 如果同一 run 多次进入 stale pending 状态，当前 dedupe 可能因为 key 没变化而不再推进。
- 自动推进失败只写 dev console，用户侧感知弱。

方案：

- 把 auto-kick 从“前端兜底”升级为“前后端双层兜底”。
- 前端继续保留轻量 interval，用于活跃页面快速恢复。
- 后端在 `teams/route.ts` 的 `get/list/run` 路径增加 `maybeAutoAdvanceTeamRun()`：
  - 只对 `run.status === "running"` 生效。
  - 有 pending required task。
  - 没有 `claimed/running` task。
  - 没有 `member.status === "working"`。
  - 最近一次 event/member/task update 超过 `45s`。
  - 自动推进次数不超过每个 run 每 2 分钟 1 次。
- 将 auto-kick 事件写入 board：
  - `type: "auto_advance_attempted"`
  - `message: "团队检测到没有成员在处理，已自动推进下一步。"`
  - 失败时写 `auto_advance_failed`，但不直接变成 fatal。

建议新增字段：

```ts
interface AgentTeamRun {
  autoAdvance?: {
    lastAttemptAt?: number;
    lastSuccessAt?: number;
    failureCount?: number;
    lastError?: string;
  };
}
```

验收：

- Team 停在“成员已准备好，等待任务认领”超过 45s 后，无需用户点击即可再次分派。
- 用户不用理解“继续推进”按钮。按钮改为“手动推进一次”，只作为排障兜底。
- 自动推进失败时，任务流能看到一条说人话记录。

## 2. 状态机收敛

### 2.1 Run 状态

建议将用户可见状态收敛为以下五类：

```ts
type AgentTeamDisplayStatus =
  | "running"
  | "waiting_user"
  | "completed"
  | "completed_with_risks"
  | "stopped";
```

映射规则：

| 数据状态 | 用户状态 | 展示 |
| --- | --- | --- |
| `run.status === "running"` 且无用户动作 | `running` | 团队正在处理 |
| `run.status === "running"` 且存在 blocking manual action | `waiting_user` | 需要你处理 |
| `run.status === "completed"` 且无风险 | `completed` | 已完成 |
| `run.status === "completed"` 且有 unresolved/skipped/provider risk | `completed_with_risks` | 已完成，有风险提示 |
| `paused/aborted/failed` | `stopped` | 已暂停/已停止/失败 |

硬规则：

- `completed/completed_with_risks` 下，不允许出现：
  - “待推进”
  - “自动处理中”
  - “继续推进”
  - “需要你处理”
- 完成态下未处理 task 必须被转为：
  - `skipped`，或
  - 隐藏在风险提示中，不再作为进行中任务展示。

### 2.2 Task 状态

建议补 `skipped`，避免“完成 run + pending task”矛盾。

```ts
type AgentTeamTaskStatus =
  | "pending"
  | "claimed"
  | "running"
  | "blocked"
  | "completed"
  | "skipped";
```

完成收束时：

- `summarize_available` / `finalize_with_risks` 将未完成 required tasks 置为 `skipped`。
- `completionSource = "lead_override"` 只作为内部字段，不直接展示给用户。
- UI 文案：
  - `skipped`: “已跳过，风险已写入结论”
  - `completed`: “已处理”
  - `pending` in running: “等待安排”
  - `pending` in completed: 不展示

验收：

- 完成态的任务流里不会显示“待推进”。
- 如果任务被跳过，风险提示能解释原因。

## 3. 成员记录打开链路

现状：

- Team 卡片里点击成员会打开右侧 Team workspace。
- Sidebar 内“打开完整记录”会尝试按 `sessionFile` 跳到 child session。
- 如果 session 列表里找不到该文件，目前有兜底提示，但 session 匹配仍偏脆弱。

方案：

### 3.1 入口分层

成员名点击默认只做一件事：

- 打开右侧侧推窗中的成员摘要。

完整记录按钮才做 session 跳转：

- 文案：“打开完整会话”
- 失败时只在成员摘要区域显示提示，不出现全局红色错误。

### 3.2 Session 匹配增强

增加统一 helper：

```ts
function findSessionForMemberRecord(
  sessions: SessionInfoLite[],
  sessionFile: string
): SessionInfoLite | null
```

匹配顺序：

1. exact path：`session.path === sessionFile`
2. normalized path：去掉重复 slash、解码 URL 后比较
3. session id：从 `sessionFile` 文件名提取 id，与 `session.id` 比较
4. 安全 basename：只在 basename 唯一时匹配

不要做宽松 suffix 模糊匹配，避免打开错 session。

验收：

- 点击成员 chip 100% 打开侧推窗。
- 完整 session 缺失时，不出现全局红色错误。
- 完整 session 存在时，能跳转到左侧对应会话。

## 4. 最终回答 Adapter

当前核心问题：

- Team 的最终结论仍容易混入内部过程语言。
- 对用户 query 的“意图”理解不够稳定。
- 当用户问开放问题时，回答容易变成“通过/不通过”模板。

方案：

### 4.1 意图分类

保留 deterministic classifier，但把输出从简单 `intent` 扩展为结构化：

```ts
interface FinalAnswerIntentProfile {
  intent:
    | "pass_fail"
    | "audit_report"
    | "status_summary"
    | "root_cause"
    | "recommendation"
    | "open_ended";
  asksForVerdict: boolean;
  asksForEvidence: boolean;
  asksForActionPlan: boolean;
  mentionedFiles: string[];
}
```

分类规则：

- “是否通过 / 有没有修好 / 是否完成”：`pass_fail`
- “看下问题 / 审计 / 检查完整性”：`audit_report`
- “为什么 / 原因 / 卡住”：`root_cause`
- “怎么改 / 方案 / 计划”：`recommendation`
- “目前怎么样 / 完成度”：`status_summary`

### 4.2 结论生成协议

最终回答统一分三层：

1. 直接回答用户问题。
2. 给 1-3 条关键依据。
3. 如果有风险，再给风险提示。

禁止默认输出：

- Team runtime
- quality gates
- provider stream
- TEAM_RESULT_JSON
- No teammate output
- lead override
- 共享白板
- 主聊天

除非用户问“技术细节 / 日志 / 为什么内部失败”，这些词才允许在技术解释里出现。

### 4.3 低质量回答拦截

在 `getAgentTeamFinalSummary()` 出口增加质量校验：

```ts
interface FinalAnswerQualityCheck {
  ok: boolean;
  reasons: Array<
    | "does_not_answer_query"
    | "contains_internal_jargon"
    | "too_process_oriented"
    | "missing_verdict"
    | "missing_actionable_detail"
  >;
}
```

如果失败：

- 尝试用 deterministic rewrite 重写一次。
- 如果仍失败，输出“无法形成可靠结论”的清晰说明，而不是内部过程。

验收：

- 对“这个最终结论用于回复 query 能打几分”类场景，最终回答能直接评价质量。
- 对“是否通过”类 query，第一句必须包含明确判断。
- 对“原因/方案”类 query，第一句不能是“通过/不通过”。

## 5. UI 信息层级

默认只展示 P0。

### 5.1 默认模块

保留：

1. 团队状态
2. 成员分工
3. 需要你处理：仅有人工动作时出现
4. 风险提示：仅有风险时出现
5. 任务流：默认收起

移除独立模块：

- 模型判断
- 诊断与门禁
- 团队过程
- 最近执行

这些信息的归属：

| 原信息 | 新归属 |
| --- | --- |
| 模型判断 | 团队状态 / 风险提示 |
| 最近执行 | 任务流顶部 |
| 诊断与门禁 | 风险提示或任务流详情 |
| 完整事件流 | 任务流展开态 |
| 任务清单 | 任务流展开态 |

### 5.2 成员分工

成员分工只显示 chip：

- 负责人
- 资料员
- 质疑者
- 整理者
- Builder

状态规则：

- 完成态：不显示“待命”
- 未启动：灰色
- 运行中：蓝色呼吸灯
- 已处理：蓝色
- 异常：只在风险提示中解释，不在 chip 上堆长文案

### 5.3 任务流

任务流结构：

```text
任务流
  最近动作（最多 3 条，静态 member_spawned 合并为一条）
  关键任务
  完整事件流
  诊断详情（高级）
```

规则：

- 静态固定节点要聚合：
  - 多个 `member_spawned` 合成“已准备 4 位成员”
  - 多个 idle/waiting member 不平铺
- 展开按钮文案：
  - 收起态：“展开”
  - 展开态：“收起”

验收：

- 默认视图不出现大段灰色解释。
- 一屏内能看懂团队状态、成员和是否有风险。

## 6. 风险提示与需要处理

### 6.1 风险提示

只在以下情况出现：

- provider stream error
- skipped required task
- missing evidence
- unresolved challenge
- final answer confidence low

格式：

```ts
interface TeamRiskNotice {
  title: string;
  reason: string;
  impact: string;
  suggestedAction?: string;
}
```

用户文案示例：

- “部分成员没有完整返回，因此这次结论可信度偏低。”
- “有关键任务被跳过，最终结论只代表阶段性判断。”
- “缺少证据引用，建议重新跑一次严格审计模式。”

### 6.2 需要你处理

只在真正需要用户动作时出现：

- plan approval
- worktree merge/discard/keep
- browser/site approval
- manual finding requested
- sensitive action confirmation

不应该因为普通 blocked diagnostic 出现。

验收：

- 没有人工动作时，整个“需要你处理”模块隐藏。
- 有风险但无需用户操作时，只显示“风险提示”。

## 7. 测试计划

### 7.1 Unit

- `shouldAutoKickAgentTeamRun`
  - stale pending run 返回 true。
  - active member / claimed task 返回 false。
  - completed run 返回 false。
- `final-summary`
  - pass/fail query 第一段给明确判断。
  - root-cause query 不强行输出“通过/不通过”。
  - internal jargon 被过滤。
- `result-ingestion`
  - 自然语言可整理为 finding。
  - 空成员输出不会被当成成功。
  - provider stream error 进入 risk。
- `diagnostics`
  - completed run 不返回 active blockers。
  - skipped task 转成 risk notice。

### 7.2 Component

- `MessageView`
  - 完成态不显示“继续推进 / 待推进”。
  - 成员启动节点合并。
  - 完成节点统一蓝色。
- `WorkbenchSidebar`
  - 成员 chip 点击打开成员摘要。
  - 完整记录缺失显示 inline notice。
  - 无风险时风险模块隐藏。
  - 无人工动作时需要处理模块隐藏。
  - 任务流展开/收起文案正确。

### 7.3 E2E

1. 创建 Team 后不点手动推进，等待自动分派。
2. 成员 session 缺失时点击成员，不出现全局红错。
3. provider stream error 后，最终回答是风险总结，不是 internal error。
4. 完成态刷新页面，仍不显示“待推进”。
5. 同 query 对比 subagent 和 Team，Team 最终回答能回答原问题。

### 7.4 浏览器验收

在 `http://localhost:3000` 手测：

- 启动 Team。
- 打开 Team tab。
- 点击成员 chip。
- 展开任务流。
- 等待自动推进。
- 完成后检查：
  - 主会话里有最终结论。
  - Sidebar 无冗余“模型判断/诊断门禁”。
  - 无“继续推进/待推进/quality gates/TEAM_RESULT_JSON”等默认可见词。

## 8. 实施顺序

建议分 4 个 PR/commit：

1. 状态机收敛：
   - `skipped` task
   - completed run 清理 pending/running 展示
   - 风险与人工动作分离
2. 自动推进增强：
   - 后端 `maybeAutoAdvanceTeamRun`
   - auto advance events
   - 前端按钮文案收敛
3. 成员记录链路：
   - session finder helper
   - side drawer first
   - inline failure notice
4. 最终回答质量：
   - intent profile
   - quality check
   - deterministic rewrite
   - E2E 对比验收

## 9. 完成标准

- 用户不需要默认点击“继续推进”。
- Team 完成后，界面没有仍在处理的任务。
- 最终回答能直接回答用户原始问题。
- 点击任何成员入口都不会打断主流程。
- 默认 Team tab 只展示 P0 信息。
- 风险和需要处理明确分离。
- 关键回归命令通过：

```bash
npx vitest run lib/agent-team/*.test.ts app/components/MessageView.test.ts app/components/WorkbenchSidebar.test.ts app/components/MessagesScrollArea.test.ts
npx tsc --noEmit --pretty false
npm run lint
npm run test:e2e:team
```

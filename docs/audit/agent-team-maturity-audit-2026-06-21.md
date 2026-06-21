# Agent Team 成熟度审计记录

审计时间：2026-06-21 11:21 CST

审计范围：仅审计与记录，不修改实现代码。对标对象为 Anthropic Claude Code 官方 Agent Teams 文档页：

- https://code.claude.com/docs/en/agent-teams

## 结论

当前实现已经达到 **Beta / 技术预览可用**，但尚未达到 **成熟 / production-ready Agent Team**。

更具体地说：能力维度基本铺开了，Team UX 也已经明显区别于 subagent 和 workflow；但不少关键能力仍停留在“有数据结构、有按钮、有半自动 API”的状态，尚未形成 Claude Agent Teams 那种 teammate 自主协作、真实消息闭环、可持续恢复、强约束权限与可审计综合的成熟体验。

成熟度评分：6.5 / 10

- 架构覆盖度：8 / 10
- UX 区分度：7.5 / 10
- 真实协作闭环：5 / 10
- 可靠性与恢复：6 / 10
- 权限、安全、冲突控制：5.5 / 10
- 测试与验收证据：6 / 10

## Claude Agent Teams 基线

官方文档中的关键基线能力：

1. 明确与 subagents 区分：subagents 只回报给主 agent；Agent Teams 通过共享任务列表与直接 teammate 通信协作。
2. 一个主 session 作为 lead，多个独立 teammate session 各自拥有 context window。
3. 共享 task list：pending / in progress / completed，支持依赖、claim、complete、自协调。
4. Mailbox / direct messaging：用户和 teammate 可以直接给某个 teammate 发消息。
5. Display modes：in-process 与 split panes。
6. Teammate 可使用 subagent definitions，继承项目上下文、skills、MCP 等。
7. 权限：teammates 继承 lead permission；permission prompts 会冒泡。
8. Plan approval：复杂任务可要求 teammate 先 plan，lead 批准后再写。
9. Hooks：TeammateIdle、TaskCreated、TaskCompleted 可阻止或反馈低质量状态。
10. 文件冲突与 task claiming 使用协调机制降低 race condition。
11. 生命周期：启动、隐藏 idle teammate、停止、清理、恢复限制明确。
12. 限制：实验功能；in-process teammate 不能完整 resume；task status 可能滞后；一个 session 一个 team；无 nested teams；lead 固定。

## 当前实现证据

### 已具备的真实能力

1. 显式启动与 UX 区分
   - `ChatApp` 中 `/team` 和 Team chip 会进入 `requestTeamLaunch`，先展示确认面板，再由 `confirmTeamLaunch` 调用 `startTeam`。
   - 确认面板包含目标、成员规模、挑战开关、权限边界、停止条件，并明确“普通聊天、Subagents、Workflow 不会自动升级到 Team”。
   - 证据：`app/ChatApp.tsx:2414-2478`、`app/ChatApp.tsx:3788-3990`。

2. Team Run 独立消息卡
   - Team 使用 `agent_team_run`，不是复用 `subagent_batch`。
   - 卡片展示成员、开放任务、采纳发现、开放挑战、lead state，并提供 Open Workspace / Pause / Resume / Finalize / Stop。
   - 证据：`app/components/MessageView.tsx:2358-2505`，`lib/chat-reducer.test.ts` 相关 Team card 测试。

3. Team Workspace 已形成独立工作区
   - Workspace 展示 Board、Members、File Locks、Quality Gates、Hooks、Claude Parity、Findings & Challenges、Decisions。
   - 支持 run_next、run_batch、run_until_idle、claim、retry、complete、promote、replace、follow-up、broadcast、hook toggle。
   - 证据：`app/components/WorkbenchSidebar.tsx:898-1435`。

4. 独立 teammate session 能被创建
   - `spawnInitialTeammates` 为非 lead member 调用 `createAgent`，hidden=true，并记录 agentId/sessionFile。
   - 证据：`app/api/agent/[id]/teams/route.ts:567-650`。

5. Board 数据结构完整
   - `AgentTeamRun` 包含 members、tasks、findings、challenges、decisions、messages、fileLocks、hooks、qualityGates、capabilityAudit、events。
   - 证据：`lib/agent-team/types.ts`。

6. Task claim / complete / dependency / finalize gates 已有 runtime
   - dependent task 会 blocked，完成依赖后 unblock。
   - finalize 会检查 required tasks、open challenges、lead synthesis。
   - 证据：`lib/agent-team/runtime.ts:300-428`，`lib/agent-team/runtime.test.ts`。

7. Mailbox 和 direct follow-up 已可用
   - `send_message` 记录 board message；`follow_up_member` 既写 mailbox，也会 prompt 指定 teammate session。
   - 证据：`app/api/agent/[id]/teams/route.ts:220-274`、`lib/agent-team/server-store.ts:395-433`。

8. File lock 有真实拦截路径
   - claim 时可按 writePaths 建锁。
   - teammate 写工具调用会通过 `createAgentTeamWriteLockExtension` 自动提取目标路径并记录/阻止冲突。
   - 证据：`lib/agent-team/runtime.ts:650-772`、`lib/agent-team/write-lock-extension.ts`、`lib/agent-registry.ts` 中 child agent extension。

9. 持久化与恢复
   - Team run 持久化到 `~/.diga-agent/agent-teams/runs`。
   - 重启 hydrate 时 running/finalizing 会转 paused，并保留事件记录。
   - session context API 会按 parentSessionPath 返回 agentTeamRuns。
   - 证据：`lib/agent-team/server-store.ts:142-220`、`app/api/sessions/[id]/context/route.ts`。

10. 失败恢复有基本手动路径
    - dispatch failure 会把 task 标为 blocked。
    - Workspace/API 支持 retry_task、replace_member。
    - 证据：`app/api/agent/[id]/teams/route.ts:329-378`、`lib/agent-team/runtime.ts:1020-1160`。

11. 当前验证命令通过
    - `npm run typecheck` 通过。
    - `npm test -- lib/agent-team/runtime.test.ts lib/agent-team/server-store.test.ts lib/chat-reducer.test.ts app/components/MessageView.test.ts app/components/WorkbenchSidebar.test.ts lib/subagents/write-boundary.test.ts lib/runtime/agent-event-bridge.test.ts` 通过，7 files / 138 tests。

## 未达到成熟状态的关键问题

### P0：自动协作闭环仍不成熟

当前 `run_next` / `run_batch` / `run_until_idle` 会 prompt teammate，但 prompt 成功后 API 立即调用 `completeStoredAgentTeamTask`，写入模板化 finding：

- `Review the teammate transcript for full details.`
- confidence 固定 medium
- evidenceRefs 只有 session file 和 team-task id

证据：`app/api/agent/[id]/teams/route.ts:487-546`。

这说明当前不是 Claude 那种 teammate 自主完成、主动写回发现、互相挑战、lead 等待并综合的闭环，而是“调度成功即完成”的半自动路径。它能演示任务推进，但不能证明 teammate 的真实产出已被结构化吸收。

成熟度影响：最高。会导致 board 与实际 transcript 不一致，也会让 final synthesis 的可信度不足。

### P0：Challenge / Decision 缺少操作和自动生成闭环

数据结构有 challenges 和 decisions，Workspace 能显示，但没有找到 create_challenge、resolve_challenge、accept/reject finding、record_decision 等 API。

证据：

- `rg challenge|resolve|decision` 主要命中展示、类型和 finalize gate。
- Workspace 只展示 findings/challenges/decisions，没有挑战创建/解决操作。
- `runtime.ts` 没有导出 challenge 相关 mutation。

这意味着“过程可见、冲突可见、决策可见”只完成了可视化容器，尚未完成协作行为。

成熟度影响：最高。Agent Team 的核心价值之一就是互相挑战和收敛，这部分目前偏静态。

### P0：启动设置没有强约束到运行时

确认面板有 allowNetwork / allowWrite / allowWorktree / allowChallenges / requirePlanApproval，但这些 settings 主要被保存，没有完整接入执行策略：

- `mergeSettings` 只合并字段：`app/api/agent/[id]/teams/route.ts:674-715`。
- `spawnInitialTeammates` 创建 teammate 时没有依据 allowWrite/allowNetwork/worktree 改权限或工具边界。
- `requirePlanApproval` 没有对应审批状态机。
- `allowChallenges=false` 不会阻止 challenge 相关行为，因为 challenge mutation 尚未存在。

成熟度影响：高。UX 上给了用户决策点，但实际执行未完全遵守，会造成信任问题。

### P1：Team run 初始化仍是固定模板，不是按目标动态规划

`createInitialAgentTeamRun` 固定创建 Lead / Research / Critic / Synthesis 四个成员，固定三项任务 frame/evidence/challenge。确认面板选择 small/standard/deep 目前不会改变初始成员数或任务分解。

证据：`lib/agent-team/mock.ts:12-92`、`app/api/agent/[id]/teams/route.ts:87-106`。

成熟度影响：高。Claude 会根据用户任务和显式 teammate 指令决定成员与任务；当前更像固定 scaffold。

### P1：Shared task list 是中心化操作，不是 teammate 自协调

当前 task claim/complete 主要由 API/Workspace/dispatch 控制。teammate 没有直接可用的 team coordination tools 来自己 claim、complete、send message、challenge。

证据：

- Workspace 的 task 操作默认用 lead.id claim：`app/components/WorkbenchSidebar.tsx:987-1038`。
- dispatch plan 选择 runnable task 和 idle member，但 teammate 只是收到自然语言 prompt：`lib/agent-team/runtime.ts:231-256`。

成熟度影响：高。Claude 的 teammate 可以共享 task list、自行 claim，并通过 mailbox 协调；当前更像 lead-side orchestration。

### P1：Plan approval 只是配置项

确认面板可勾选“Lead 先形成任务板再推进”，settings 中有 `requirePlanApproval`，但没有 teammate plan request、approve/reject、read-only plan mode、re-submit 等状态机。

证据：`AgentTeamSettings.requirePlanApproval` 存在，但未找到 plan approval runtime/API。

成熟度影响：高。对于写代码型 Team，这是风险控制的关键成熟度能力。

### P1：成员规模配置未真实生效

`memberScale` 被 UI 和 settings 保存，但 `createInitialAgentTeamRun` 固定 4 人，`spawnInitialTeammates` 遍历固定 members。

成熟度影响：中高。用户以为选了小队/标准/深度，实际 Team 结构未按选择变化。

### P1：权限与 worktree 隔离未成熟

Claude 官方建议避免文件冲突，也有 worktree 并行实践。当前有 file lock，但没有按 member 创建 worktree、没有网络权限隔离、没有按 allowWrite 进入 read-only/plan-only。

证据：`createAgent` 调用只传 cwd、parent、role、hidden，没有工作区隔离参数；settings 仅 merge。

成熟度影响：中高。并行写代码场景还不稳。

### P1：恢复策略保守但不完整

当前进程恢复会将 running/finalizing Team 转 paused，保留 board。这比 Claude 文档中 in-process resume 限制更清楚，但尚未自动重建 teammate records，也没有区分可恢复/已丢失/需替换的成员状态。

证据：`lib/agent-team/server-store.ts:179-220`。

成熟度影响：中。适合防止误继续，但用户恢复后需要更多引导。

### P2：Hooks 是内置规则，不是用户可扩展 hook 系统

已有 TaskCompleted 和 TeammateIdle 内置规则，Workspace 可开关；但 TaskCreated 未实际评估，用户自定义脚本/规则未实现。

证据：`lib/agent-team/mock.ts:120-150`、`lib/agent-team/runtime.ts:190-228`、`app/components/WorkbenchSidebar.tsx:1265-1327`。

成熟度影响：中。

### P2：测试偏单元与源码护栏，缺少真实 E2E

现有测试覆盖 runtime/store/chat reducer/message card/source guard，但没有真正启动 Team、创建隐藏 agents、运行 run_until_idle、follow-up member、promote sidebar、恢复历史 board 的 browser/E2E 路径。

已验证：7 files / 138 tests passed。

成熟度影响：中。当前回归风险仍较高。

## 对标矩阵

| 能力 | Claude 官方基线 | 当前状态 | 成熟度 |
| --- | --- | --- | --- |
| 显式启动/用户控制 | 可请求或提议，用户确认 | 已显式 `/team` + confirmation | Beta+ |
| 与 subagent 区分 | 独立 teammate、共享 task list、直接通信 | UI 与数据结构已区分 | Beta |
| 独立 teammate session | 每个 teammate 独立 context | 可创建 hidden child agents | Beta- |
| 共享 task list | teammate 自行 claim/complete | API/Workspace/dispatch 中心化操作 | Beta- |
| Mailbox | 自动投递，成员互相通信 | board messages + follow-up prompt | Beta- |
| 直接 teammate 交互 | 可打开 teammate transcript 并发消息 | transcript/promote/follow-up 可用 | Beta |
| Plan approval | plan mode、approve/reject | 只有 setting | Prototype |
| Hooks | TeammateIdle/TaskCreated/TaskCompleted | 内置 TaskCompleted/TeammateIdle，TaskCreated 未闭环 | Beta- |
| File locking | task claim 协调和防冲突 | claim + tool write lock 可阻止冲突 | Beta |
| Worktree/权限 | 继承权限，可调模式；并行工作建议隔离 | settings 未强约束，worktree 未实现 | Prototype |
| Challenge/debate | 多假设挑战和收敛 | 结构/展示有，mutation 缺失 | Prototype+ |
| Decision traceability | lead synthesis from findings | decisions 展示，缺少自动 trace/审批 | Prototype+ |
| Resume/cleanup | 有限制但清楚；cleanup 自动 | board 持久化，running hydrate paused，stop abort/dispose hidden | Beta- |
| Failure recovery | 直接指示或 replacement teammate | manual retry/replace 有，自动策略无 | Beta- |
| UX Workspace | terminal agent panel/split panes | 专用右侧 workspace，体验方向很好 | Beta+ |

## 是否达到成熟状态

没有。

当前更接近：

- “Agent Team UX + orchestration scaffold”
- “可演示的 Team board / teammate session / dispatch / mailbox / file lock”
- “面向成熟 Team 的 Beta 基座”

但还不是：

- “可以放心让多个 agent 自主长时间协作的成熟 Agent Team”
- “与 Claude Agent Teams 行为等价的 teammate self-coordination”
- “可审计、可恢复、可控权限的 production workflow”

## 成熟所需的下一阶段验收门槛

进入 mature 前，建议必须满足以下验收：

1. Dynamic planning
   - 根据 objective、memberScale、用户指定角色动态生成 members/tasks。
   - small/standard/deep 实际改变成员数和任务密度。

2. Real teammate result ingestion
   - run_next 不得 prompt 成功即 complete。
   - 必须读取 teammate 真实输出，结构化抽取 finding/evidence/challenge，失败时保持 task running/blocked。

3. Challenge lifecycle
   - 支持 create_challenge、resolve_challenge、dismiss_challenge、accept/reject finding。
   - Finalize 必须能证明每个开放 challenge 已处理。

4. Decision traceability
   - record_decision 必须绑定 accepted/rejected findings、challenge resolution、artifact/session evidence。
   - Workspace 点击 decision 能追溯来源。

5. Plan approval state machine
   - requirePlanApproval=true 时，teammate 先进入 plan-only。
   - Lead approve/reject 后才能写入或执行高风险工具。

6. Settings enforcement
   - allowWrite=false 时阻止写工具。
   - allowNetwork=false 时限制网络工具。
   - allowWorktree=true 时为写代码 teammate 建立隔离工作区或明确不支持并提示。

7. Teammate self-coordination tools
   - teammate 能通过工具 claim/complete/send_message/challenge，而不是只靠 lead API。

8. End-to-end tests
   - Playwright 或 integration test 覆盖：/team confirmation -> start -> workspace -> dispatch -> finding -> challenge -> resolve -> finalize。
   - 覆盖恢复历史 Team run、promote member、follow-up member 不切主 session。

## 建议优先级

第一优先级：

1. 修正 dispatch 完成语义：从“prompt 成功即完成”改为“读取真实 teammate 产出后结构化回写”。
2. 补 challenge/finding/decision mutation API。
3. 让启动设置真实影响 Team 构成与权限。

第二优先级：

1. Plan approval 状态机。
2. teammate self-claim/self-complete tools。
3. E2E 验收链路。

第三优先级：

1. 更完整的恢复/replacement 引导。
2. 用户自定义 hooks。
3. split panes / multi-session 视觉增强。

## 审计判定

能力纬度：基本对标。

完成度：中等偏上，但关键闭环还没成熟。

产品状态建议：标为 Experimental / Beta，不建议标 Mature。

对用户的产品承诺建议：

- 可以说：“Team 模式已支持共享工作区、隐藏成员会话、任务板、成员追问、文件锁和半自动调度。”
- 不应说：“已经完全达到 Claude Agent Teams 成熟能力。”
- 更准确说法：“能力面已追上核心框架，但 teammate 自主协作、挑战决策闭环和权限执行仍需补强。”

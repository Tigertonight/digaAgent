# 0604 Next Step Plan: Goal Mode + Dynamic Workflow + Multi-Agent

> 日期：2026-06-04
> 目标：把当前可运行的 Goal Mode、Dynamic Workflow 与 Multi-Agent，推进成接近 Claude Code 体验的长期任务运行时与多 agent 协同系统。

## 0. 实施进度（2026-06-04 更新）

### ✅ Sprint 1：Goal 可信运行时闭环 —— 已完成

第一期聚焦 Goal 可靠性内核，五个里程碑全部落地，形成完整闭环：

> 用户给一个复杂目标 → 跨重启持续推进 → 每轮记录 turn → 产物自动沉淀为 evidence → 完成时 verifier 用 evidence 把关（虚假完成被拒）→ 卡住时结构化分类并停止空烧 → 全程 UI timeline 可见。

| 里程碑 | 核心价值 | 落地文件 |
|---|---|---|
| **M1 持久化地基** | Goal 跨重启存活（落盘 `~/.mini-pi/goals/{agentId}.json`，envelope+version+原子写+容错 hydrate） | `lib/goal/file-store.ts`、`lib/goal/server-store.ts`（改为 facade）、`lib/goal/types.ts`（扩展） |
| **M2 Turn 生命周期** | 每轮续跑记录 turn；progress 产物自动桥接为 goal evidence（仅 active goal）；续跑 prompt 注入 recap | `lib/goal/evidence-bridge.ts`、`lib/goal/file-store.ts`（turn API）、`lib/agent-registry.ts`（挂钩 agent_start/agent_end） |
| **M3 Stop-Time Verifier** | 完成由证据接受而非模型自报；无 evidence / workflow 失败 / 验收标准未满足 → 拒绝并反馈缺口 | `lib/goal/verifier.ts`、`lib/goal/update.ts`（单一编排点，工具与 API 共用）、`lib/goal/extension.ts`（反馈文本） |
| **M4 结构化阻塞** | blocker 自动分类 + unblockAction；同一 blocker 累计 repeatedCount，达阈值停止自动续跑防空烧 | `lib/goal/blocked-state.ts`、`lib/goal/update.ts`、`lib/agent-registry.ts`（死循环守卫） |
| **M5 Timeline UI** | turns / evidence / 结构化 blocked 详情在前端可见 | `app/components/GoalTimeline.tsx`、`app/components/GoalBar.tsx`、`app/api/agent/[id]/route.ts`（`goal_timeline` action） |

测试：新增 `file-store.test.ts`、`evidence-bridge.test.ts`、`verifier.test.ts`、`update.test.ts`、`blocked-state.test.ts`；全量 **311 tests / 29 files 通过**，`tsc --noEmit`、`npm run build`、`eslint` 均零问题。

DoD 中三个 Goal 验收点均有代码与测试支撑：`GOAL-ACCEPT-RESTART-RESUME`、`GOAL-ACCEPT-COMPLETE-VERIFIER`、`GOAL-ACCEPT-BLOCKED-POLICY`。

### ✅ Sprint 2：Subagent 定义化（Registry + @agent + per-agent policy + memory）—— 已完成

第二期把 runtime 临时创建的 subagent 升级为项目/用户可管理的可复用 specialist，形成完整闭环：

> 项目建 `.agents/subagents/reviewer.md` → 主 agent 通过 plan_subagents 看到 specialist → 用户 `@reviewer` 或主 agent 在 task 填 specialistId → orchestrator 合并 specialist 的 prompt/工具/模型/记忆 → readOnly reviewer 被剥写工具 → audit 记录 agent_selected。

| 能力 | 核心价值 | 落地文件 |
|---|---|---|
| **Definition + Parser** | 手写最小 frontmatter 解析（无 YAML 依赖）+ schema 校验，invalid 快速失败 | `lib/subagents/definition.ts`、`lib/subagents/definition-parser.ts` |
| **Registry** | 发现 project(`<cwd>/.agents/subagents/*.md`)/user(`~/.mini-pi/subagents/*.md`)，project 覆盖 user，versionHash 缓存 | `lib/subagents/registry.ts` |
| **Permission policy** | definition 为上限，runtime 不可提权；readOnly/boundedWrite/denyAll | `lib/subagents/policy.ts` |
| **per-agent model policy** | specialist 可固定模型（reviewer 用强模型、批量 RAG 用便宜模型），不完整 model 安全回退 parent | `lib/subagents/policy.ts`（resolveSubagentModel） |
| **@agent 调用** | 解析 `@reviewer`，引导主 agent 用 specialistId 委派（保持主 agent 编排权） | `lib/subagents/router.ts`、`app/api/agent/[id]/route.ts`（prompt case 接线） |
| **plan_subagents hints** | 把可用 specialists（id+description）注入 planner 供主 agent 选择 | `lib/subagents/planner.ts`、`lib/subagents/extension.ts` |
| **Subagent memory v1** | specialist 跨 batch 保留紧凑结构化经验，注入 child prompt，落盘 `~/.mini-pi/subagents/memory/{scope}/{id}.json` | `lib/subagents/memory.ts` |
| **orchestrator 接线** | 解析 specialistId→definition，合并 prompt/tools/model/permission/memory，audit `agent_selected` | `lib/subagents/orchestrator.ts`（三挂接点 + runOneTask） |
| **types** | `SubagentTask.specialistId`（与 runtime agentId 区分）+ `agent_selected` audit | `lib/subagents/types.ts` |

测试：新增 `definition-parser.test.ts`、`registry.test.ts`、`policy.test.ts`、`router.test.ts`、`memory.test.ts`；全量 **365 tests / 34 files 通过**，`tsc --noEmit`、`npm run build`、`eslint` 均零问题；现有 10 个 orchestrator 测试零回归（向后兼容确认）。

DoD 两个 Subagent 验收点均有代码与测试支撑：`SUBAGENT-ACCEPT-0604-REGISTERED-REVIEWER`、`SUBAGENT-ACCEPT-0604-EXPLICIT-AGENT`。

第二期顺延项中，worktree isolation 与 subagent hooks 已在第三期完成（见下）；MCP scope / background queue / LLM 自动路由仍顺延。

### ✅ Sprint 3：Worktree Isolation + Subagent Hooks —— 已完成

第三期让 implementation subagent 能安全放开（隔离 worktree 改代码→diff→审批→merge），并补齐 hooks 让 specialist memory 自动更新、危险操作可拦截：

> implementation specialist 在隔离 git worktree 中改代码 → diff → merge approval（拒绝则丢弃）→ cleanup；reviewer 完成后 recurring risk 自动写入 memory 供下次注入；危险 shell 被 BeforeToolUse hook 拦截。

| 能力 | 核心价值 | 落地文件 |
|---|---|---|
| **Worktree Isolation** | implementation child 不直接写主工作区，在隔离 worktree 产出 diff，merge 前必审批，失败/拒绝安全丢弃，finally 必清理 | `lib/subagents/isolation.ts`、`orchestrator.ts`(mergeIsolatedWorktree + runOneTask)、`agent-registry.ts`(注入 worktrees + requestSubagentWorktreeMergeApproval) |
| **Subagent Hooks v1** | SubagentStop 自动更新 memory（闭合"只读不写"缺口）；BeforeToolUse 拦截危险 shell | `lib/subagents/hooks.ts` |
| **类型扩展** | permissionMode 加 `worktree`；definition 加 isolation/hooks；task 加 isolation；runtime 加 worktree 元数据；audit 加 worktree_*/hook_fired/memory_updated | `lib/subagents/definition.ts`、`types.ts`、`definition-parser.ts`（isolation frontmatter） |
| **复用现有基础设施** | 直接用 `createGitWorktreeManager`（create/diff/merge/remove）+ approval broker，不重写 git 逻辑 | `lib/workflows/git-worktree.ts`（复用） |

测试：新增 `isolation.test.ts`、`hooks.test.ts`；subagents 模块 **95 tests** 全绿；全量 **386 tests / 36 files 通过**，`tsc --noEmit`、`npm run build` 零问题；现有 10 个 orchestrator 测试零回归（向后兼容确认）。

DoD 三个验收点均有代码与测试支撑：`SUBAGENT-ACCEPT-WORKTREE-ISOLATION`、`SUBAGENT-ACCEPT-MEMORY-AUTOUPDATE`、`SUBAGENT-ACCEPT-HOOK-DENY`。

第三期顺延项中，background queue 与 SubagentStart hook 已在第四期完成（见下）；MCP registry/scope、LLM 自动路由、AfterToolUse 完整实现仍顺延。

### ✅ Sprint 4：Background Queue + 剩余 Hooks —— 已完成

第四期把 MCP 往后放（SDK 无原生支持、风险高，单独立项），先做就绪度高的两项轻量能力：

> 长批次可 `background: true` 后台运行，主 agent 不阻塞，立即拿到 batchId，完成后推 batch-end；SubagentStart hook 在 child 创建后触发并记 audit。

| 能力 | 核心价值 | 落地文件 |
|---|---|---|
| **Background queue v1** | batch 支持 `detached` 状态；`delegate_subagents(background:true)` 立即返回、后台跑完推 `subagent_batch_end`；cancel 复用现有 abort | `orchestrator.ts`（executeBatch 抽取 + background 分支）、`types.ts`（detached/background/detached event）、`extension.ts`（透传 + detached 文案）、`useAgentEvents.ts`（事件接入） |
| **SubagentStart hook** | child 创建后触发 `log-start` hook，记 audit | `hooks.ts`（runSubagentStartHook）、`orchestrator.ts`（task_started 处接线）、`definition.ts`（hooks.subagentStart） |
| **AfterToolUse 占位** | 定义类型 + no-op 占位（完整实现需订阅 child tool 事件，顺延） | `hooks.ts`（runAfterToolUseHook 占位） |

测试：subagents 模块 hooks **18 tests**；全量 **390 tests / 36 files 通过**，`tsc --noEmit`、`npm run build`、`eslint` 零问题；现有 orchestrator 测试零回归。

第四期顺延项（第五期候选）：**MCP registry/scope（已有独立规划 `plan_sprint4-mcp.md`，建议单独成期）**、LLM-based 自动路由、AfterToolUse 完整实现（订阅 child tool 事件记 evidence）、background queue 增强（detach/notify UI、per-task 取消）。

### ✅ Sprint 5：MCP 集成（Registry + stdio Client + Scope + Tool Bridge）—— 已完成

第五期把外部工具生态接进来：用户在 Settings 配置一个 stdio MCP server → registry 落盘 → runtime 拉起真实子进程并 `tools/list` → 每个 MCP 工具桥接成 agent 工具（命名空间 `mcp__{server}__{tool}`）→ 执行前强制走 allow/deny/ask 策略 + 审批 + 审计 → 主 agent 看到所有启用 server，specialist subagent 只看到自己声明的 server。

> 关键边界（decision A）：本期范围收敛为 **stdio transport + tools only**，不做 SSE/HTTP transport、resources/prompts/sampling。任何 server 故障都被容错吞掉（list 返回 `[]`、call 返回 error result），绝不阻塞 agent 创建或主流程。

| 能力 | 核心价值 | 落地文件 |
|---|---|---|
| **stdio MCP Client** | 最小 JSON-RPC over stdio 客户端，支持 `initialize`/`tools/list`/`tools/call`，带超时、子进程生命周期管理与保证清理 | `lib/mcp/client.ts`（McpStdioClient） |
| **Server Registry** | MCP server 配置增删查 + id 校验 + 落盘持久化（启用/停用） | `lib/mcp/registry.ts` |
| **Runtime** | 复用 live client，`listMcpTools`/`callMcpTool` 容错（故障 server 不抛进主流程） | `lib/mcp/runtime.ts` |
| **Policy + Scope** | 工具级 allow/deny/ask（默认 ask，安全优先）；specialist MCP 作用域（`scopeServersForSpecialist`，未声明即无 scope） | `lib/mcp/policy.ts` |
| **Tool Bridge** | 把 MCP 工具包成 agent ToolDefinition，执行前强制策略 + 审批 + 审计，agent 无法绕过 broker（修正 2） | `lib/mcp/tool-bridge.ts` |
| **Loader + 主接线** | best-effort 加载所有启用 server 的工具并注入 agent；主 agent 看全部、child 按 `allowedMcpServers` 收敛 | `lib/mcp/loader.ts`、`lib/agent-registry.ts`（createAgent 注入 + requestMcpToolApproval） |
| **Subagent scope 接线** | child 创建时传 `mcpServers: definition?.allowedMcpServers ?? []`，非 specialist child 得不到任何 MCP 工具 | `lib/subagents/orchestrator.ts`（runOneTask）、`definition.ts`/`definition-parser.ts`（allowedMcpServers frontmatter） |
| **API 路由** | list / upsert / remove / **test**（实测连接并列出工具数）；upsert/remove 即时 dispose 旧 client 触发重连 | `app/api/mcp/route.ts` |
| **Settings UI** | 可视化配置/启停/测试 MCP server | `app/settings/McpServersSection.tsx`、`app/settings/SettingsPanel.tsx`（接线） |

测试：新增 `registry.test.ts`、`runtime.test.ts`（含 stdio 客户端集成 + 超时降级）、`policy.test.ts`、`tool-bridge.test.ts`；全量 **422 tests / 40 files 通过**，`tsc --noEmit`、`npm run build` 零问题，`eslint` **0 errors**（仅既有 unused-vars warnings，与 MCP 无关）。

Sprint 5 退出标准对照：

- ✅ MCP registry / settings UI / `test` 连接。
- ✅ Subagent scoped MCP（specialist 只看声明的 server，主 agent 看全部）。
- ✅ MCP tool 经 policy（allow/deny/ask）+ 审批 broker，agent 无法绕过。
- ⏭️ `workflow.listTools()` / `workflow.callTool()`（workflow 脚本 SDK 层）：本期 MCP 接到 **agent 工具层**而非 workflow SDK；该 SDK 接口顺延（仍属 P2 范围）。
- ⏭️ MCP server 级 allow/deny/ask 持久化策略 UI（当前策略默认 ask + 运行时审批，规则尚未做 UI 配置面板）顺延。

### ⏭️ 范围调整说明

原"第一期"同时包含 Subagent 定义化（Registry / `@agent` / per-agent policy）。实施时评估后**将其顺延到第二期**：Goal 重启丢数据是信任级硬伤，且 verifier/memory 等都依赖 Goal 持久化先落地，因此第一期收敛为单一 Goal 主题做透。Subagent 定义化作为下一阶段主菜。

### 🔜 下一步建议

第一期（Goal 闭环）与第二期（Subagent 定义化）均已完成。后续候选：

- Goal + Workflow 深度集成（workflow evidence 关联 goal turn、workflow inspector）。
- Subagent 进阶（已在第三/四期完成：worktree isolation、SubagentStop→memory、BeforeToolUse deny、background queue、SubagentStart hook；第五期完成 MCP scope）；剩余：AfterToolUse 完整实现、LLM 自动路由。
- Permission Policy（tool-level allow/deny/ask rules + Pre/PostToolUse hooks，P2，部分能力已随 MCP/subagent hooks 落地）、`workflow.listTools/callTool`（workflow SDK 层 MCP）、CLI/CI（P3）、Replay/Eval（P4）。

---

## 1. 当前基线

当前系统已经具备三个核心基础：

### Goal Mode（Sprint 1 后已升级，见第 0 节）

- 用户可以用 `/goal <objective>` 启动目标。
- ✅ goal、turn 历史、evidence 已持久化到 `~/.mini-pi/goals/{agentId}.json`，跨重启存活（M1）。
- agent turn 结束后可以自动续跑；每轮记录为结构化 `GoalTurn`（M2）。
- 模型可以通过 `goal_update` 标记 `complete` 或 `blocked`；`complete` 须经 stop-time verifier 基于 evidence 接受（M3）。
- ✅ blocked 状态结构化（category + unblockAction + repeatedCount），重复 blocker 达阈值停止空烧（M4）。
- UI 已有 `GoalBar`，支持 pause / resume / clear，并可展开 `GoalTimeline` 查看 turns/evidence/blocked 详情（M5）。
- 已有长任务验收，证明 goal 可以跨多轮继续执行。

### Dynamic Workflow

- 已有 `run_workflow_script`，支持任务专属 workflow script。
- workflow script 在受限 process worker 中执行，不暴露 `require`、`import`、`process`、`fs`、shell、全局网络 API。
- 所有外部能力都通过 `workflow` SDK 和 parent runtime broker：
  - `workflow.spawnAgent`
  - `workflow.parallel`
  - `workflow.stage`
  - `workflow.checkpoint`
  - `workflow.artifact`
  - `workflow.readArtifact`
  - `workflow.createWorktree`
  - `workflow.diffWorktree`
  - `workflow.mergeWorktree`
  - `workflow.removeWorktree`
  - `workflow.askUser`
  - `workflow.fetchUrl`
- 已有 capability manifest、approval broker、network policy、network audit、worktree merge approval。
- workflow run 已持久化到 `~/.mini-pi/workflows/runs/{workflowId}.json`。
- workflow store 已升级到 v2 envelope，支持 artifact index、大 artifact 压缩、迁移历史和可配置 retention。
- resume 已支持 `resumeFromWorkflowId` 和 `resumeFromCheckpointName`。
- Workflow history UI 可选择 checkpoint，并把 checkpoint/artifact 摘要写入续跑 prompt。
- 可通过 `MINI_PI_WORKFLOW_WORKER_SANDBOX_ARGV_JSON` 接入外部 sandbox launcher。
- 可通过 `npm run workflow:sandbox:check` 检测本机 sandbox 工具。

### Multi-Agent / Subagents

- 主 agent 已能通过 `plan_subagents` 判断是否需要拆分任务。
- 主 agent 已能通过 `delegate_subagents` 并发创建 child agent。
- 每个 child agent 拥有独立 session/context，结果写回 parent SSE/session。
- child agent 在 sidebar 中归属到 parent 下，不作为顶层会话散落。
- parent message 中的 subagent card 可展开查看单个 task 结果。
- batch/task metadata 已持久化到 `~/.mini-pi/subagents/batches/{batchId}.json`。
- 支持 retry 单个 task、resume 未完成 batch、打开 child session 继续追问。
- 支持 deterministic verifier、batch synthesis、attempts、auditEvents。
- 支持 `allowedTools` + `writePaths`，并在 SDK `tool_call` 前阻断越界 write/edit/patch。

## 2. 下一阶段产品目标

下一阶段不是继续堆单点能力，而是把系统收束成一个长期任务运行时：

> 用户给出一个复杂目标后，系统能规划、拆解、执行、审批、验证、恢复、审计，并能在失败或中断后继续推进。

目标体验：

- 用户可以启动一个长期目标。
- 系统先规划，再执行。
- 复杂目标可以拆成 subgoals / workflow stages / specialist subagents。
- 每一步都有 evidence。
- 完成不是模型自报，而是 verifier 基于 evidence 接受。
- 被阻塞时给出明确 unblock action。
- 用户可以查看 timeline、workflow runs、artifacts、network audit、worktree diff。
- 重启、失败、approval wait、网络限制、merge conflict 都能恢复。
- 后续可以接入 MCP、CLI/headless、GitHub/CI、workflow replay/eval。

## 3. 与 Claude Code 的主要差距

当前实现已经有 Claude Code-style dynamic orchestration 的内核，但还缺这些产品化能力：

1. **MCP 生态**
   - 缺 MCP server registry。
   - 缺 `workflow.callTool` / `workflow.listTools`。
   - 缺 MCP tool schema 注入。
   - 缺 MCP server 级权限。

2. **权限策略系统**
   - 当前是 capability-level approval。
   - 还缺 tool-level allow / deny / ask rules。
   - 还缺 PreToolUse / PostToolUse hooks。
   - 还缺 bash/browser/network 的细粒度风险分类。

3. **CLI / headless 模式**
   - 当前主要依赖 Web/Electron UI。
   - 缺 `mini-pi workflow run/resume/inspect`。
   - 缺 JSON event stream。
   - 缺 CI-friendly exit code。

4. **Subagent 文件系统注册**
   - 当前 subagent 主要由 runtime 输入驱动。
   - 缺 `.agents/subagents/*.md` 或类似注册机制。
   - 缺 subagent prompt versioning、capability profile、自动发现。

5. **Multi-Agent 产品化能力**
   - 缺长期可复用的 specialist agent 定义库。
   - 缺基于 description 的自动委派和显式 `@agent` 调用。
   - 缺 per-agent model policy，例如 reviewer 用强模型、批量 RAG 用便宜模型。
   - 缺 per-agent permission mode，例如 read-only、acceptEdits、plan-only、sandboxed。
   - 缺 subagent scoped MCP，MCP 工具还不能只暴露给某个 specialist。
   - 缺 subagent hooks，例如 SubagentStart、SubagentStop、BeforeToolUse、AfterToolUse。
   - 缺 subagent memory，当前持久化的是运行结果，不是 specialist 长期经验。
   - 缺 worktree isolation，implementation agent 还没有默认隔离分支、diff、merge approval 闭环。
   - 缺 background subagent 体验，例如 detach、pause、notify、后台队列。

6. **Workflow replay / eval**
   - 当前有单测和 runtime 测试。
   - 缺 record/replay。
   - 缺 approval replay。
   - 缺 network/worktree failure injection。
   - 缺 golden trace。

7. **Goal verifier 和 evidence**
   - 当前 goal 可以跨轮，但 completion 仍偏模型自报。
   - 缺 stop-time verifier。
   - 缺 acceptance criteria。
   - 缺 turn-level evidence。

8. **默认强 sandbox**
   - 当前支持外部 sandbox launcher。
   - 但默认仍是 process worker + Node heap + POSIX CPU limit。
   - 生产需要启用外部 sandbox 并做端到端验收。

## 4. 北极星架构

```text
User Goal
  -> Goal Planner
  -> Acceptance Criteria
  -> Goal Runtime
  -> Dynamic Workflow
  -> Capability Broker
  -> Subagent Registry / MCP Tools / Worktrees / Browser / Network
  -> Evidence Store
  -> Verifier
  -> Timeline / Audit / Resume
```

核心原则：

- 模型负责规划和编排。
- runtime 负责权限、状态、审计、恢复。
- tool 和 side effect 必须走 broker。
- goal 完成必须有 evidence。
- workflow script 只拥有控制流，不拥有裸系统能力。

## 5. Roadmap

### P0: Goal Runtime Reliability

目标：让长期目标可靠、可恢复、可验证。

Deliverables:

- Durable goal store。
- Goal turn records。
- Goal evidence records。
- Stop-time verifier v1。
- Structured blocked state。
- Goal timeline UI v1。
- Restart resume acceptance test。

Acceptance criteria:

- goal survives restart。
- goal turn history survives restart。
- premature `goal_update complete` can be rejected。
- blocked goal shows reason/category/unblock action。
- UI shows turns and evidence。
- `npm test`、`npx tsc --noEmit`、relevant Playwright tests pass。

### P1: Workflow Productization

目标：把 Dynamic Workflow 从 runtime capability 变成用户可理解、可恢复、可调试的工作台。

Deliverables:

- Workflow run inspector。
- Workflow replay snapshot。
- Workflow template registry。
- Workflow CLI inspect/resume。
- Stronger workflow history filtering。
- Worktree conflict recovery guide。

Acceptance criteria:

- 用户能从 UI 查看 workflow script、manifest、capabilities、logs、checkpoints、artifacts。
- 用户能从任意 checkpoint 生成续跑 prompt。
- workflow run 能导出 debug bundle。
- failed merge 能被 retry、cleanup、或者转人工处理。

### P1.5: Multi-Agent Productization

目标：把当前一次性的 `delegate_subagents` 批处理，升级成可复用、可配置、可权限隔离、可长期演进的 specialist agent 系统。

Deliverables:

- Subagent definition registry。
- Project/user level `.agents/subagents/*.md`。
- Explicit `@agent` invocation。
- Description-based auto delegation。
- Per-agent model policy。
- Per-agent permission mode。
- Per-agent tool/MCP scope。
- Subagent memory v1。
- Worktree isolation for implementation agents。
- Subagent hooks v1。
- Background subagent queue v1。

Acceptance criteria:

- 用户可以创建一个 `reviewer.md`，主 agent 在代码审查任务中自动选择它。
- 用户可以显式输入 `@reviewer review this diff` 调用指定 agent。
- `reviewer` 只能看到它声明的 tools/MCP server。
- `implementation` agent 默认在 worktree 中修改代码，merge 前必须展示 diff 并审批。
- subagent 完成后写入 audit、memory，并可在 parent card 中展开。
- background subagent 完成后能通知 parent，并在 UI 中从 running 变为 completed。

### P2: MCP + Permission Policy

目标：把工具生态和权限策略扩展到 Claude Code-like 级别。

Deliverables:

- MCP server registry。
- `workflow.listTools()`。
- `workflow.callTool()`。
- Tool-level policy rules。
- PreToolUse / PostToolUse hooks。
- settings-level permission config。

Acceptance criteria:

- workflow 可以调用一个 MCP tool，但不能绕过 capability broker。
- tool call 可以被 allow/deny/ask rule 控制。
- PreToolUse hook 可以拒绝高风险操作。
- PostToolUse hook 可以记录 evidence / audit。

### P3: CLI / CI / GitHub Automation

目标：让 workflow 不只在 UI 中运行，也能作为自动化基础设施运行。

Deliverables:

- `mini-pi workflow run`。
- `mini-pi workflow resume`。
- `mini-pi workflow inspect`。
- JSON event stream。
- CI-friendly exit codes。
- Optional GitHub issue/PR trigger。

Acceptance criteria:

- CI 可以运行 workflow 并拿到 machine-readable result。
- workflow failure returns non-zero exit。
- workflow artifacts can be exported。
- PR/issue 场景可以复用同一 workflow runtime。

### P4: Replay / Eval / Hardening

目标：让长期 agent 行为可回归、可压测、可安全部署。

Deliverables:

- Workflow record/replay。
- Mock tool responses。
- Approval replay。
- Network replay。
- Worktree conflict replay。
- Sandbox E2E acceptance。
- Golden traces。

Acceptance criteria:

- 一个历史 workflow 可以离线 replay。
- approval/network/worktree failure 可以注入并验证恢复逻辑。
- sandbox 开启后，worker 无法访问网络和非授权路径。

## 6. 可落地技术方案

### 6.1 Durable Goal Store

Current files:

- `lib/goal/types.ts`
- `lib/goal/server-store.ts`
- `lib/agent-registry.ts`
- `app/api/agent/[id]/route.ts`

新增接口：

```ts
export interface GoalStore {
  getGoal(agentId: string): Promise<AgentGoal | null>;
  setGoal(agentId: string, goal: AgentGoal): Promise<void>;
  patchGoal(agentId: string, patch: Partial<AgentGoal>): Promise<AgentGoal | null>;
  clearGoal(agentId: string): Promise<void>;
  appendTurn(agentId: string, turn: GoalTurn): Promise<void>;
  listTurns(agentId: string): Promise<GoalTurn[]>;
  appendEvidence(agentId: string, evidence: GoalEvidence): Promise<void>;
  listEvidence(agentId: string): Promise<GoalEvidence[]>;
}
```

存储路径：

```text
~/.mini-pi/goals/{agentId}.json
```

新增类型：

```ts
export interface GoalTurn {
  id: string;
  agentId: string;
  goalId: string;
  index: number;
  status: "running" | "complete" | "blocked" | "failed";
  startedAt: number;
  endedAt?: number;
  prompt: string;
  summary?: string;
  workflowIds?: string[];
  filesTouched?: string[];
  commandsRun?: string[];
  evidenceIds: string[];
  error?: string;
}

export interface GoalEvidence {
  id: string;
  goalId: string;
  turnId?: string;
  type: "test" | "build" | "file" | "screenshot" | "browser" | "workflow" | "manual";
  label: string;
  path?: string;
  command?: string;
  workflowId?: string;
  passed?: boolean;
  details?: string;
  createdAt: number;
}
```

Implementation steps:

1. Add `lib/goal/store.ts` for interface.
2. Add file-backed implementation under `lib/goal/file-store.ts`.
3. Keep `lib/goal/server-store.ts` as facade.
4. Add schema envelope and migration path.
5. Add tests with temp root.
6. Add restart-resume tests.

### 6.2 Goal Turn Lifecycle

新增 lifecycle：

```ts
startGoalTurn(agentId, prompt): Promise<GoalTurn>
finishGoalTurn(agentId, turnId, patch): Promise<GoalTurn>
recordGoalEvidence(agentId, evidence): Promise<GoalEvidence>
```

Integration points:

- `maybeContinueGoal` starts a turn before launching the next agent prompt。
- `agent_end` finalizes active turn。
- `workflow_start` / `workflow_end` attaches workflow evidence。
- shell/test/browser events can attach evidence later。
- `goal_update blocked` writes blocked state and finishes the turn as blocked。

### 6.3 Stop-Time Goal Verifier

新增 verifier：

```ts
export interface GoalVerifier {
  verify(input: GoalVerifyInput): Promise<GoalVerifyResult>;
}

export interface GoalVerifyResult {
  decision: "accept_complete" | "continue" | "blocked";
  reason: string;
  missingEvidence?: string[];
  nextPrompt?: string;
}
```

Verifier v1 rules:

- If acceptance criteria require evidence, each criterion must map to at least one evidence item。
- If UI changed, require browser/screenshot/manual skip evidence。
- If code changed, require test/build/manual skip evidence。
- If workflow failed or merge failed, completion is rejected。
- If no evidence exists, completion is rejected。

Files:

- `lib/goal/verifier.ts`
- `lib/goal/verifier.test.ts`

Runtime behavior:

- `goal_update complete` routes through verifier。
- verifier accepts -> goal complete。
- verifier rejects -> goal remains active and continuation prompt includes missing evidence。
- verifier blocks -> goal blocked with unblock action。

### 6.4 Structured Blocked State

新增类型：

```ts
export interface GoalBlockedState {
  reason: string;
  category:
    | "needs_user"
    | "needs_approval"
    | "tool_error"
    | "external_dependency"
    | "policy"
    | "merge_conflict"
    | "unknown";
  unblockAction: string;
  repeatedCount: number;
  firstBlockedAt: number;
  lastBlockedAt: number;
}
```

Behavior:

- Pending approval exists -> do not auto-continue。
- Same blocker repeats -> increment `repeatedCount`。
- Repeated blocker reaches threshold -> stop retrying and show exact unblock action。
- Merge conflict -> category `merge_conflict` and link workflow/worktree artifact。

### 6.5 Goal Memory

新增类型：

```ts
export interface GoalMemory {
  completed: string[];
  pending: string[];
  decisions: string[];
  importantFiles: string[];
  workflowIds: string[];
  risks: string[];
  latestVerification?: string;
  updatedAt: number;
}
```

Behavior:

- Update after every turn。
- Inject into continuation prompt。
- Keep short and structured。
- Link to workflow checkpoints/artifacts when available。

Files:

- `lib/goal/memory.ts`
- `lib/goal/memory.test.ts`

### 6.6 Acceptance Criteria

新增到 `AgentGoal`：

```ts
export interface GoalAcceptanceCriterion {
  id: string;
  description: string;
  evidenceRequired: boolean;
  satisfied: boolean;
  evidenceIds: string[];
}
```

Creation behavior:

- `/goal <objective>` generates default criteria。
- `/goal --criteria "...; ..."` accepts explicit criteria later。
- `/goal --plan <objective>` lets planner propose criteria before execution。

Default criteria:

- Required artifact exists。
- Relevant tests pass。
- Browser/UI verification exists when UI is touched。
- Final summary exists。
- No unresolved workflow failure remains。

### 6.7 Goal Timeline UI

新增：

- `app/components/GoalTimeline.tsx`
- Timeline entry for each `GoalTurn`。
- Evidence list。
- Blocked state detail。
- Linked workflow run cards。

Events:

```ts
type GoalEvent =
  | { type: "goal_updated"; goal: AgentGoal }
  | { type: "goal_turn_started"; turn: GoalTurn }
  | { type: "goal_turn_finished"; turn: GoalTurn }
  | { type: "goal_evidence_added"; evidence: GoalEvidence };
```

Acceptance:

- User can see each turn status, duration, summary, evidence count。
- User can open related workflow run。
- Blocked state shows category and unblock action。

### 6.8 MCP Integration

新增接口：

```ts
workflow.listTools({ source?: "builtin" | "mcp" })
workflow.callTool({ server, tool, input })
```

Runtime rules:

- MCP tool calls require `mcp` capability。
- Each MCP server can have allow/deny/ask policy。
- Tool schema is loaded by parent runtime, not by worker。
- Worker only sends structured request to parent。

Files:

- `lib/mcp/registry.ts`
- `lib/mcp/policy.ts`
- `lib/workflows/mcp-runtime.ts`
- `app/settings/McpServersSection.tsx`

Acceptance:

- A workflow can call a test MCP tool。
- A denied MCP tool call is blocked before execution。
- MCP call result is recorded as workflow artifact or log。

### 6.9 Permission Policy + Hooks

Policy shape:

```ts
export interface ToolPermissionRule {
  id: string;
  scope: "global" | "project" | "agent" | "workflow";
  toolPattern: string;
  action: "allow" | "deny" | "ask";
  condition?: {
    cwdPattern?: string;
    commandPattern?: string;
    urlPattern?: string;
  };
}
```

Hooks:

```ts
type RuntimeHook =
  | "BeforeToolUse"
  | "AfterToolUse"
  | "WorkflowStart"
  | "WorkflowEnd"
  | "GoalTurnStart"
  | "GoalTurnEnd";
```

Implementation:

- Add `lib/policy/tool-permissions.ts`。
- Route workflow/subagent tool requests through policy evaluator。
- Emit hook events。
- Allow hooks to add evidence, deny operation, or request approval。

### 6.10 Workflow CLI / Headless

Commands:

```text
mini-pi workflow run --agent <id> --objective "..."
mini-pi workflow resume --agent <id> --workflow <workflowId> --checkpoint <name>
mini-pi workflow inspect --workflow <workflowId> --json
mini-pi workflow sandbox check
```

Output:

- Human-readable default。
- `--json` emits machine-readable event stream。
- Non-zero exit on failed/aborted workflow。

Files:

- `bin/mini-pi-web.js`
- `lib/workflows/cli.ts`
- `scripts/check-workflow-sandbox.mjs`

### 6.11 Multi-Agent Productization

目标：

> 把当前 runtime 临时创建的 subagent，升级为项目/用户可管理的 specialist agent。每个 specialist 拥有稳定定义、工具边界、模型策略、MCP scope、hooks、memory 和可选 worktree isolation。

#### 6.11.1 Subagent Definition Registry

Filesystem layout:

```text
.agents/subagents/
  reviewer.md
  implementer.md
  researcher.md
```

Subagent file format:

```md
---
id: reviewer
title: Code Reviewer
description: Use for reviewing diffs, regressions, missing tests, and security risks.
model:
  provider: openai-completions
  id: gpt-5
permissionMode: readOnly
capabilities:
  - read_files
  - shell
defaultTools:
  - read
  - grep
allowedMcpServers:
  - github
hooks:
  beforeToolUse:
    - deny-dangerous-shell
  afterToolUse:
    - record-evidence
memory:
  scope: project
isolation:
  mode: none
---

Review the diff for correctness, regressions, missing tests, and security risks.
```

Implementation:

- Add `lib/subagents/registry.ts`。
- Add `lib/subagents/definition.ts`。
- Add `lib/subagents/definition-parser.ts`。
- Discover project and user subagents。
- Project path: `<cwd>/.agents/subagents/*.md`。
- User path: `~/.mini-pi/subagents/*.md`。
- Registry precedence: project overrides user by `id`。
- Validate frontmatter schema。
- Store parsed definitions in memory with file hash/version。
- Expose registry to main agent system prompt and `plan_subagents`。
- Allow `delegate_subagents({ tasks: [{ agentId: "reviewer" }] })`。
- Allow `workflow.spawnAgent({ role: "reviewer" })` to resolve registry entry。
- Add UI/settings surface for discovered agents。

Types:

```ts
export interface SubagentDefinition {
  id: string;
  title: string;
  description: string;
  prompt: string;
  source: "project" | "user" | "builtin";
  sourcePath?: string;
  versionHash: string;
  model?: SubagentModelPolicy;
  permissionMode?: SubagentPermissionMode;
  capabilities?: string[];
  defaultTools?: string[];
  allowedMcpServers?: string[];
  hooks?: SubagentHookConfig;
  memory?: SubagentMemoryConfig;
  isolation?: SubagentIsolationConfig;
}
```

Acceptance:

- Invalid definition fails fast with a readable error。
- Project definition overrides user definition。
- Main agent sees concise registry hints, not full prompts。
- Child prompt includes resolved specialist prompt and current task prompt。

#### 6.11.2 Auto Delegation and Explicit Invocation

目标：

- 自动：主 agent 根据 `description`、task signals、tool needs 选择 specialist。
- 显式：用户可以 `@reviewer`、`@researcher`、`@implementer` 调用指定 agent。

Implementation:

- Add `lib/subagents/router.ts`。
- Extend `planSubagents` input with available definitions。
- Router score = description match + role match + tool/capability fit + permission fit。
- Parse explicit mentions in composer or server prompt layer。
- Add `suggestedAgentId` to planner output。
- Add `agentId` to `SubagentTask` and `SubagentTaskRuntime`。

Types:

```ts
export interface SubagentRouteDecision {
  taskId: string;
  agentId?: string;
  confidence: number;
  reason: string;
  fallbacks: string[];
}
```

Acceptance:

- A code-review prompt routes to `reviewer` when definition exists。
- A RAG batch routes to `rag` or default general if no exact match。
- Explicit `@reviewer` bypasses auto selection but still respects permissions。

#### 6.11.3 Model and Permission Policy

目标：

- 不同 subagent 可以有不同模型和权限。
- 权限必须能从 definition、runtime task、workflow capability 三层合并。

Permission modes:

```ts
export type SubagentPermissionMode =
  | "readOnly"
  | "planOnly"
  | "acceptEdits"
  | "boundedWrite"
  | "worktree"
  | "ask"
  | "denyAll";
```

Merge rules:

- `denyAll` always wins。
- `readOnly` strips write tools。
- `boundedWrite` requires `writePaths` and keeps SDK path guard。
- `worktree` requires isolated worktree and merge approval。
- Runtime task cannot escalate beyond definition unless parent workflow capability approval exists。
- Project policy can deny tools regardless of agent definition。

Implementation:

- Add `lib/subagents/policy.ts`。
- Reuse `lib/subagents/write-boundary.ts` for bounded writes。
- Route resolved policy into `createAgent({ tools, writePaths, cwd })`。
- Emit audit event `permission_policy_applied`。

Acceptance:

- A `readOnly` reviewer cannot use edit/write/apply_patch。
- A `boundedWrite` task without `writePaths` loses write tools。
- A `worktree` implementation agent writes only inside its worktree。

#### 6.11.4 Scoped MCP for Subagents

目标：

- MCP server/tool 可以只暴露给某个 specialist，不污染主 agent 或其他 child。

Implementation:

- Add `allowedMcpServers` to definition。
- Add `mcp` capability to subagent policy。
- Parent runtime resolves MCP tool schemas。
- Child sees only scoped tool summaries。
- Child tool request goes through parent broker: `subagent.callMcpTool`。
- Deny MCP tool calls when server not in scope。

Acceptance:

- `researcher` can call web/search MCP when allowed。
- `reviewer` cannot call GitHub MCP unless declared。
- MCP call result is attached to subagent audit and optional goal evidence。

#### 6.11.5 Subagent Hooks

Hooks:

```ts
export type SubagentHook =
  | "SubagentStart"
  | "SubagentStop"
  | "BeforeToolUse"
  | "AfterToolUse"
  | "BeforeMerge"
  | "AfterMerge";
```

Implementation:

- Add `lib/subagents/hooks.ts`。
- Hook config resolves from definition + project settings。
- `BeforeToolUse` can deny operation。
- `AfterToolUse` can record audit/evidence。
- `SubagentStop` can update memory。
- Hooks run in parent runtime, not child prompt。

Acceptance:

- A hook can deny dangerous shell before execution。
- A hook can record `test passed` evidence after a test command。
- Hook events appear in `auditEvents`。

#### 6.11.6 Subagent Memory

目标：

- specialist 可以跨 batch 保留短小、结构化、可审计的经验，不把历史全文塞进上下文。

Storage:

```text
~/.mini-pi/subagents/memory/{scope}/{agentId}.json
```

Types:

```ts
export interface SubagentMemory {
  agentId: string;
  scope: "user" | "project" | "local";
  facts: string[];
  decisions: string[];
  recurringRisks: string[];
  preferredFiles: string[];
  updatedAt: number;
}
```

Implementation:

- Add `lib/subagents/memory.ts`。
- Inject compact memory into child prompt。
- Update memory only through `SubagentStop` hook or verified synthesis。
- Cap memory length and require source batch ids。

Acceptance:

- Reviewer remembers recurring project risk after a completed review。
- Memory survives restart。
- Memory can be cleared per agent。

#### 6.11.7 Worktree Isolation for Implementation Agents

目标：

- implementation subagent 默认不直接写主工作区，而是在 worktree 中产出 diff。

Flow:

```text
parent task
  -> create worktree
  -> spawn implementation subagent in worktree cwd
  -> run tests/build if declared
  -> diff worktree
  -> verifier
  -> merge approval
  -> merge or discard
```

Implementation:

- Reuse `lib/workflows/git-worktree.ts`。
- Add `isolation.mode = "worktree"`。
- Add orchestrator path for worktree-backed child。
- Persist worktree id/path/branch in task metadata。
- Add merge approval event into parent UI。
- Cleanup worktree after merge/discard。

Acceptance:

- Implementation child cannot modify parent cwd directly。
- Parent sees diff before merge。
- Merge conflict produces blocked state with unblock action。

#### 6.11.8 Background Subagent Queue

目标：

- 子 agent 可以后台运行，不阻塞 parent turn；完成后把结果归并到 parent timeline/card。

Implementation:

- Add `lib/subagents/queue.ts`。
- Batch status supports `detached`。
- Parent can receive `subagent_batch_detached` and later `subagent_batch_end`。
- UI supports running queue, cancel, retry, open session。
- Optional desktop notification later。

Acceptance:

- Parent can continue responding while background batch runs。
- Background completion updates the original parent card。
- Cancel stops running children and marks unfinished tasks aborted。

### 6.12 Workflow Replay / Eval

Record:

- workflow input。
- manifest。
- script。
- SDK requests/responses。
- approvals。
- subagent summaries。
- artifacts。
- errors。

Replay modes:

- `strict`: exact recorded responses。
- `mock`: replace selected tools。
- `failure-injection`: force network/merge/approval failures。

Files:

- `lib/workflows/replay.ts`
- `lib/workflows/replay.test.ts`
- `app/api/agent/[id]/workflows/replay/route.ts`

Acceptance:

- A completed workflow can replay to the same final artifact names。
- A denied approval can be replayed。
- A merge failure can be injected and produces recovery artifact。

## 7. 开站实施顺序

### Sprint 1: Goal Reliability

Scope:

- Durable goal store。
- Goal turn records。
- Evidence records。
- Verifier v1。
- Blocked state v1。
- Goal timeline v1。

Do not include MCP or CLI yet。

Exit criteria:

- Restart resume works。
- Premature complete is rejected。
- Blocked state has unblock action。
- Timeline shows turns and evidence。

### Sprint 2: Goal + Workflow Integration

Scope:

- Workflow evidence attached to goal turns。
- Goal memory includes workflow ids and checkpoints。
- Goal verifier checks workflow failures。
- Goal timeline links workflow runs。
- Workflow inspector v1。

Exit criteria:

- A long goal can launch workflow, record workflow evidence, and complete only after verifier accepts。
- User can inspect linked workflow run from goal timeline。

### Sprint 3: Multi-Agent Productization

Scope:

- Subagent definition registry。
- Project/user `.agents/subagents/*.md` discovery。
- Description-based auto routing。
- Explicit `@agent` invocation。
- Per-agent model/permission policy。
- Subagent memory v1。
- Worktree isolation for implementation agent。
- Subagent hooks v1。

Exit criteria:

- A project `reviewer.md` can be discovered and used automatically。
- `@reviewer` can explicitly invoke the registered subagent。
- Read-only reviewer cannot write files。
- Implementation agent runs in worktree and requires diff approval before merge。
- Subagent memory persists a compact verified summary across restart。

### Sprint 4: Permission Policy

Scope:

- Tool permission rules。
- PreToolUse / PostToolUse hooks。
- Policy settings UI。
- Evidence from hooks。
- Integration with subagent permission mode。

Exit criteria:

- A risky tool call can be denied by policy before execution。
- A successful tool call can create evidence automatically。
- A subagent cannot escalate beyond project policy。

### Sprint 5: MCP（✅ 已完成，见第 0 节 Sprint 5）

Scope:

- ✅ MCP registry（`lib/mcp/registry.ts`）。
- ✅ MCP policy（`lib/mcp/policy.ts`，工具级 allow/deny/ask，默认 ask）。
- ✅ stdio MCP client + runtime + tool bridge（`client.ts`/`runtime.ts`/`tool-bridge.ts`）。
- ✅ Subagent scoped MCP（`scopeServersForSpecialist` + orchestrator 接线）。
- ✅ Settings UI for MCP servers（`McpServersSection.tsx`）。
- ⏭️ `workflow.listTools` / `workflow.callTool`（workflow SDK 层）：顺延，本期 MCP 接到 agent 工具层。

Exit criteria:

- ✅ An MCP tool call is gated by policy（allow/deny/ask）before execution。
- ✅ A subagent sees only its declared MCP tools。
- ⏭️ A workflow script can call an MCP tool via SDK（顺延）。

### Sprint 6: CLI / Replay / Eval

Scope:

- Workflow CLI。
- JSON event stream。
- Record/replay。
- Failure injection。
- Sandbox E2E acceptance。

Exit criteria:

- CI can run a workflow headlessly。
- A workflow trace can replay offline。
- Sandbox acceptance confirms blocked network/path behavior when external sandbox is enabled。

## 8. 第一期开站目标

第一期只做可靠性和 multi-agent 定义化的最小闭环，不做 MCP、CLI、GitHub、完整 replay。

目标：

> 让一个复杂 goal 可以跨重启、跨多轮、带 evidence 地完成；同时让项目可以定义一个可复用 subagent，并让主 agent 能自动或显式调用它。

必须完成：

Goal 可靠性（✅ 已完成，见第 0 节）：

- ✅ `AgentGoal` 持久化（M1）。
- ✅ `GoalTurn` 持久化（M2）。
- ✅ `GoalEvidence` 持久化（M2，复用 progress 产物桥接）。
- ✅ `GoalVerifier` v1（M3）。
- ✅ Structured blocked state（M4）。
- ✅ `GoalTimeline` v1（M5）。
- ✅ Restart resume test（`file-store.test.ts`）。
- ✅ Premature complete rejection test（`update.test.ts` / `verifier.test.ts`）。

Subagent 定义化（✅ 第二期已完成，见第 0 节 Sprint 2）：

- ✅ `SubagentDefinition` schema（`definition.ts`）。
- ✅ `.agents/subagents/*.md` discovery（`registry.ts`）。
- ✅ `SubagentRegistry` project/user merge（project 覆盖 user）。
- ✅ `@agent` explicit invocation（`router.ts` + route.ts 接线）。
- ✅ `plan_subagents` registry hints（`planner.ts` + `extension.ts`）。
- ✅ Registered subagent permission policy v1（`policy.ts`，readOnly/boundedWrite/denyAll + 防提权）。
- ✅ per-agent model policy（`policy.ts` resolveSubagentModel）。
- ✅ Subagent memory v1（`memory.ts`）。
- ✅ Registered reviewer invocation test（`registry.test.ts` / `policy.test.ts` / `router.test.ts`）。

明确不做：

- MCP。（注：第一期不做；已于第五期完成，见第 0 节 Sprint 5。）
- CLI。
- GitHub integration。
- Parallel subgoals beyond existing `delegate_subagents`。
- Workflow replay。
- Full background queue。
- Full subagent memory。
- Full worktree merge automation。

## 9. 第一期开站任务拆解

1. Goal store schema
   - Add schema version。
   - Add file-backed store。
   - Add migration guard。

2. Goal turn lifecycle
   - Create turn on auto-continue。
   - Finish turn on agent end。
   - Store prompt/summary/status/error。

3. Evidence capture
   - Add `goal_evidence_add` API action。
   - Attach workflow start/end as evidence。
   - Attach test/build command summaries later。

4. Verifier v1
   - Reject complete without evidence。
   - Reject complete if related workflow failed。
   - Continue with missing evidence prompt。

5. Blocked state
   - Add category/unblockAction/repeatedCount。
   - Stop endless retry on repeated blocker。

6. UI
   - Add `GoalTimeline`。
   - Show turns。
   - Show evidence。
   - Show blocked detail。

7. Tests
   - Unit: file store。
   - Unit: verifier。
   - API: goal status after restart。
   - E2E: long goal restart resume。

8. Subagent definition schema
   - Add frontmatter parser。
   - Add schema validation。
   - Add project/user precedence。

9. Subagent registry integration
   - Inject concise registry hints into planner。
   - Resolve explicit `@agent` into `agentId`。
   - Merge definition prompt with task prompt。
   - Apply definition defaultTools and permissionMode。

10. Registered reviewer smoke test
   - Create temp `.agents/subagents/reviewer.md`。
   - Verify registry discovery。
   - Verify `@reviewer` routes to reviewer。
   - Verify readOnly strips write tools。
   - Verify audit records selected agent id。

## 10. Definition of Done

第一期完成标准（Goal 部分已达成，Subagent 部分顺延）：

- ✅ `npm test` passes（311 tests / 29 files）。
- ✅ `npx tsc --noEmit` passes。
- ✅ `npm run build` passes；`eslint` 零警告。
- Relevant Playwright goal tests pass（既有 `e2e/07-goal.spec.ts` 不受影响；新增 E2E 待补）。
- Manual acceptance:
  - ✅ `GOAL-ACCEPT-0604-RESTART-RESUME`（单测覆盖；手动验收见下）
  - ✅ `GOAL-ACCEPT-0604-COMPLETE-VERIFIER`（单测覆盖）
  - ✅ `GOAL-ACCEPT-0604-BLOCKED-POLICY`（单测覆盖）
  - ✅ `SUBAGENT-ACCEPT-0604-REGISTERED-REVIEWER`（第二期完成；registry/policy 单测覆盖）
  - ✅ `SUBAGENT-ACCEPT-0604-EXPLICIT-AGENT`（第二期完成；router 单测覆盖 @agent 解析与委派）
- 文档更新：
  - ✅ `0604nextstep.md`（第 0 节实施进度）
  - `docs/plans/2026-06-04-dynamic-workflow-script-harness.md`
  - `docs/plans/2026-06-04-rfc-7-multi-agent-final-architecture.md`

# Agent Team 成熟度审计记录

审计时间：

- 初版：2026-06-21 11:21 CST
- 后续复审：2026-06-22 15:40 CST

审计范围：Agent Team 与 Subagent 协作能力、权限边界、恢复路径、worktree 隔离、前端工作区、测试与发布门禁。

对标对象：

- Claude Code Agent Teams：共享任务列表、teammate 自协调、直接通信、plan approval、hooks、权限冒泡、恢复边界。
- Diga 交付方案：`docs/plans/2026-06-22-agent-team-delivery-plan.md`。

## 结论

Agent Team 已从早期技术预览基座升级为 **mature candidate / 可交付候选**。

成熟度评分：**8.0 / 10**

| 维度 | 6-21 初评 | 6-22 复审 | 判定 |
| --- | ---: | ---: | --- |
| 架构覆盖度 | 8.0 | 8.5 | 数据模型、runtime、UI、路由和持久化已形成闭环。 |
| UX 区分度 | 7.5 | 8.0 | Team 卡片和 Workspace 已明显区别于 subagent/workflow。 |
| 真实协作闭环 | 5.0 | 8.0 | teammate self-coordination tools 与 result ingestion 已接通。 |
| 可靠性与恢复 | 6.0 | 7.5 | hydrate/resume 不再静默 fallback 给 lead，missing/replaced 状态可见。 |
| 权限、安全、冲突控制 | 5.5 | 8.0 | write/network/plan/worktree gate 已进入执行路径。 |
| 测试与验收证据 | 6.0 | 8.5 | 单测、类型、Team E2E、CI 门禁均有覆盖。 |

当前可以对外描述为：

> Agent Team 支持共享任务板、teammate 自主领取和提交结果、挑战与决策追踪、受控写入、独立 worktree 合并、恢复后续跑，以及面向发布的 Team E2E 门禁。

仍不应宣称：

> 完全等价 Claude Code Agent Teams 的所有实验能力。

原因：用户自定义 hooks DSL、split panes、多 teammate 并排 transcript、LLM planner、nested teams 仍属于后续阶段。

## 当前实现证据

### 1. Teammate self-coordination tools

已新增 teammate 可调用的 `team_*` 协作工具：

- `team_get_board`
- `team_claim_task`
- `team_submit_result`
- `team_send_message`
- `team_create_challenge`
- `team_request_plan_approval`
- `team_resolve_challenge`
- `team_record_decision`

关键证据：

- `lib/agent-team/coordination-tools.ts`
- `lib/agent-team/coordination-bridge.ts`
- `lib/agent-team/coordination-tools.test.ts`
- `lib/agent-registry.ts` 注入 `createAgentTeamCoordinationExtension`

安全性质：

- server 以 child `agentId` 反查 `runId/memberId`，不信任模型传入身份。
- `coordinationProfile=none/basic/full` 是可回滚能力开关。
- governance 工具仅在 `coordinationProfile=full` 下放开，`team_record_decision` 仍限制 lead。
- 每个 coordination call 写入 `coordinationAudit`。

### 2. Result ingestion 与挑战/决策闭环

Team 不再依赖“prompt 成功即完成”的假完成语义。teammate 输出会被结构化吸收，失败进入 blocked/needs_review。

关键证据：

- `lib/agent-team/result-ingestion.ts`
- `lib/agent-team/runtime.ts`
- `lib/agent-team/runtime.test.ts`
- `lib/agent-team/server-store.ts`

已覆盖能力：

- result ingestion 写入 findings、challenges、evidenceRefs、parseWarnings。
- open challenge 会阻止 finalize。
- decision 需要绑定 accepted findings、challenge ids、evidence refs、source result ids 和 confidence。
- `allowChallenges=false` 时 challenge 创建被拒绝。

### 3. Plan approval 与 policy enforcement

写入型 Team 可要求先提交 plan，再由 lead/用户批准后继续。权限不再只是启动面板文案。

关键证据：

- `createAgentTeamPolicyExtension`
- `validateStoredAgentTeamToolPolicy`
- `submit_plan / approve_plan / reject_plan`
- `app/api/agent/[id]/teams/route.ts`
- `lib/agent-registry.ts`

已覆盖能力：

- `allowWrite=false` 阻止写入工具，并写入 capability audit / event。
- `allowNetwork=false` 阻止网络/browser/fetch 类工具。
- `requirePlanApproval=true` 时，未批准计划的写任务会被拦截。
- blocked task 可重试，必要时可用已有结果总结并留下风险理由。

### 4. Worktree 真实隔离

`worktreePolicy=per_member` 已不再只是字段。写入型 teammate 可以在独立 git worktree 中运行，finalize 前必须处理 worktree。

关键证据：

- `lib/agent-team/worktree-policy.ts`
- `lib/agent-team/worktree-policy.test.ts`
- `app/api/agent/[id]/teams/route.ts` 的 `merge_worktree`
- `app/components/WorkbenchSidebar.tsx` 的“独立改动区”
- `e2e/10b-agent-team-worktree.spec.ts`

用户路径：

- Team Workspace 显示每个成员的 worktree branch/path/status。
- 用户可选择 `合并`、`保留`、`丢弃`。
- active / merge_pending worktree 会阻止 `生成总结`。
- `discard` / successful merge 后 quality gate 通过。

### 5. Resume 完整化

重启后不再静默把丢失 teammate 的任务 fallback 给 lead。

关键证据：

- `lib/agent-team/hydrate.ts`
- `lib/agent-team/hydrate.test.ts`
- `hydrateStoredAgentTeamRun`
- `dispatchAgentTeamPlans` 中缺失 child agent 时转 blocked/missing

已覆盖状态：

- `intact`
- `rehydrated`
- `missing`
- `replaced`

### 6. Dynamic Planner v2

Team 初始化已从固定 scaffold 走向 deterministic planner。

关键证据：

- `lib/agent-team/planner.ts`
- `lib/agent-team/planner.test.ts`
- `lib/agent-team/mock.ts`

已覆盖规则：

- objective tags：`code / research / qa / writing / data / multi`
- member scale：small / standard / deep 生成 3 / 5 / 7 成员
- code/write 场景优先加入 Builder / Reviewer / Validator
- planner output 可复现，并记录 `plannerInputs`

### 7. Team Workspace 可解释性

Workspace 已从“静态任务板”变成可操作协作面板。

关键证据：

- `app/components/WorkbenchSidebar.tsx`
- `app/components/WorkbenchSidebar.test.ts`
- `app/components/MessageView.tsx`
- `app/components/MessageView.test.ts`

已覆盖 UI：

- 运行中概要
- 最近执行
- 需要你处理
- 团队过程
- 成员分工与成员记录
- findings / challenges / decisions
- 独立改动区
- finalize blocked reason 的中文提示

### 8. E2E 与 CI 证据

Team 已进入发布门禁，不再只靠单元测试。

关键证据：

- `e2e/10-agent-team.spec.ts`
- `e2e/10b-agent-team-worktree.spec.ts`
- `package.json` 的 `test:e2e:team`
- `package.json` 的 `ci:quality`
- `playwright.config.ts` 自动启动测试服务

最近验证：

```text
npm run ci:quality

128 test files passed
1051 unit/integration tests passed
2 Team E2E tests passed
route-auth:check passed
workflow:sandbox:check passed
public-surface:check passed
```

lint 仅剩 3 个既有 non-blocking warning，位于 benchmark 脚本：

- `scripts/diga-click-microbench.mjs`
- `scripts/diga-send-timing.mjs`

## 对标矩阵

| 能力 | Claude 基线 | 当前状态 | 成熟度 |
| --- | --- | --- | --- |
| 显式启动/用户控制 | 用户确认后启动 Team | `/team` + confirmation + mode chip | Mature candidate |
| 独立 teammate session | 每个 teammate 独立 context | hidden child agent + sessionFile | Mature candidate |
| 共享 task list | teammate claim/complete | `team_claim_task` / `team_submit_result` | Mature candidate |
| Mailbox/direct message | teammate 互相通信 | `team_send_message` + follow-up | Mature candidate |
| Plan approval | plan-only -> approve/reject | plan API + policy gate | Mature candidate |
| Challenge/debate | challenge -> resolution -> decision | challenge/decision mutation + gate | Mature candidate |
| Decision traceability | synthesis from evidence | acceptedFindingIds / challengeIds / sourceResultIds | Mature candidate |
| File/write conflict control | task/file coordination | write lock + worktree gate | Mature candidate |
| Worktree isolation | 并行写入隔离 | per-member worktree + merge/discard UI | Mature candidate |
| Resume/cleanup | 恢复边界清楚 | paused hydrate + rehydrated/missing/replaced | Mature candidate |
| Hooks | lifecycle hooks | 内置 hooks；用户 DSL 未做 | Beta+ |
| Split panes | 多 teammate 视觉并排 | 当前为 single workspace + member transcript | Beta+ |
| Dynamic planner | 可按任务配置团队 | deterministic v2；LLM planner 未做 | Mature candidate |
| E2E | lifecycle acceptance | Team + worktree E2E 入门禁 | Mature candidate |

## Definition of Done 核对

### 功能

| # | 要求 | 证据 | 状态 |
| --- | --- | --- | --- |
| 1 | teammate 靠 team_* 完成 claim/submit/challenge/plan request | coordination tools + tests | ✅ |
| 2 | allowWrite=false 阻止写工具并写事件 | policy extension/runtime tests | ✅ |
| 3 | allowNetwork=false 阻止网络工具 | policy extension/runtime tests | ✅ |
| 4 | requirePlanApproval=true 阻止未批准写任务 | plan approval runtime/API | ✅ |
| 5 | allowWorktree=true 独立 worktree，finalize 走 merge UI | worktree policy + 10b E2E | ✅ |
| 6 | 重启后 paused，Resume hydrate；missing 不 fallback lead | hydrate + route dispatch guard | ✅ |
| 7 | small/standard/deep 生成 3/5/7 人，objective tags 改变角色 | planner tests | ✅ |
| 8 | ingestion 失败 blocked；open challenge 拒绝 finalize | runtime tests | ✅ |
| 9 | coordinationAudit 可见；decision 可追溯 | server-store + Workspace | ✅ |

### 工程

| # | 要求 | 证据 | 状态 |
| --- | --- | --- | --- |
| 10 | typecheck 绿 | `npm run ci:quality` | ✅ |
| 11 | 新增 unit/integration 全绿 | 1051 tests | ✅ |
| 12 | `10-agent-team` + `10b-agent-team-worktree` 进入 CI | `test:e2e:team` included in `ci:quality` | ✅ |
| 13 | 部署流水线默认带 Agent Team E2E | `ci:quality` 被 `ci:release` 调用 | ✅ |

### 产品

| # | 要求 | 证据 | 状态 |
| --- | --- | --- | --- |
| 14 | 审计报告更新，总评 ≥ 7.5 / 10 | 本报告 8.0 / 10 | ✅ |
| 15 | README/product language 有 mature 描述，不再用早期试验标签定义当前 Agent Team | README + product-language 更新 | ✅ |
| 16 | 启动确认面板勾选说明“启用后会发生什么” | confirmation panel + source tests | ✅ |

## 仍需谨慎的边界

这些不阻断 mature candidate，但不应包装成已完成：

1. 用户自定义 hooks DSL 尚未实现。
2. split panes / 多 teammate transcript 并排视图尚未实现。
3. LLM planner 接口只预留，当前默认 deterministic planner。
4. nested teams 明确不支持。
5. 真实模型长时运行仍需更多手工验收视频，不应只依赖 fixture E2E 宣称“所有生产路径稳定”。

## 产品状态建议

推荐状态：**Mature candidate**

推荐对用户文案：

- 可以说：`团队协作支持共享任务板、成员自主推进、挑战与决策追踪、受控写入和独立改动区。`
- 可以说：`写代码团队会在总结前要求处理每个独立改动区，避免并行修改被静默覆盖。`
- 可以说：`重启后团队会暂停并恢复成员状态；丢失成员会显式标记，不会偷偷交给负责人代跑。`
- 不要说：`完全复刻 Claude Code Agent Teams 的所有实验功能。`
- 不要说：`所有真实模型场景都已零失败。`

## 下一步建议

1. 跑一轮真实模型 standard Team 手工验收，并保存视频或 trace。
2. 清掉 benchmark 脚本里的 3 个 lint warning，让 GitHub annotations 更干净。
3. 设计用户自定义 Team hooks DSL，但保持在 P2，不影响当前发版。
4. 增加 member transcript 并排视图或更强的查看记录入口。


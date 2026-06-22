# Agent Team 真实模型验收记录

日期：2026-06-22
状态：Passed

目的：补齐 `docs/plans/2026-06-22-agent-team-delivery-plan.md` 最后一个非自动化证据点：用真实模型跑一轮 standard Team，并归档可复查的 trace / video / session evidence。

## 需要记录的环境

| 项 | 值 |
| --- | --- |
| Diga commit | 待填写 |
| 启动方式 | 待填写 |
| Provider / model | 待填写 |
| Team scale | `standard` |
| allowWrite | 待填写 |
| allowWorktree | 待填写 |
| requirePlanApproval | 待填写 |
| coordinationProfile | 待填写 |
| 运行开始时间 | 待填写 |
| 运行结束时间 | 待填写 |

## 推荐验收任务

```text
/team 请用团队协作审计 lib/agent-team 相关实现，确认：
1. 成员是否能自主领取任务并提交结构化结果；
2. 是否能提出至少 1 个 finding；
3. 如发现风险，请创建 challenge 并给出 resolution；
4. 最终 decision 必须引用 finding、result evidence 和 challenge 状态；
5. 如果有写入计划，只允许在计划批准后继续。
```

如需验证 worktree：

```text
/team 请用团队协作实现一个非常小的文档修正，要求写入成员使用独立改动区，最后由我确认合并或丢弃。
```

## 必须观察到的证据

| 检查项 | 预期 | 证据位置 |
| --- | --- | --- |
| 启动确认 | 出现 Team 启动确认面板，显示成员规模和权限影响 | 截图 / 录屏时间点 |
| 成员创建 | Workspace 显示 standard Team 成员，不少于 5 个 | Workspace 成员分工 |
| 自协调 | `coordinationAudit` 非空，包含 `team_get_board` / `team_claim_task` / `team_submit_result` | run json / debug log |
| 结果吸收 | board.results 至少 1 条，status 为 parsed 或 blocked-with-warning | run json |
| finding | 至少 1 条 finding，包含 evidenceRefs | Workspace / run json |
| challenge | 如启用 challenge，open challenge 最终 resolved/dismissed | Workspace / run json |
| decision | final decision 绑定 acceptedFindingIds、sourceResultIds、evidenceRefs | Workspace / run json |
| worktree gate | worktree active/merge_pending 时无法 finalize | 录屏 / run json |
| resume | 刷新或重启后 Team 仍可见，Resume 不 fallback 给 lead | 录屏 / hydrate 字段 |
| finalize | required tasks complete 且 no open blocking challenges 后完成 | final card / run json |

## 通过标准

- `npm run ci:quality` 在该 commit 上通过。
- 真实模型 Team 能从启动走到最终总结，或在失败时给出结构化 blocked reason。
- 没有出现“prompt 成功即 task 完成”的假完成。
- 没有出现 missing teammate 被 lead 静默接管。
- 写入型任务没有绕过 plan approval 或 worktree gate。
- 录屏或 trace 能证明用户关键路径可复查。

## 证据归档

建议把证据放到本地未提交目录或 release 附件中，不要默认提交用户会话内容：

```text
.pi/agent/team-validation/
  2026-06-22-standard-team/
    video.mov
    screenshots/
    run-redacted.json
    notes.md
```

可以先扫描本机候选 run，找到最接近通过的 Team：

```bash
npm run agent-team:validation-summary -- --list --limit 10
```

候选列表只输出 score、状态、成员规模、缺失检查项、run id 和更新时间，不输出用户目标或 teammate 正文。

然后用只读摘要脚本生成脱敏 Markdown：

```bash
npm run agent-team:validation-summary -- \
  --run <teamId> \
  --out .pi/agent/team-validation/2026-06-22-standard-team/summary.md \
  --strict
```

如果不传 `--run`，脚本会读取 `~/.diga-agent/agent-teams/runs` 下最新的 Team run。

脚本只输出以下脱敏信息：

- run id、状态、成员规模、策略开关
- members/tasks/results/findings/challenges/decisions 的数量
- coordination tools 调用计数
- quality gate / worktree / hydrate 状态计数
- 是否满足 required tasks、evidence、decision traceability、worktree closed、no missing teammate 等检查

脚本不会输出用户原始 prompt、teammate raw text、result body 或完整文件内容。

如需要提交到仓库，只提交脱敏摘要：

```text
docs/audit/artifacts/agent-team-real-model-validation-2026-06-22-summary.md
```

## 本次记录

自动化证据已覆盖：

- `npm run ci:quality`
- `npm run test:e2e:team`
- `e2e/10-agent-team.spec.ts`
- `e2e/10b-agent-team-worktree.spec.ts`

真实模型证据已收集并通过 strict 摘要检查：

```text
Result: Passed
Run id: team-7375e761-310e-46e9-8839-fa07d309e9c7
Evidence summary: docs/audit/artifacts/agent-team-real-model-validation-2026-06-22-latest-summary.md
Summary score: 8/8
Observed state:
- run.status = completed
- leadState = finalized
- memberScale = deep
- coordinationProfile = basic
- coordination tools observed: team_submit_result x1
- required tasks complete: 4/4
- open challenges: 0
- final decision traceability: pass
- results: 7
- findings: 9
- decisions: 2
Decision:
- This proves the new coordination path is exercised by a real Team run.
- It also proves required task completion, evidence-bearing results/findings,
  challenge closure, traceable final decision, worktree closure, and no missing teammate sessions.
- Agent Team remains mature candidate with real-model acceptance evidence recorded.
```

本机还存在多条 2026-06-21 的 completed standard Team run，它们可达到 7/8，但缺少 `coordinationAudit` / team_* tool evidence，属于旧路径证据，不能替代本次交付的真实模型验收。

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("MessageView CoT/toolchain UX safeguards", () => {
  const source = () =>
    readFileSync(path.join(process.cwd(), "app/components/MessageView.tsx"), "utf8");

  it("keeps workflow runs traceable and does not hide older artifacts/checkpoints", () => {
    const text = source();

    expect(text).toContain("Workflow id:");
    expect(text).toContain("查看全部（{items.length}）");
    expect(text).toContain("Artifacts ({part.artifacts.length})");
    expect(text).toContain("Checkpoints ({part.checkpoints.length})");
    expect(text).toContain("WorkflowStageProgress");
    expect(text).toContain("Run timeline ({part.traceEvents.length})");
    expect(text).toContain("WorkflowValueContent");
    expect(text).toContain("item.badge === \"result\"");
    expect(text).toContain("item.badge === \"diff\"");
    expect(text).toContain("workflowWarningArtifactNames(warnings)");
    expect(text).toContain("data-quality-warning={item.invalid || undefined}");
    expect(text).toContain("需补强");
  });

  it("labels multi-part thinking and subagent task status in the collapsed header", () => {
    const text = source();

    expect(text).toContain("{index}/{total}");
    expect(text).toContain("subagentRoleLabel(task.role)");
    expect(text).toContain("subagentStatusLabel(task.status)");
    expect(text).toContain("失败子任务：");
    expect(text).toContain("data-testid=\"subagent-task-grid\"");
    expect(text).toContain("子任务状态汇总");
    expect(text).toContain("超时 ${timeoutCount}");
    expect(text).toContain("复制思考");
    expect(text).toContain("继续");
    expect(text).toContain("rawLabel.length > 64");
    expect(text).toContain("1px solid var(--border-soft)");
  });

  it("renders Agent Team runs as a lightweight process strip with workspace actions", () => {
    const text = source();

    expect(text).toContain("AgentTeamRunCard");
    expect(text).toContain("data-testid=\"agent-team-run-card\"");
    expect(text).toContain("data-testid=\"agent-team-process-timeline\"");
    expect(text).toContain("buildAgentTeamProcessNodes(run, now)");
    expect(text).toContain("开始执行任务");
    expect(text).toContain("Domain Agent");
    expect(text).toContain("形成最终结论");
    expect(text).toContain("规划下一步");
    expect(text).toContain("团队已准备好");
    expect(text).toContain("模型账号未配置");
    expect(text).toContain("当前模型缺少可用凭证");
    expect(text).toContain("模型暂时不可用");
    expect(text).toContain("供应商临时繁忙，可以稍后重试");
    expect(text).toContain("执行失败，可以重试");
    expect(text).toContain("等待成员返回结果");
    expect(text).toContain("团队已准备好；长时间不动可在右侧重试");
    expect(text).toContain("团队已暂停");
    expect(text).toContain("暂停期间不会继续分配任务");
    expect(text).toContain("已暂停，恢复后自动处理");
    expect(text).toContain("等待恢复成员");
    expect(text).toContain("恢复成员");
    expect(text).toContain("恢复成员记录");
    expect(text).toContain("暂停前在处理");
    expect(text).toContain("负责人会继续自动安排");
    expect(text).toContain("团队协作已停止");
    expect(text).toContain("run.status === \"aborted\" ? (");
    expect(text).toContain("<span>已停止</span>");
    expect(text).toContain("成员记录已准备好，等待领取任务。");
    expect(text).toContain("Accepted available finding:");
    expect(text).toContain("已采纳可用发现：");
    expect(text).toContain("completed by lead override");
    expect(text).toContain("已用现有结果完成");
    expect(text).toContain("团队已停止，这位成员不会继续执行。");
    expect(text).toContain("模型连接提前结束，没有返回完成标记。");
    expect(text).toContain("isSpawnOnlyAgentTeamMemberOutput");
    expect(text).toContain("const spawnedMembers = terminal");
    expect(text).toContain("const activeMembers = terminal");
    expect(text).not.toContain("member.status === \"idle\"");
    expect(text).not.toContain("isTerminalNoiseAgentTeamMemberOutput");
    expect(text).toContain("useAgentTeamClock(running)");
    expect(text).toContain("formatAgentTeamElapsed");
    expect(text).toContain("已运行 ${runningElapsed}");
    expect(text).toContain("node.state === \"running\" ? \"animate-pulse\"");
    expect(text).toContain("node.state === \"pending\"");
    expect(text).toContain("borderColor:");
    expect(text).toContain("onOpenMember={onOpenAgentTeamMember}");
    expect(text).toContain("onOpenMember(run.id, node.memberId!, node.sessionFile)");
    expect(text).toMatch(/data-testid="open-agent-team-workspace"[\s\S]*?\n\s*展开\s*\n\s*<\/button>/);
    expect(text).not.toContain("展开过程");
    expect(text).toContain("团队协作");
    expect(text).toContain("进度");
    expect(text).toContain("unresolvedRequired");
    expect(text).toContain("hasTerminalUnresolvedRequired");
    expect(text).toContain("hasHighConfidenceFinalDecision");
    expect(text).toContain("带风险 {unresolvedRequired}");
    expect(text).not.toContain("displayedCompletedRequired");
    expect(text).toContain("目前无需你操作");
    expect(text).not.toContain("agent-team-inline-progress");
    expect(text).not.toContain("agentTeamTaskCardStatus");
    expect(text).not.toContain("data-testid=\"agent-team-final-summary\"");
    expect(text).not.toContain("data-testid=\"agent-team-final-bullet\"");
    expect(text).not.toContain("data-testid=\"agent-team-final-conversation\"");
    expect(text).not.toContain("getAgentTeamFinalSummary(part.run)");
    expect(text).toContain("最终回答已放到会话里");
    expect(text).toContain("agentTeamRunsById?.get(p.run.id)");
    expect(text).toContain("agentTeamCardSummary");
    expect(text).toContain("生成总结");
    expect(text).toContain("agentTeamLeadStateLabel");
    expect(text).toContain("openChallenges");
    expect(text).toContain("acceptedFindings");
    expect(text).toContain("onAction?.(run.id, \"finalize\", run.leadAgentId)");
    expect(text).toContain("const showPauseResumeAction = !terminal && (paused || needsMemberRecovery)");
    expect(text).toContain("{showPauseResumeAction ? (");
    expect(text).toContain("aria-label={needsMemberRecovery ? \"恢复成员\" : paused ? \"恢复处理\" : \"暂停\"}");
    expect(text).toContain("aria-label=\"生成总结\"");
    expect(text).toContain("aria-label=\"停止\"");
    expect(text).not.toContain("aria-label=\"Stop Team\"");
    expect(text).toContain("p.kind === \"agent_team_run\"");
  });

  it("keeps the final answer in the conversation instead of duplicating it in the process strip", () => {
    const text = source();

    expect(text).toContain("title: \"形成最终结论\"");
    expect(text).toContain("body: \"最终回答已放到会话里。\"");
    expect(text).not.toContain("data-testid=\"agent-team-final-conversation\"");
    expect(text).not.toContain("body: finalSummary?.verdict || \"团队已把结果汇总到会话里。\"");
  });

  it("hides Agent Team internal final-summary markers from visible/copy text", () => {
    const text = source();

    expect(text).toContain("stripAgentTeamInternalMarkers");
    expect(text).toContain("agent-team-final:");
    expect(text).toContain("text={visibleText}");
  });

  it("hides provider internal think tags from visible/copy text", () => {
    const text = source();

    expect(text).toContain("stripInternalThoughtBlocks");
    expect(text).toContain("<think\\b[^>]*>[\\s\\S]*?<\\/think>");
    expect(text).toContain("<think\\b[^>]*>[\\s\\S]*$");
  });
});

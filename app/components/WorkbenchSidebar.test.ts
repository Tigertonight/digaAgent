import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { BrowserSnapshot } from "@/lib/browser/types";
import type { AgentProgress } from "@/lib/progress/types";
import {
  describeBrowserStatus,
  loadStoredWorkbenchTabs,
  normalizedGroups,
  summarizeProgress,
  tabFromView,
  upsertWorkbenchTab,
  viewFromTab,
  type WorkbenchView,
} from "./WorkbenchSidebar";

function progressFixture(): AgentProgress {
  return {
    updatedAt: 100,
    artifacts: [],
    steps: [],
    groups: [
      {
        id: "g1",
        index: 1,
        startedAt: 1,
        steps: [
          { id: "scan", title: "Scan", status: "completed" },
          { id: "audit-a", title: "Audit A", status: "completed" },
        ],
      },
      {
        id: "g2",
        index: 2,
        startedAt: 2,
        steps: [
          { id: "audit-b", title: "Audit B", status: "running" },
          { id: "report", title: "Report", status: "pending" },
        ],
      },
    ],
  };
}

function browserFixture(status: BrowserSnapshot["status"]): BrowserSnapshot {
  return {
    status,
    url: null,
    title: null,
    screenshotDataUrl: null,
    updatedAt: null,
    error: null,
    pointer: null,
    task: null,
    logs: [],
    steps: [],
    activeTabId: null,
    tabs: [],
    annotations: [],
  };
}

describe("Workbench overview model", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    const localStorageStub = {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };
    vi.stubGlobal("localStorage", localStorageStub);
    vi.stubGlobal("window", {
      localStorage: localStorageStub,
      location: { href: "http://localhost/", origin: "http://localhost" },
    });
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("summarizes progress across all groups while naming the current group", () => {
    const summary = summarizeProgress(progressFixture());

    expect(summary.badge).toBe("2/4");
    expect(summary.primary).toBe("Audit B");
    expect(summary.secondary).toContain("全部 2/4");
    expect(summary.secondary).toContain("当前组 2 0/2");
    expect(summary.tone).toBe("running");
  });

  it("normalizes legacy progress steps into a single group", () => {
    const groups = normalizedGroups({
      updatedAt: 100,
      artifacts: [],
      groups: [],
      steps: [{ id: "legacy", title: "Legacy", status: "completed" }],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("legacy");
    expect(groups[0]?.steps[0]?.title).toBe("Legacy");
  });

  it("keeps ready browser as ready status without implying page content", () => {
    const ready = describeBrowserStatus(browserFixture("ready"));

    expect(ready.short).toBe("ready");
    expect(ready.title).toBe("浏览器已就绪");
  });

  it("round-trips workbench overview/home tabs", () => {
    const views: WorkbenchView[] = [
      { type: "overview" },
      { type: "progress" },
      { type: "outputs" },
      { type: "files", path: "/tmp/a.txt" },
      { type: "context" },
      { type: "browser", url: "https://example.com" },
      { type: "team", teamId: "team-1" },
    ];

    for (const view of views) {
      expect(viewFromTab(tabFromView(view))).toEqual(view);
    }
  });

  it("keeps exactly one home tab when loading or upserting tabs", () => {
    const key = "workbench-test-tabs";
    localStorage.setItem(
      key,
      JSON.stringify({
        activeTabId: "home",
        tabs: [
          { id: "home", kind: "home", title: "概览", closable: false },
          { id: "progress", kind: "progress", title: "进度", closable: true },
        ],
      })
    );

    const stored = loadStoredWorkbenchTabs(key);
    expect(stored.tabs.filter((tab) => tab.id === "home")).toHaveLength(1);
    expect(upsertWorkbenchTab(stored.tabs, tabFromView({ type: "overview" })).filter((tab) => tab.id === "home")).toHaveLength(1);
  });

  it("falls back to home when stored tab JSON is corrupt", () => {
    const key = "workbench-bad-tabs";
    localStorage.setItem(key, "{bad json");

    expect(loadStoredWorkbenchTabs(key)).toEqual({
      tabs: [tabFromView({ type: "overview" })],
      activeTabId: "home",
    });
  });

  it("restores stored Team workspace tabs with their parent run id", () => {
    const key = "workbench-team-tabs";
    localStorage.setItem(
      key,
      JSON.stringify({
        activeTabId: "team:team-restore",
        tabs: [
          { id: "home", kind: "home", title: "概览", closable: false },
          {
            id: "team:team-restore",
            kind: "team",
            title: "Team",
            closable: true,
            teamId: "team-restore",
          },
        ],
      })
    );

    const stored = loadStoredWorkbenchTabs(key);
    expect(stored.activeTabId).toBe("team:team-restore");
    expect(viewFromTab(stored.tabs[1])).toEqual({
      type: "team",
      teamId: "team-restore",
    });
  });

  it("keeps Agent Team simple by default while preserving advanced controls", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/components/WorkbenchSidebar.tsx"),
      "utf8"
    );

    expect(source).toContain("团队协作");
    expect(source).not.toContain("agent-team-workspace-final-summary");
    expect(source).toContain("buildTerminalTeamRiskNotes");
    expect(source).toContain("if (run.status === \"aborted\") return [];");
    expect(source).toContain("run.status === \"aborted\" ? (");
    expect(source).toContain("风险提示");
    expect(source).toContain("成员执行中断");
    expect(source).toContain("member:${member.id}:provider-error");
    expect(source).toContain("风险原因：");
    expect(source).toContain("备注：");
    expect(source).toContain("diagnostic:${reason.code}");
    expect(source).toContain("建议：${reason.recommendedAction}");
    expect(source).toContain("if (!hasHighConfidenceFinalDecision)");
    expect(source).toContain("displayedCompletedRequiredCount");
    expect(source).toContain("关键任务 {displayedCompletedRequiredCount}/{requiredTasks.length}");
    expect(source).toContain("unresolvedRequiredCount");
    expect(source).toContain("hasHighConfidenceFinalDecision");
    expect(source).toContain("terminalUnresolvedRequiredCount");
    expect(source).toContain("hasHighConfidenceTerminalShortcut");
    expect(source).toContain("带风险 {terminalUnresolvedRequiredCount}");
    expect(source).toContain("isTerminalShortcutNoiseEvent");
    expect(source).not.toContain("rawCompletedRequiredCount");
    expect(source).not.toContain("run.status === \"completed\" ? requiredTasks.length");
    expect(source).toContain("attentionLabel");
    expect(source).toContain("可选处理");
    expect(source).toContain("团队状态");
    expect(source).toContain("下一步：{nextStepLine}");
    expect(source).not.toContain("团队现在在做什么");
    expect(source).not.toContain("接下来团队会做什么");
    expect(source).toContain("需要确认");
    expect(source).toContain("attentionItems.length > 0 ? (");
    expect(source).toContain("riskNotes.length > 0 ? (");
    expect(source).toContain("teamBlockReasonTitle");
    expect(source).not.toContain("团队过程");
    expect(source).toContain('{detailsOpen ? "收起" : "展开"}');
    expect(source).toContain("detailsOpen");
    expect(source).toContain("revealTeamItem");
    expect(source).toContain("data-agent-team-item");
    expect(source).toContain("deriveTeamAutomationSummary");
    expect(source).toContain("deriveTeamAutomationSummary(run, now)");
    expect(source).toContain("useAgentTeamClock(Boolean(run && (run.status === \"running\" || run.status === \"finalizing\")))");
    expect(source).toContain("已运行 ${elapsed}");
    expect(source).toContain("团队已暂停");
    expect(source).toContain("暂停期间不会分配新任务");
    expect(source).toContain("恢复后会继续自动处理");
    expect(source).toContain("点击“恢复成员”后，恢复成功会继续处理");
    expect(source).toContain("deriveTeamNextStepLine");
    expect(source).toContain("buildTeamAttentionItems");
    expect(source).toContain("最近：{recentEventLine}");
    expect(source).toContain("buildRecentTeamEventItems(");
    expect(source).toContain("hasHighConfidenceTerminalShortcut && isTerminalShortcutNoiseEvent(event)");
    expect(source).toContain(").slice(0, 5)");
    expect(source).toContain("events.filter(isVisibleRecentTeamEvent).reverse()");
    expect(source).toContain("isVisibleRecentTeamEvent");
    expect(source).toContain("event.type === \"team_created\"");
    expect(source).toContain("event.type === \"task_created\"");
    expect(source).toContain("event.type === \"member_status_changed\"");
    expect(source).toContain("event.type === \"file_lock_acquired\"");
    expect(source).toContain("event.type === \"file_lock_released\"");
    expect(source).toContain("actorName && taskName");
    expect(source).toContain("已领取「${taskName}」。");
    expect(source).toContain("target ? teamMemberDisplayName(target) : \"成员\"");
    expect(source).toContain("的记录已准备好。");
    expect(source).toContain("团队已准备好");
    expect(source).toContain("你不用手动认领或点击推进");
    expect(source).not.toContain("继续自动分配");
    expect(source).toContain("pendingTeamTasks.length > 0");
    expect(source).toContain("blockedTasks.length > 0");
    expect(source).toContain("正常情况下不需要你手动推进");
    expect(source).toContain("member_spawned_group");
    expect(source).toContain("已准备 ${item.count} 个成员记录");
    expect(source).toContain("event.targetAgentId");
    expect(source).toContain("后续会自动安排任务");
    expect(source).toContain("const seen = new Set<string>();");
    expect(source).toContain("humanizeTeamText(item.event.message).toLowerCase()");
    expect(source).toContain("任务流");
    expect(source).toContain("这里记录团队怎么推进；平时不用看，排查时再展开。");
    expect(source).toContain("flex: `0 0 ${panelWidth}px`");
    expect(source).toContain("minWidth: open ? Math.min(minWidth, panelWidth) : 0");
    expect(source).toContain("flex min-w-0 flex-wrap items-start gap-2");
    expect(source).toContain("ml-7 shrink-0 sm:ml-auto");
    expect(source).toContain("最近动作");
    expect(source).toContain("expandedTaskDescriptions");
    expect(source).toContain("line-clamp-2");
    expect(source).not.toContain("诊断与门禁");
    expect(source).not.toContain("agent-team-diagnostics-toggle");
    expect(source).not.toContain("title=\"完整事件流\"");
    expect(source).not.toContain("title=\"任务清单\"");
    expect(source).not.toContain("诊断详情");
    expect(source).not.toContain("title=\"最近执行\"");
    expect(source).toContain("teamEventUserText");
    expect(source).toContain("humanizeTeamText(event.message)");
    expect(source).toContain("所有检查已通过，团队已完成总结。");
    expect(source).toContain("最终总结暂未通过检查。");
    expect(source).toContain("claimed (.+?)");
    expect(source).toContain("已重新派成员接替 $1。");
    expect(source).toContain("Accepted available finding:");
    expect(source).toContain("已采纳可用发现：");
    expect(source).toContain("completed by lead override");
    expect(source).toContain("已用现有结果完成");
    expect(source).toContain("成员分工");
    expect(source).toContain("agent-team-member-chip");
    expect(source).toContain("看看有哪些成员参与；点击名字可以打开它的记录。");
    expect(source).toContain("teamMemberRecordSummary(activeTranscriptMember, run.status)");
    expect(source).toContain("activeTranscriptMember.latestOutput && run.status !== \"completed\"");
    expect(source).toContain("run.status !== \"completed\" ? (");
    expect(source).toContain("团队已完成；这里保留成员记录，方便需要时回看。");
    expect(source).toContain("独立改动区");
    expect(source).toContain("type: \"merge_worktree\"");
    expect(source).toContain("strategy: \"accept\"");
    expect(source).toContain("strategy: \"discard\"");
    expect(source).toContain("strategy: \"keep_branch\"");
    expect(source).toContain("agent-team-worktree-item");
    expect(source).not.toContain("模型判断");
    expect(source).not.toContain("title=\"最终综合\"");
    expect(source).not.toContain("CheckDecisionIcon");
    expect(source).not.toContain("Claude Parity");
    expect(source).not.toContain("TEAM_RESULT_JSON");
    expect(source).not.toContain("Run batch");
    expect(source).not.toContain("Auto run");
    expect(source).toContain("type: \"claim_task\"");
    expect(source).toContain("type: \"complete_task\"");
    expect(source).toContain("type: \"send_message\"");
    expect(source).toContain("type: \"follow_up_member\"");
    expect(source).toContain("type: \"promote_member\"");
    expect(source).toContain("type: \"retry_task\"");
    expect(source).toContain("type: \"recover_team\"");
    expect(source).toContain("type: \"manual_submit_finding\"");
    expect(source).toContain("type: \"finalize_with_risks\"");
    expect(source).toContain("type: \"skip_task_with_reason\"");
    expect(source).toContain("type: \"replace_member\"");
    expect(source).toContain("type: \"run_next\"");
    expect(source).toContain("type: \"run_until_idle\"");
    expect(source).toContain("重试自动处理");
    expect(source).toContain("用现有结果总结");
    expect(source).toContain("跳过并总结");
    expect(source).toContain("type: \"summarize_available\"");
    expect(source).toContain("处理需要确认的事");
    expect(source).toContain("isEmptyRiskChallenge");
    expect(source).toContain("模型暂时不可用");
    expect(source).toContain("成员模型调用失败，通常是供应商临时繁忙");
    expect(source).toContain("模型账号未配置");
    expect(source).toContain("当前模型缺少可用凭证");
    expect(source).toContain("请切换到已授权模型，或完成授权后再重试。");
    expect(source).toContain("pausedProviderAuthFailure");
    expect(source).toContain("需要处理 ${attentionItems.length}");
    expect(source).toContain("执行失败，可以重试");
    expect(source).toContain("团队会自动处理");
    expect(source).toContain("自动处理");
    expect(source).toContain("点击名字可以打开它的记录");
    expect(source).toContain("待分配");
    expect(source).toContain("visibleTasks");
    expect(source).toContain("已纳入最终结论");
    expect(source).toContain("teamTaskOwnerLine");
    expect(source).toContain("需恢复");
    expect(source).toContain("runStatus === \"completed\"");
    expect(source).toContain("已记录风险");
    expect(source).toContain("teamMemberStatusTone");
    expect(source).toContain("teamTaskStatusTone");
    expect(source).not.toContain("待安排");
    expect(source).not.toContain("待认领");
    expect(source).not.toContain(">认领<");
    expect(source).not.toContain("标记完成");
    expect(source).toContain("revealMemberTranscript(member.id)");
    expect(source).toContain("member-transcript:${memberId}");
    expect(source).toContain("agent-team-member-transcript-detail");
    expect(source).toContain("recordOpenNotice");
    expect(source).toContain("完整记录暂时不在会话列表里；已停留在这里展示成员摘要。");
    expect(source).toContain("agent-team-member-record-notice");
    expect(source).toContain("memberId: view.memberId");
    expect(source).toContain("memberId={activeTab.memberId}");
    expect(source).toContain("const hasRequestedMember = Boolean");
    expect(source).toContain("queueMicrotask(() => revealMemberTranscript(memberId));");
    expect(source).toContain("if (activeTab.kind !== \"team\") return;");
    expect(source).toContain("agentTeamRuns.some((run) => run.id === activeTab.teamId)");
    expect(source).toContain("currentTabs.filter((tab) => tab.id !== activeTab.id)");
    expect(source).not.toContain("固定到侧栏");
    expect(source).toContain("让模型重试");
    expect(source).toContain("自动整理");
    expect(source).toContain("人工补充发现");
    expect(source).toContain("用现有结果总结");
    expect(source).not.toContain(">换人<");
    expect(source).not.toContain("发送追问");
    expect(source).not.toContain("Send follow-up");
    expect(source).toContain("告诉整个团队");
    expect(source).toContain("发送给团队");
    expect(source).toContain("humanizeTeamText(activeTranscriptMember.latestOutput)");
    expect(source).toContain("模型连接提前结束，没有返回完成标记。");
  });

  it("starts Agent Team directly from the composer without a blocking confirmation panel", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/ChatApp.tsx"),
      "utf8"
    );
    const routeSource = readFileSync(
      path.join(process.cwd(), "app/api/agent/[id]/teams/route.ts"),
      "utf8"
    );
    const autoKickSource = readFileSync(
      path.join(process.cwd(), "lib/agent-team/auto-kick.ts"),
      "utf8"
    );

    expect(source).toContain("maxWidth: workbenchOpen");
    expect(source).toContain("sidebarWidth + SPLITTER_WIDTH + filesContainerWidth");
    expect(source).toContain("requestTeamLaunch");
    expect(routeSource).toContain("persistAgentTeamStartInSession");
    expect(routeSource).toContain("DEFAULT_AGENT_TEAM_UNTIL_IDLE_ROUNDS");
    expect(routeSource).toContain("DEFAULT_AGENT_TEAM_BATCH_DISPATCHES");
    expect(routeSource).toContain('type === "merge_worktree"');
    expect(routeSource).toContain("mergeStoredAgentTeamWorktree");
    expect(routeSource).toContain("flushAgentTeamSessionFile");
    expect(routeSource).toContain("appendAgentTeamSessionMessage");
    expect(routeSource).toContain("sessionManager.appendMessage?.");
    expect(routeSource).toContain("rec.session.setSessionName?.");
    expect(routeSource).toContain("sessionManager._rewriteFile?.()");
    expect(routeSource).toContain("let finalRun = getAgentTeamRun(teamId) ?? latestRun;");
    expect(routeSource).toContain("maybeCompleteNamedFileReviewTeamRun(");
    expect(routeSource).toContain("finalRun = namedReview.run;");
    expect(routeSource).toContain("persistAgentTeamFinalSummaryInSession(rec, finalRun);");
    expect(routeSource).toContain("return NextResponse.json(agentTeamResponse(finalRun");
    expect(source).toContain("inferTeamLaunchSettings");
    expect(source).toContain("allowNetwork");
    expect(source).toContain("allowWrite");
    expect(source).toContain("allowWorktree");
    expect(source).toContain("stopConditions");
    expect(source).toContain("await startTeam(text, inferTeamLaunchSettings(text))");
    expect(source).toContain("shouldAutoKickAgentTeamRun");
    expect(source).toContain("setInterval(() =>");
    expect(source).toContain('type: "run_until_idle"');
    expect(autoKickSource).toContain("now - lastTouched >= (opts.staleMs ?? 45_000)");
    expect(source).toContain("previous?.key === key");
    expect(source).toContain("const activeKeyAtStart = activeKeyRef.current ?? DRAFT_KEY");
    expect(source).toContain("selectedSession.path !== activeKeyAtStart");
    expect(source).toContain("当前窗口还未完成 session 切换，请稍后再试。");
    expect(source).toContain("setComposerMode(null)");
    expect(source).not.toContain("pendingTeamLaunch");
    expect(source).not.toContain("准备启动团队协作");
    expect(source).not.toContain("只有你确认后才会启动");
    expect(source).not.toContain("启动 Agent Team");
    expect(source).not.toContain("Start Team");
    expect(source).not.toContain("Subagents、Workflow 不会自动升级到 Team");
    expect(source).toContain("type: \"start\"");
    expect(source).toContain("clientRequestId");
    expect(source).not.toContain("[key]: event.currentTarget.checked");
    expect(source).toContain("fetch(`/api/agent/${agentId}/teams`)");
    expect(source).toContain("appendRestoredAgentTeamRuns(state.chatState.messages, runs)");
  });
});

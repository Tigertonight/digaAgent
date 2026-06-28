import { test, expect } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import type { AgentTeamRun } from "@/lib/agent-team/types";

const editor = (page: Page) => page.locator("textarea").first();
const sendBtn = (page: Page) => page.getByTitle("Send", { exact: true });

function teamRun(overrides: Partial<AgentTeamRun> = {}): AgentTeamRun {
  const now = Date.now();
  const run: AgentTeamRun = {
    id: "team-e2e",
    parentAgentId: "agent-1",
    parentSessionPath: "/tmp/e2e-sessions/parent.jsonl",
    objective: "Team 验收：审计项目并处理 worktree",
    status: "running",
    leadState: "exploring",
    leadAgentId: "team-e2e:lead",
    createdAt: now,
    updatedAt: now,
    worktreeRoot: "/tmp/e2e-worktrees",
    settings: {
      memberScale: "small",
      allowNetwork: false,
      allowWrite: true,
      allowWorktree: true,
      allowChallenges: true,
      requirePlanApproval: true,
      displayMode: "workspace",
      writePolicy: "plan_approval",
      networkPolicy: "disabled",
      worktreePolicy: "per_member",
      resultIngestionMode: "structured",
      coordinationProfile: "basic",
      stopConditions: {
        requiredTasksComplete: true,
        noOpenBlockingChallenges: true,
        leadFinalSynthesis: true,
      },
    },
    members: [
      {
        id: "team-e2e:lead",
        name: "Lead",
        role: "负责人",
        agentId: "agent-1",
        status: "idle",
        sessionFile: "/tmp/e2e-sessions/parent.jsonl",
      },
      {
        id: "team-e2e:builder",
        name: "Builder",
        role: "实现 / 写入规划",
        agentId: "agent-builder",
        status: "working",
        sessionFile: "/tmp/e2e-sessions/builder.jsonl",
        currentTaskId: "task-implement",
        latestOutput: "已领取任务：检查实现路径。",
        worktree: {
          id: "wt-builder",
          path: "/tmp/e2e-worktrees/builder",
          branchName: "team/builder",
          baseRef: "HEAD",
          status: "active",
          createdAt: now,
        },
      },
    ],
    board: {
      summary: "Team 正在推进验收。",
      tasks: [
        {
          id: "task-implement",
          title: "验证 worktree 合并路径",
          description: "确认 Team 可以在独立改动区工作并交给用户合并。",
          status: "running",
          ownerAgentId: "team-e2e:builder",
          assignedAgentId: "team-e2e:builder",
          expectedOutput: "implementation",
          evidenceRequired: true,
          priority: "high",
          required: true,
          findingIds: [],
        },
      ],
      results: [],
      plans: [],
      findings: [
        {
          id: "finding-mode",
          taskId: "task-implement",
          authorAgentId: "team-e2e:lead",
          claim: "Team Workspace 已启动，成员状态可追踪。",
          evidenceRefs: ["workspace:board"],
          confidence: "high",
          status: "accepted",
          challengeIds: [],
        },
      ],
      challenges: [],
      decisions: [],
      messages: [],
      fileLocks: [],
      hooks: [],
      qualityGates: [
        {
          id: "gate-required-tasks",
          title: "Required tasks complete",
          status: "failed",
          severity: "blocking",
          message: "仍有 1 个 required task 未完成。",
        },
        {
          id: "gate-worktrees-merged",
          title: "Worktrees merged or discarded",
          status: "failed",
          severity: "blocking",
          message: "仍有 1 个 worktree 未合并或未丢弃。",
        },
      ],
      capabilityAudit: [],
      events: [
        {
          id: "event-created",
          type: "team_created",
          at: now,
          actorAgentId: "team-e2e:lead",
          message: "Team created for e2e.",
        },
        {
          id: "event-worktree",
          type: "worktree_created",
          at: now + 1,
          actorAgentId: "team-e2e:lead",
          targetAgentId: "team-e2e:builder",
          message: "Builder isolated worktree created.",
          data: { worktreeId: "wt-builder", path: "/tmp/e2e-worktrees/builder" },
        },
      ],
    },
    ...overrides,
  };
  return run;
}

async function installAgentTeamFixture(page: Page) {
  const calls: Array<Record<string, unknown>> = [];
  let currentRun: AgentTeamRun | null = null;
  let finalMessageText: string | null = null;

  await page.addInitScript(() => {
    const w = window as unknown as {
      __mockAgentAction?: (body: unknown) => unknown;
    };
    w.__mockAgentAction = (body: unknown) => {
      const input = body as { type?: unknown; text?: unknown };
      if (input.type !== "prompt") return null;
      if (localStorage.getItem("agent-team-e2e-completed") !== "1") return null;
      const now = Date.now();
      const userText = String(input.text ?? "");
      return {
        ok: true,
        localTeamAnswer: true,
        localMessages: {
          userMessage: {
            role: "user",
            content: userText,
            timestamp: now,
          },
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "这是普通追问回复：团队结论已经写入会话，后续问题会继续正常回答。",
              },
            ],
            responseId: "local-team-followup-e2e",
            timestamp: now + 1,
            provider: "local",
            model: "agent-team-result",
            api: "local",
            stopReason: "stop",
          },
        },
      };
    };
  });

  await page.route("**/api/agent/*/teams", async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === "GET") {
      return route.fulfill({ json: { runs: currentRun ? [currentRun] : [] } });
    }
    const body = req.postDataJSON() as Record<string, unknown>;
    calls.push(body);
    if (body.type === "start") {
      currentRun = teamRun({ objective: String(body.objective ?? "") });
      return route.fulfill({ json: { ok: true, run: currentRun } });
    }
    if (body.type === "run_until_idle") {
      currentRun = teamRun({
        ...(currentRun ?? {}),
        status: "paused",
        leadState: "needs_decision",
        board: {
          ...(currentRun ?? teamRun()).board,
          tasks: (currentRun ?? teamRun()).board.tasks.map((task) => ({
            ...task,
            status: "completed" as const,
            completedAt: Date.now(),
          })),
          results: [
            {
              id: "result-builder",
              taskId: "task-implement",
              authorAgentId: "team-e2e:builder",
              sessionFile: "/tmp/e2e-sessions/builder.jsonl",
              rawText: "TEAM_RESULT_JSON evidence captured.",
              summary: "Builder completed the worktree validation.",
              parsedAt: Date.now(),
              status: "parsed",
              findingIds: ["finding-builder"],
              challengeIds: [],
              evidenceRefs: ["session:/tmp/e2e-sessions/builder.jsonl"],
              parseWarnings: [],
            },
          ],
          findings: [
            ...(currentRun ?? teamRun()).board.findings,
            {
              id: "finding-builder",
              taskId: "task-implement",
              authorAgentId: "team-e2e:builder",
              claim: "worktree 操作入口可见并可调用。",
              evidenceRefs: ["session:/tmp/e2e-sessions/builder.jsonl"],
              confidence: "high",
              status: "accepted",
              challengeIds: [],
              sourceResultId: "result-builder",
            },
          ],
          events: [
            ...(currentRun ?? teamRun()).board.events,
            {
              id: "event-result",
              type: "result_submitted",
              at: Date.now(),
              actorAgentId: "team-e2e:builder",
              taskId: "task-implement",
              message: "Builder submitted result.",
            },
          ],
        },
        members: (currentRun ?? teamRun()).members.map((member) =>
          member.id === "team-e2e:builder"
            ? { ...member, status: "idle" as const, latestOutput: "结果已提交，等待合并 worktree。" }
            : member
        ),
      });
      return route.fulfill({ json: { ok: true, run: currentRun } });
    }
    if (body.type === "merge_worktree") {
      currentRun = teamRun({
        ...(currentRun ?? {}),
        members: (currentRun ?? teamRun()).members.map((member) =>
          member.id === body.memberId && member.worktree
            ? {
                ...member,
                worktree: { ...member.worktree, status: "merged" as const },
                latestOutput: "Worktree diff 已合并回主工作区。",
              }
            : member
        ),
        board: {
          ...(currentRun ?? teamRun()).board,
          qualityGates: (currentRun ?? teamRun()).board.qualityGates.map((gate) =>
            gate.id === "gate-worktrees-merged"
              ? { ...gate, status: "passed" as const, message: "所有 worktree 已合并、丢弃或关闭。" }
              : gate
          ),
          events: [
            ...(currentRun ?? teamRun()).board.events,
            {
              id: "event-merged",
              type: "worktree_merged",
              at: Date.now(),
              actorAgentId: "team-e2e:lead",
              targetAgentId: String(body.memberId),
              message: "Builder worktree merged.",
            },
          ],
        },
      });
      return route.fulfill({ json: { ok: true, run: currentRun } });
    }
    if (
      (body.type === "transition" && body.status === "completed") ||
      body.type === "finalize_with_risks"
    ) {
      const hasOpenWorktree = (currentRun ?? teamRun()).members.some(
        (member) =>
          member.worktree?.status === "active" ||
          member.worktree?.status === "merge_pending"
      );
      if (hasOpenWorktree) {
        currentRun = teamRun(currentRun ?? {});
        return route.fulfill({
          json: {
            ok: true,
            run: currentRun,
            blockedReasons: ["Team has unmerged worktrees"],
          },
        });
      }
      finalMessageText =
        "结论\n\n通过：worktree 已合并，团队最终判断已写回会话正文。\n\n<!-- agent-team-final:team-e2e -->";
      currentRun = teamRun({
        ...(currentRun ?? {}),
        status: "completed",
        leadState: "finalized",
        endedAt: Date.now(),
        board: {
          ...(currentRun ?? teamRun()).board,
          tasks: (currentRun ?? teamRun()).board.tasks.map((task) => ({
            ...task,
            status: "completed" as const,
            completedAt: task.completedAt ?? Date.now(),
          })),
          decisions: [
            {
              id: "decision-final",
              title: "Team E2E final decision",
              rationale: "Accepted findings and merged worktree are enough to finalize.",
              acceptedFindingIds: ["finding-builder"],
              rejectedFindingIds: [],
              challengeIds: [],
              evidenceRefs: ["session:/tmp/e2e-sessions/builder.jsonl"],
              sourceResultIds: ["result-builder"],
              confidence: "high",
              status: "accepted",
              madeByAgentId: "team-e2e:lead",
              createdAt: Date.now(),
            },
          ],
          qualityGates: (currentRun ?? teamRun()).board.qualityGates.map((gate) => ({
            ...gate,
            status: "passed" as const,
          })),
          events: [
            ...(currentRun ?? teamRun()).board.events,
            {
              id: "event-finalized",
              type: "team_finalized",
              at: Date.now(),
              actorAgentId: "team-e2e:lead",
              message: "Team finalized.",
            },
          ],
        },
      });
      await page.evaluate(
        (context) => {
          const w = window as unknown as {
            __mockSessionContext?: unknown;
          };
          w.__mockSessionContext = context;
          localStorage.setItem("agent-team-e2e-completed", "1");
        },
        {
          messages: [
            {
              role: "assistant",
              provider: "team",
              model: "agent-team-result",
              content: [{ type: "text", text: finalMessageText }],
              stopReason: "stop",
              timestamp: Date.now(),
            },
          ],
          forkableUserMessages: [],
          agentTeamRuns: [currentRun],
        }
      );
      return route.fulfill({ json: { ok: true, run: currentRun, blockedReasons: [] } });
    }
    return route.fulfill({ json: { ok: true, run: currentRun ?? teamRun() } });
  });

  await page.route("**/api/sessions/*/context", async (route: Route) => {
    return route.fulfill({
      json: {
        messages: finalMessageText
          ? [
              {
                role: "assistant",
                provider: "team",
                model: "agent-team-result",
                content: [{ type: "text", text: finalMessageText }],
                stopReason: "stop",
                timestamp: Date.now(),
              },
            ]
          : [],
        forkableUserMessages: [],
        agentTeamRuns: currentRun ? [currentRun] : [],
      },
    });
  });

  return calls;
}

function providerRiskRun(overrides: Partial<AgentTeamRun> = {}): AgentTeamRun {
  const now = Date.now();
  const completed = overrides.status === "completed";
  const paused = overrides.status === "paused";
  const run: AgentTeamRun = {
    id: "team-risk-e2e",
    parentAgentId: "agent-1",
    parentSessionPath: "/tmp/e2e-sessions/provider-risk-parent.jsonl",
    objective: "Team 风险验收：模拟成员模型连接提前结束，并检查带风险总结是否可读。",
    status: "running",
    leadState: "exploring",
    leadAgentId: "team-risk-e2e:lead",
    createdAt: now,
    updatedAt: now,
    settings: {
      memberScale: "small",
      allowNetwork: false,
      allowWrite: false,
      allowWorktree: false,
      allowChallenges: true,
      requirePlanApproval: false,
      displayMode: "workspace",
      writePolicy: "read_only",
      networkPolicy: "disabled",
      worktreePolicy: "none",
      resultIngestionMode: "structured",
      coordinationProfile: "basic",
      stopConditions: {
        requiredTasksComplete: true,
        noOpenBlockingChallenges: true,
        leadFinalSynthesis: true,
      },
    },
    members: [
      {
        id: "team-risk-e2e:lead",
        name: "Lead",
        role: "负责人",
        agentId: "agent-1",
        status: completed ? "done" : "idle",
        sessionFile: "/tmp/e2e-sessions/provider-risk-parent.jsonl",
      },
      {
        id: "team-risk-e2e:research",
        name: "Research",
        role: "资料员",
        agentId: "agent-risk-research",
        status: completed || paused ? "blocked" : "working",
        sessionFile: "/tmp/e2e-sessions/provider-risk-research.jsonl",
        currentTaskId: completed || paused ? undefined : "task-risk",
        latestOutput:
          "Dispatch failed: Member model error: Stream ended without finish_reason.",
      },
    ],
    board: {
      summary: "成员模型提前结束，团队需要带风险收束。",
      tasks: [
        {
          id: "task-risk",
          title: "收集证据",
          description: "模拟成员模型断流后没有返回可采纳结果。",
          status: completed || paused ? "completed" : "running",
          ownerAgentId: "team-risk-e2e:research",
          assignedAgentId: "team-risk-e2e:research",
          expectedOutput: "findings",
          evidenceRequired: true,
          priority: "high",
          required: true,
          findingIds: completed ? ["finding-risk"] : [],
          completedAt: completed || paused ? now : undefined,
          completionSource: completed ? "lead_override" : undefined,
        },
      ],
      results: [
        {
          id: "result-risk",
          taskId: "task-risk",
          authorAgentId: "team-risk-e2e:research",
          sessionFile: "/tmp/e2e-sessions/provider-risk-research.jsonl",
          rawText: "No teammate output was captured.",
          summary: "成员模型连接提前结束，没有拿到可采纳结论。",
          parsedAt: now,
          status: "needs_review",
          findingIds: [],
          challengeIds: [],
          evidenceRefs: ["session:/tmp/e2e-sessions/provider-risk-research.jsonl"],
          parseWarnings: [
            "provider stream ended before usable teammate output was captured",
          ],
        },
      ],
      plans: [],
      findings: completed
        ? [
            {
              id: "finding-risk",
              taskId: "task-risk",
              authorAgentId: "team-risk-e2e:lead",
              claim:
                "不通过：当前无法形成可靠结论，部分检查没有拿到可采纳结果，因此只能给出带风险的阶段性判断。",
              evidenceRefs: ["task:task-risk"],
              confidence: "medium",
              status: "accepted",
              challengeIds: [],
              acceptedByAgentId: "team-risk-e2e:lead",
              acceptedAt: now,
            },
          ]
        : [],
      challenges: [],
      decisions: completed
        ? [
            {
              id: "decision-risk",
              title: "带风险总结",
              rationale:
                "用户选择带风险生成最终综合。No teammate output was captured. provider stream error.",
              acceptedFindingIds: ["finding-risk"],
              rejectedFindingIds: [],
              challengeIds: [],
              evidenceRefs: ["task:task-risk"],
              sourceResultIds: ["result-risk"],
              confidence: "low",
              status: "accepted",
              madeByAgentId: "team-risk-e2e:lead",
              createdAt: now,
            },
          ]
        : [],
      messages: [],
      fileLocks: [],
      hooks: [],
      qualityGates: [
        {
          id: "gate-required-tasks",
          title: "Required tasks complete",
          status: completed || paused ? "passed" : "failed",
          severity: "blocking",
          message: completed || paused ? "所有 required task 已完成。" : "仍有 1 个 required task 未完成。",
        },
        {
          id: "gate-lead-synthesis",
          title: "Lead final synthesis",
          status: completed ? "passed" : "failed",
          severity: "blocking",
          message: completed
            ? "Lead 已形成带真实 evidence / finding 追溯的最终综合判断。"
            : "Lead 尚未形成可追溯最终综合判断。",
        },
      ],
      capabilityAudit: [],
      events: [
        {
          id: "event-risk-created",
          type: "team_created",
          at: now,
          actorAgentId: "team-risk-e2e:lead",
          message: "Team created for provider risk e2e.",
        },
        ...(paused || completed
          ? [
              {
                id: "event-risk-result",
                type: "result_submitted" as const,
                at: now + 1,
                actorAgentId: "team-risk-e2e:research",
                taskId: "task-risk",
                message: "Dispatch failed: Member model error: Stream ended without finish_reason.",
              },
            ]
          : []),
        ...(completed
          ? [
              {
                id: "event-risk-finalized",
                type: "team_finalized" as const,
                at: now + 2,
                actorAgentId: "team-risk-e2e:lead",
                message: "Team finalized.",
              },
            ]
          : []),
      ],
    },
    ...overrides,
  };
  return run;
}

async function installProviderRiskFixture(page: Page) {
  const calls: Array<Record<string, unknown>> = [];
  let currentRun: AgentTeamRun | null = null;
  let finalMessageText: string | null = null;

  await page.route("**/api/agent/*/teams", async (route: Route) => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill({ json: { runs: currentRun ? [currentRun] : [] } });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push(body);
    if (body.type === "start") {
      currentRun = providerRiskRun({ objective: String(body.objective ?? "") });
      return route.fulfill({ json: { ok: true, run: currentRun } });
    }
    if (body.type === "run_until_idle") {
      currentRun = providerRiskRun({
        objective: currentRun?.objective,
        status: "paused",
        leadState: "ready_to_synthesize",
      });
      return route.fulfill({ json: { ok: true, run: currentRun, blockReasons: [] } });
    }
    if (
      (body.type === "transition" && body.status === "completed") ||
      body.type === "finalize_with_risks"
    ) {
      finalMessageText =
        "结论\n\n这次没有拿到足够可靠的团队结论；建议重试自动处理，或切换到稳定模型后再跑一次。\n\n<!-- agent-team-final:team-risk-e2e -->";
      currentRun = providerRiskRun({
        objective: currentRun?.objective,
        status: "completed",
        leadState: "finalized",
        endedAt: Date.now(),
      });
      await page.evaluate(
        (context) => {
          const w = window as unknown as { __mockSessionContext?: unknown };
          w.__mockSessionContext = context;
        },
        {
          messages: [
            {
              role: "assistant",
              provider: "team",
              model: "agent-team-result",
              content: [{ type: "text", text: finalMessageText }],
              stopReason: "stop",
              timestamp: Date.now(),
            },
          ],
          forkableUserMessages: [],
          agentTeamRuns: [currentRun],
        }
      );
      return route.fulfill({ json: { ok: true, run: currentRun, blockedReasons: [] } });
    }
    return route.fulfill({ json: { ok: true, run: currentRun ?? providerRiskRun() } });
  });

  await page.route("**/api/sessions/*/context", async (route: Route) => {
    return route.fulfill({
      json: {
        messages: finalMessageText
          ? [
              {
                role: "assistant",
                provider: "team",
                model: "agent-team-result",
                content: [{ type: "text", text: finalMessageText }],
                stopReason: "stop",
                timestamp: Date.now(),
              },
            ]
          : [],
        forkableUserMessages: [],
        agentTeamRuns: currentRun ? [currentRun] : [],
      },
    });
  });

  return calls;
}

function highConfidenceShortcutRun(): AgentTeamRun {
  const now = Date.now();
  const run = teamRun({
    id: "team-high-confidence-e2e",
    objective:
      "AUTO_ADVANCE_E2E：只读确认 package.json 是否存在。最终只回答：存在/不存在 + 一句话证据。",
    status: "completed",
    leadState: "finalized",
    endedAt: now,
    settings: {
      ...teamRun().settings,
      allowWrite: false,
      allowWorktree: false,
      requirePlanApproval: false,
      writePolicy: "read_only",
      worktreePolicy: "none",
    },
  });
  return {
    ...run,
    members: [
      {
        id: "team-high-confidence-e2e:lead",
        name: "Lead",
        role: "负责人",
        agentId: "agent-1",
        status: "done",
        sessionFile: "/tmp/e2e-sessions/high-confidence-parent.jsonl",
      },
      {
        id: "team-high-confidence-e2e:research",
        name: "Research",
        role: "资料员",
        agentId: "agent-research",
        status: "done",
        sessionFile: "/tmp/e2e-sessions/high-confidence-research.jsonl",
        latestOutput: "存在：package.json 在当前项目中。",
      },
      {
        id: "team-high-confidence-e2e:critic",
        name: "Critic",
        role: "质疑者",
        agentId: "agent-critic",
        status: "idle",
        sessionFile: "/tmp/e2e-sessions/high-confidence-critic.jsonl",
        latestOutput: "Teammate session created, waiting for task claim.",
      },
    ],
    leadAgentId: "team-high-confidence-e2e:lead",
    board: {
      ...run.board,
      summary: "已确认 package.json 存在。",
      tasks: [
        {
          id: "task-scope",
          title: "界定问题",
          description: "明确本次要确认什么、不能做什么，以及怎样算完成。",
          status: "completed",
          ownerAgentId: "team-high-confidence-e2e:lead",
          assignedAgentId: "team-high-confidence-e2e:lead",
          expectedOutput: "decision_input",
          evidenceRequired: false,
          priority: "high",
          required: true,
          findingIds: ["finding-package"],
          completedAt: now,
        },
        {
          id: "task-evidence",
          title: "定位代码与证据",
          description: "查找相关文件，并给出可以核对的证据。",
          status: "completed",
          ownerAgentId: "team-high-confidence-e2e:research",
          assignedAgentId: "team-high-confidence-e2e:research",
          expectedOutput: "findings",
          evidenceRequired: true,
          priority: "high",
          required: true,
          findingIds: ["finding-package"],
          completedAt: now,
        },
        {
          id: "task-challenge",
          title: "挑战结论",
          description: "对关键发现做反证、找冲突、标出需要继续探索的地方。",
          status: "completed",
          ownerAgentId: "team-high-confidence-e2e:lead",
          assignedAgentId: "team-high-confidence-e2e:lead",
          expectedOutput: "review",
          evidenceRequired: false,
          priority: "normal",
          required: true,
          findingIds: [],
          completedAt: now,
          completionSource: "lead_override",
        },
        {
          id: "task-synthesis",
          title: "形成可追溯综合",
          description: "把已确认的信息整理成最终回答。",
          status: "completed",
          ownerAgentId: "team-high-confidence-e2e:lead",
          assignedAgentId: "team-high-confidence-e2e:lead",
          expectedOutput: "decision_input",
          evidenceRequired: false,
          priority: "normal",
          required: false,
          findingIds: [],
          completedAt: now,
          completionSource: "lead_override",
        },
      ],
      results: [
        {
          id: "result-package",
          taskId: "task-evidence",
          authorAgentId: "team-high-confidence-e2e:research",
          sessionFile: "/tmp/e2e-sessions/high-confidence-research.jsonl",
          rawText: "存在：package.json 在当前项目中。",
          summary: "存在：package.json 在当前项目中。",
          parsedAt: now,
          status: "parsed",
          findingIds: ["finding-package"],
          challengeIds: [],
          evidenceRefs: ["file:package.json"],
          parseWarnings: [],
        },
      ],
      findings: [
        {
          id: "finding-package",
          taskId: "task-evidence",
          authorAgentId: "team-high-confidence-e2e:research",
          claim: "存在：package.json 在当前项目中。",
          evidenceRefs: ["file:package.json"],
          confidence: "high",
          status: "accepted",
          challengeIds: [],
          sourceResultId: "result-package",
          acceptedByAgentId: "team-high-confidence-e2e:lead",
          acceptedAt: now,
        },
      ],
      challenges: [],
      decisions: [
        {
          id: "decision-package",
          title: "确认 package.json",
          rationale: "存在 — 已确认 package.json 在当前项目中。",
          acceptedFindingIds: ["finding-package"],
          rejectedFindingIds: [],
          challengeIds: [],
          evidenceRefs: ["file:package.json"],
          sourceResultIds: ["result-package"],
          confidence: "high",
          status: "accepted",
          madeByAgentId: "team-high-confidence-e2e:lead",
          createdAt: now,
        },
      ],
      qualityGates: run.board.qualityGates.map((gate) => ({
        ...gate,
        status: "passed" as const,
        message: "已通过。",
      })),
      events: [
        {
          id: "event-created",
          type: "team_created",
          at: now,
          actorAgentId: "team-high-confidence-e2e:lead",
          message: "Team created for high confidence shortcut e2e.",
        },
        {
          id: "event-member-critic",
          type: "member_spawned",
          at: now + 1,
          actorAgentId: "team-high-confidence-e2e:lead",
          targetAgentId: "team-high-confidence-e2e:critic",
          message: "Critic teammate session created.",
        },
        {
          id: "event-result",
          type: "result_submitted",
          at: now + 2,
          actorAgentId: "team-high-confidence-e2e:research",
          taskId: "task-evidence",
          message: "存在：package.json 在当前项目中。",
        },
        {
          id: "event-finding",
          type: "finding_accepted",
          at: now + 3,
          actorAgentId: "team-high-confidence-e2e:lead",
          taskId: "task-evidence",
          message: "Accepted available finding: 存在：package.json 在当前项目中。",
        },
        {
          id: "event-risk-task",
          type: "task_completed",
          at: now + 4,
          actorAgentId: "team-high-confidence-e2e:lead",
          taskId: "task-synthesis",
          message: "形成可追溯综合 skipped with risk summary.",
        },
        {
          id: "event-finalized-risk",
          type: "team_finalized",
          at: now + 5,
          actorAgentId: "team-high-confidence-e2e:lead",
          message: "Team finalized with risk summary.",
        },
      ],
    },
  };
}

async function installHighConfidenceShortcutFixture(page: Page) {
  const calls: Array<Record<string, unknown>> = [];
  let currentRun: AgentTeamRun | null = null;
  await page.route("**/api/agent/*/teams", async (route: Route) => {
    const body = route.request().method() === "POST"
      ? route.request().postDataJSON() as Record<string, unknown>
      : null;
    if (body) calls.push(body);
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { runs: currentRun ? [currentRun] : [] } });
    }
    if (body?.type === "start") {
      currentRun = highConfidenceShortcutRun();
      return route.fulfill({ json: { ok: true, run: currentRun } });
    }
    return route.fulfill({ json: { ok: true, run: currentRun ?? highConfidenceShortcutRun() } });
  });
  return calls;
}

test("agent team: high-confidence final answer hides shortcut risk noise", async ({
  bootedPage: page,
}) => {
  const calls = await installHighConfidenceShortcutFixture(page);
  await editor(page).fill("/team AUTO_ADVANCE_E2E：只读确认 package.json 是否存在。最终只回答：存在/不存在 + 一句话证据。");
  await expect(page.getByTestId("mode-chip-team")).toBeVisible();
  await sendBtn(page).click();

  await expect.poll(() => calls.some((call) => call.type === "start")).toBe(true);
  await expect(page.getByTestId("agent-team-run-card")).toBeVisible();
  await expect(page.getByTestId("agent-team-run-card")).toContainText("结论已生成");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("带风险");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("继续推进");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("risk summary");

  await page.getByTestId("open-agent-team-workspace").click();
  const workspace = page.getByTestId("agent-team-workspace");
  await expect(workspace).toContainText("团队状态");
  await expect(workspace).toContainText("结论已生成");
  await expect(workspace).not.toContainText("风险提示");
  await expect(workspace).not.toContainText("带风险");
  await expect(workspace).not.toContainText("risk summary");
  await expect(workspace).not.toContainText("quality gates");

  const taskFlowButton = workspace.getByRole("button", { name: "展开" });
  await expect(taskFlowButton).toBeVisible();
  await taskFlowButton.click();
  await expect(workspace).toContainText("最近动作");
  await expect(workspace).toContainText("关键任务 3/3");
  await expect(workspace).not.toContainText("关键任务 2/3");
  await expect(workspace).not.toContainText("skipped with risk");
  await expect(workspace).not.toContainText("Team finalized with risk");
  await expect(workspace).not.toContainText("形成可追溯综合");

  const memberChips = workspace.getByTestId("agent-team-member-chip");
  await expect(memberChips.first()).toBeVisible();
  await memberChips.first().click();
  await expect(workspace.getByTestId("agent-team-member-transcript-detail")).toBeVisible();
});

test("agent team: launch, inspect workspace, advance, and merge worktree", async ({
  bootedPage: page,
}) => {
  const calls = await installAgentTeamFixture(page);

  await editor(page).fill("/team Team 验收：审计项目并处理 worktree");
  await expect(page.getByTestId("mode-chip-team")).toBeVisible();
  await sendBtn(page).click();

  await expect.poll(() => calls.some((call) => call.type === "start")).toBe(true);
  await expect(page.getByTestId("agent-team-workspace")).toBeVisible();
  await expect(page.getByText("团队协作").first()).toBeVisible();
  await expect.poll(() => calls.some((call) => call.type === "run_until_idle")).toBe(true);
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("继续推进");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("展开过程");
  await expect(
    page.getByTestId("agent-team-run-card").getByTestId("open-agent-team-workspace")
  ).toContainText("展开");

  const workspace = page.getByTestId("agent-team-workspace");
  await page.getByTestId("open-agent-team-workspace").click();
  await expect(page.getByText("成员分工")).toBeVisible();
  const memberChips = workspace.getByTestId("agent-team-member-chip");
  await expect(memberChips.first()).toBeVisible();
  await memberChips.first().click();
  await expect(workspace.getByTestId("agent-team-member-transcript-detail")).toBeVisible();
  await workspace.getByRole("button", { name: "打开完整记录" }).click();
  await expect(workspace.getByTestId("agent-team-member-record-notice")).toContainText(
    "完整记录暂时不在会话列表里"
  );
  await expect(page.getByText("成员记录暂时没有出现在会话列表里，已刷新列表。")).toHaveCount(0);
  await expect(page.getByText("独立改动区", { exact: true })).toBeVisible();
  await expect(page.getByTestId("agent-team-worktree-item")).toContainText("team/builder");
  await expect(page.getByText("结果已提交，等待合并 worktree。")).toBeVisible();

  await page
    .getByTestId("agent-team-run-card")
    .getByRole("button", { name: "生成总结" })
    .click();
  await expect
    .poll(() => calls.some((call) => call.type === "finalize_with_risks"))
    .toBe(true);
  await expect(page.getByText("还有独立改动区没有处理。")).toBeVisible();

  await page
    .getByTestId("agent-team-worktree-item")
    .getByRole("button", { name: "合并" })
    .click();
  await expect
    .poll(() =>
      calls.some(
        (call) =>
          call.type === "merge_worktree" &&
          call.memberId === "team-e2e:builder" &&
          call.strategy === "accept"
      )
    )
    .toBe(true);
  await expect(page.getByTestId("agent-team-worktree-item")).toContainText("已合并");

  const finalizeCount = calls.filter((call) => call.type === "finalize_with_risks").length;
  await page.waitForTimeout(600);
  await page
    .getByTestId("agent-team-run-card")
    .getByRole("button", { name: "生成总结" })
    .click();
  await expect
    .poll(() => calls.filter((call) => call.type === "finalize_with_risks").length)
    .toBe(finalizeCount + 1);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const w = window as unknown as {
          __chatAppDiag?: {
            activeKey: () => string;
            runners: {
              current: Map<
                string,
                {
                  chatState: {
                    messages: Array<{
                      parts?: Array<{ kind: string; run?: { id: string; status: string } }>;
                    }>;
                  };
                }
              >;
            };
          };
        };
        const key = w.__chatAppDiag?.activeKey();
        const runner = key ? w.__chatAppDiag?.runners.current.get(key) : undefined;
        const part = runner?.chatState.messages
          .flatMap((message) => message.parts ?? [])
          .find((item) => item.kind === "agent_team_run" && item.run?.id === "team-e2e");
        return part?.run?.status ?? null;
      })
    )
    .toBe("completed");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("继续推进");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("待推进");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("待命");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("展开过程");
  await expect(
    page.getByTestId("agent-team-run-card").getByTestId("open-agent-team-workspace")
  ).toContainText("展开");
  await expect(page.getByTestId("agent-team-workspace")).not.toContainText("quality gates");
  await expect(page.getByTestId("agent-team-workspace")).not.toContainText("No teammate output");
  await expect(page.getByTestId("agent-team-workspace")).not.toContainText("provider stream");
  await expect(page.getByRole("main").getByText("结论").last()).toBeVisible();
  await expect(
    page.getByRole("main").getByText("Accepted findings and merged worktree are enough to finalize")
  ).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("agent-team-run-card")).toBeVisible();
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("继续推进");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("待推进");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("待命");
  await expect(page.getByRole("main").getByText("结论").last()).toBeVisible();
  await page.getByTestId("open-agent-team-workspace").click();
  await expect(page.getByTestId("agent-team-workspace")).toContainText("团队状态");
  await expect(page.getByTestId("agent-team-workspace")).not.toContainText("quality gates");
  await expect(page.getByTestId("agent-team-workspace")).not.toContainText("provider stream");

  await expect(page.getByTestId("mode-chip-team")).toHaveCount(0);
  const teamCardCount = await page.getByTestId("agent-team-run-card").count();
  await editor(page).fill("这个结论再用一句话解释一下");
  await sendBtn(page).click();
  await expect(
    page.getByRole("main").getByText("这是普通追问回复：团队结论已经写入会话")
  ).toBeVisible();
  await expect(page.getByTestId("agent-team-run-card")).toHaveCount(teamCardCount);
  expect(calls.filter((call) => call.type === "start")).toHaveLength(1);
});

test("agent team: provider stream failure can finish with readable risk summary", async ({
  bootedPage: page,
}) => {
  const calls = await installProviderRiskFixture(page);

  await editor(page).fill("/team Team 风险验收：模拟成员模型连接提前结束");
  await expect(page.getByTestId("mode-chip-team")).toBeVisible();
  await sendBtn(page).click();

  await expect.poll(() => calls.some((call) => call.type === "start")).toBe(true);
  await expect.poll(() => calls.some((call) => call.type === "run_until_idle")).toBe(true);

  await page
    .getByTestId("agent-team-run-card")
    .getByRole("button", { name: "生成总结" })
    .click();
  await expect
    .poll(() => calls.some((call) => call.type === "finalize_with_risks"))
    .toBe(true);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const w = window as unknown as {
          __chatAppDiag?: {
            activeKey: () => string;
            runners: {
              current: Map<
                string,
                {
                  chatState: {
                    messages: Array<{
                      parts?: Array<{ kind: string; run?: { id: string; status: string } }>;
                    }>;
                  };
                }
              >;
            };
          };
        };
        const key = w.__chatAppDiag?.activeKey();
        const runner = key ? w.__chatAppDiag?.runners.current.get(key) : undefined;
        const part = runner?.chatState.messages
          .flatMap((message) => message.parts ?? [])
          .find((item) => item.kind === "agent_team_run" && item.run?.id === "team-risk-e2e");
        return part?.run?.status ?? null;
      })
    )
    .toBe("completed");

  await expect(page.getByRole("main").getByText("无法确认通过。")).toBeVisible();
  await expect(page.getByRole("main").getByText("成员结果没有完整返回")).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("No teammate output");
  await expect(page.getByRole("main")).not.toContainText("provider stream");

  await page.getByTestId("open-agent-team-workspace").click();
  const workspace = page.getByTestId("agent-team-workspace");
  await expect(workspace).toContainText("风险提示");
  await expect(workspace).toContainText("成员执行中断");
  await expect(workspace).toContainText("模型连接提前结束");
  await expect(workspace).not.toContainText("No teammate output");
  await expect(workspace).not.toContainText("provider stream");
  await expect(workspace).not.toContainText("quality gates");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("继续推进");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("待推进");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("待命");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("成员模型调用失败");
  await expect(page.getByTestId("agent-team-run-card")).not.toContainText("没有返回完成标记");
});

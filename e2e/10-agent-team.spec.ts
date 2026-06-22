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
    if (body.type === "transition" && body.status === "completed") {
      const hasOpenWorktree = (currentRun ?? teamRun()).members.some(
        (member) =>
          member.worktree?.status === "active" ||
          member.worktree?.status === "merge_pending"
      );
      if (hasOpenWorktree) {
        currentRun = teamRun(currentRun ?? {});
        return route.fulfill({
          json: {
            ok: false,
            run: currentRun,
            blockedReasons: ["Team has unmerged worktrees"],
          },
        });
      }
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
      return route.fulfill({ json: { ok: true, run: currentRun, blockedReasons: [] } });
    }
    return route.fulfill({ json: { ok: true, run: currentRun ?? teamRun() } });
  });

  return calls;
}

test("agent team: launch, inspect workspace, advance, and merge worktree", async ({
  bootedPage: page,
}) => {
  const calls = await installAgentTeamFixture(page);

  await editor(page).fill("/team Team 验收：审计项目并处理 worktree");
  await expect(page.getByTestId("mode-chip-team")).toBeVisible();
  await sendBtn(page).click();
  await expect(page.getByText("准备启动团队协作")).toBeVisible();
  await page.getByRole("button", { name: "开始" }).click();

  await expect.poll(() => calls.some((call) => call.type === "start")).toBe(true);
  await expect(page.getByTestId("agent-team-workspace")).toBeVisible();
  await expect(page.getByText("团队协作").first()).toBeVisible();
  await expect(page.getByText("继续推进")).toBeVisible();

  const workspace = page.getByTestId("agent-team-workspace");
  await workspace.getByRole("button", { name: "查看过程" }).click();
  await expect(page.getByText("成员分工")).toBeVisible();
  await expect(page.getByText("独立改动区", { exact: true })).toBeVisible();
  await expect(page.getByTestId("agent-team-worktree-item")).toContainText("team/builder");

  await workspace.getByRole("button", { name: "继续推进" }).click();
  await expect.poll(() => calls.some((call) => call.type === "run_until_idle")).toBe(true);
  await expect(page.getByText("结果已提交，等待合并 worktree。")).toBeVisible();

  await page
    .getByTestId("agent-team-run-card")
    .getByRole("button", { name: "生成总结" })
    .click();
  await expect.poll(() => calls.some((call) => call.type === "transition")).toBe(true);
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

  const transitionCount = calls.filter((call) => call.type === "transition").length;
  await page
    .getByTestId("agent-team-run-card")
    .getByRole("button", { name: "生成总结" })
    .click();
  await expect
    .poll(() => calls.filter((call) => call.type === "transition").length)
    .toBe(transitionCount + 1);
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
  await expect(
    page.getByText("Accepted findings and merged worktree are enough to finalize.")
  ).toBeVisible();
});

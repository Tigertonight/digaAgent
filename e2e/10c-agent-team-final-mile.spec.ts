/**
 * Agent Team Final Mile E2E
 *
 * 覆盖 docs/plans/2026-06-22-agent-team-final-mile.md 的 Item 2 + Item 3：
 *   - Coordination Audit drawer 在诊断详情中可见
 *   - Workspace 顶部 Hydrate Banner 在 missingMemberIds.length > 0 时出现
 *   - 一键恢复按钮调用 resume API
 *   - missing/replaced hydrateState 的成员行出现「替换成员」按钮
 *
 * 不重测 launch / dispatch / merge worktree 这些已在 10/10b spec 覆盖的链路。
 */
import { test, expect } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import type { AgentTeamRun } from "@/lib/agent-team/types";

const editor = (page: Page) => page.locator("textarea").first();
const sendBtn = (page: Page) => page.getByTitle("Send", { exact: true });

function buildHydrateRun(): AgentTeamRun {
  const now = Date.now();
  return {
    id: "team-final-mile",
    parentAgentId: "agent-1",
    parentSessionPath: "/tmp/e2e-sessions/parent.jsonl",
    objective: "Final mile：验收 hydrate banner 和 coordination 抽屉",
    status: "running",
    leadState: "exploring",
    leadAgentId: "team-final-mile:lead",
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
        id: "team-final-mile:lead",
        name: "Lead",
        role: "负责人",
        agentId: "agent-1",
        status: "idle",
        sessionFile: "/tmp/e2e-sessions/parent.jsonl",
      },
      {
        id: "team-final-mile:research",
        name: "Research",
        role: "资料 / 证据",
        sessionFile: "/tmp/e2e-sessions/research.jsonl",
        status: "blocked",
        hydrateState: "missing",
        latestOutput: "成员会话文件不存在，需要替换成员后才能继续。",
      },
      {
        id: "team-final-mile:critic",
        name: "Critic",
        role: "挑战 / 反证",
        agentId: "agent-critic",
        sessionFile: "/tmp/e2e-sessions/critic.jsonl",
        status: "idle",
        hydrateState: "rehydrated",
        latestOutput: "成员会话已恢复，等待自动分配下一步。",
      },
    ],
    hydrate: {
      lastHydratedAt: now,
      rehydratedMemberIds: ["team-final-mile:critic"],
      missingMemberIds: ["team-final-mile:research"],
      notes: "Team hydrate inspected: 1 teammate session needs resume or replacement.",
    },
    coordinationAudit: [
      {
        id: "coord-1",
        at: now - 30_000,
        memberId: "team-final-mile:critic",
        toolName: "team_get_board",
        args: {},
        outcome: "ok",
      },
      {
        id: "coord-2",
        at: now - 20_000,
        memberId: "team-final-mile:critic",
        toolName: "team_claim_task",
        args: { taskId: "evidence" },
        outcome: "ok",
      },
      {
        id: "coord-3",
        at: now - 10_000,
        memberId: "team-final-mile:research",
        toolName: "team_submit_result",
        args: { taskId: "evidence" },
        outcome: "rejected",
        rejectionReason: "team run is not running",
      },
    ],
    board: {
      summary: "Team paused after server restart.",
      tasks: [
        {
          id: "frame",
          title: "界定问题",
          description: "已完成。",
          status: "completed",
          ownerAgentId: "team-final-mile:lead",
          claimedAt: now,
          completedAt: now,
          priority: "high",
          required: true,
          findingIds: [],
        },
        {
          id: "evidence",
          title: "收集证据",
          description: "等待恢复后继续。",
          status: "pending",
          priority: "high",
          required: true,
          findingIds: [],
          dependsOnTaskIds: ["frame"],
        },
      ],
      findings: [],
      challenges: [],
      results: [],
      plans: [],
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
      ],
      capabilityAudit: [],
      events: [
        {
          id: "evt-paused",
          type: "team_paused",
          at: now,
          actorAgentId: "team-final-mile:lead",
          message: "Team hydrate inspected after restart.",
        },
      ],
    },
  };
}

async function installFinalMileFixture(page: Page) {
  const calls: Array<Record<string, unknown>> = [];
  let currentRun: AgentTeamRun = buildHydrateRun();

  await page.route("**/api/agent/*/teams", async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === "GET") {
      return route.fulfill({ json: { runs: [currentRun] } });
    }
    const body = req.postDataJSON() as Record<string, unknown>;
    calls.push(body);
    if (body.type === "start") {
      currentRun = { ...buildHydrateRun(), objective: String(body.objective ?? "") };
      return route.fulfill({ json: { ok: true, run: currentRun } });
    }
    if (body.type === "resume") {
      const recovered: AgentTeamRun = {
        ...currentRun,
        status: "running",
        members: currentRun.members.map((member) =>
          member.id === "team-final-mile:research"
            ? {
                ...member,
                status: "idle" as const,
                hydrateState: "rehydrated" as const,
                agentId: "agent-research-rebuilt",
                latestOutput: "成员会话已恢复，等待自动分配下一步。",
              }
            : member
        ),
        hydrate: {
          lastHydratedAt: Date.now(),
          rehydratedMemberIds: [
            "team-final-mile:research",
            "team-final-mile:critic",
          ],
          missingMemberIds: [],
          notes: "Team hydrate finished: 2 rehydrated, 0 missing, 0 replaced.",
        },
      };
      currentRun = recovered;
      return route.fulfill({
        json: {
          ok: true,
          run: currentRun,
          rehydrated: ["team-final-mile:research", "team-final-mile:critic"],
          missing: [],
          replaced: [],
        },
      });
    }
    if (body.type === "replace_member") {
      return route.fulfill({ json: { ok: true, run: currentRun } });
    }
    return route.fulfill({ json: { ok: true, run: currentRun } });
  });

  return calls;
}

test("agent team final mile: hydrate banner, coordination drawer, replace member", async ({
  bootedPage: page,
}) => {
  const calls = await installFinalMileFixture(page);

  await editor(page).fill("/team Final mile：验收 hydrate banner 和 coordination 抽屉");
  await expect(page.getByTestId("mode-chip-team")).toBeVisible();
  await sendBtn(page).click();
  await expect(page.getByText("准备启动团队协作")).toBeVisible();
  await page.getByRole("button", { name: "开始" }).click();

  await expect.poll(() => calls.some((call) => call.type === "start")).toBe(true);
  const workspace = page.getByTestId("agent-team-workspace");
  await expect(workspace).toBeVisible();

  // Item 3：Hydrate banner 出现
  const banner = page.getByTestId("agent-team-hydrate-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("teammate 需要恢复");

  // Item 3：missing 成员行有「替换成员」按钮
  await workspace.getByRole("button", { name: "查看过程" }).click();
  await expect(
    page.getByTestId("replace-member-team-final-mile:research")
  ).toBeVisible();

  // Item 2：Coordination Audit drawer 默认折叠，header 显示近 5 分钟调用计数 ≥ 3
  const diagnostics = page.getByTestId("agent-team-diagnostics-toggle");
  await expect(diagnostics).toBeVisible();
  await expect(diagnostics).toContainText("协作 3");
  await diagnostics.click();

  const drawer = page.getByTestId("agent-team-coordination-audit");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("近 3 条");
  await expect(drawer).toContainText("get_board");
  await expect(drawer).toContainText("claim_task");
  await expect(drawer).toContainText("submit_result");
  await expect(drawer).toContainText("被拒绝");

  // Item 3：一键恢复触发 resume API
  await page.getByTestId("agent-team-hydrate-resume").click();
  await expect.poll(() => calls.some((call) => call.type === "resume")).toBe(true);
  await expect(page.getByTestId("agent-team-hydrate-banner")).toHaveCount(0);
});

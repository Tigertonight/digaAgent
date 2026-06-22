import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import type { AgentTeamRun } from "@/lib/agent-team/types";

const editor = (page: Page) => page.locator("textarea").first();
const sendBtn = (page: Page) => page.getByTitle("Send", { exact: true });

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createGitFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "diga-team-worktree-"));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "e2e@example.test"]);
  git(repo, ["config", "user.name", "Diga E2E"]);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "feature.ts"), "export const value = 1;\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);

  const worktreePath = path.join(repo, ".diga-agent", "agent-teams", "team-wt-e2e", "builder");
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(repo, ["worktree", "add", "-b", "team/builder-e2e", worktreePath]);
  fs.writeFileSync(path.join(worktreePath, "src", "feature.ts"), "export const value = 2;\n");
  return { repo, worktreePath };
}

function teamRun(input: {
  repo: string;
  worktreePath: string;
  worktreeStatus?: "active" | "merge_pending" | "cleaned";
  status?: "running" | "completed";
  blockedMessage?: string;
}): AgentTeamRun {
  const now = Date.now();
  const worktreeStatus = input.worktreeStatus ?? "active";
  const openWorktree = worktreeStatus === "active" || worktreeStatus === "merge_pending";
  return {
    id: "team-wt-e2e",
    parentAgentId: "agent-1",
    parentSessionPath: path.join(input.repo, ".diga-agent", "sessions", "parent.jsonl"),
    objective: "Team worktree E2E：验证独立改动区阻止提前总结",
    status: input.status ?? "running",
    leadState: input.status === "completed" ? "finalized" : "ready_to_synthesize",
    leadAgentId: "team-wt-e2e:lead",
    createdAt: now,
    updatedAt: now,
    worktreeRoot: path.dirname(input.worktreePath),
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
        id: "team-wt-e2e:lead",
        name: "Lead",
        role: "负责人",
        agentId: "agent-1",
        status: "idle",
        sessionFile: path.join(input.repo, ".diga-agent", "sessions", "parent.jsonl"),
      },
      {
        id: "team-wt-e2e:builder",
        name: "Builder",
        role: "实现 / 写入规划",
        agentId: "agent-builder",
        status: "idle",
        sessionFile: path.join(input.repo, ".diga-agent", "sessions", "builder.jsonl"),
        latestOutput:
          worktreeStatus === "cleaned"
            ? "Worktree 已丢弃并清理。"
            : worktreeStatus === "merge_pending"
              ? "Worktree 已保留，等待手动 merge 或 discard。"
              : "写入任务已完成，等待处理独立改动区。",
        worktree: {
          id: "wt-builder-real",
          path: input.worktreePath,
          branchName: "team/builder-e2e",
          baseRef: "HEAD",
          status: worktreeStatus,
          createdAt: now,
        },
      },
    ],
    board: {
      summary: "Team 已完成写入任务，正在等待 worktree 处理。",
      tasks: [
        {
          id: "task-write",
          title: "修改 feature.ts",
          description: "Builder 在独立 worktree 中完成修改。",
          status: "completed",
          ownerAgentId: "team-wt-e2e:builder",
          assignedAgentId: "team-wt-e2e:builder",
          expectedOutput: "implementation",
          evidenceRequired: true,
          priority: "high",
          required: true,
          findingIds: ["finding-write"],
          completedAt: now,
        },
      ],
      results: [
        {
          id: "result-write",
          taskId: "task-write",
          authorAgentId: "team-wt-e2e:builder",
          sessionFile: path.join(input.repo, ".diga-agent", "sessions", "builder.jsonl"),
          rawText: "TEAM_RESULT_JSON worktree change completed.",
          summary: "Builder changed src/feature.ts in an isolated worktree.",
          parsedAt: now,
          status: "parsed",
          findingIds: ["finding-write"],
          challengeIds: [],
          evidenceRefs: [input.worktreePath],
          parseWarnings: [],
        },
      ],
      plans: [],
      findings: [
        {
          id: "finding-write",
          taskId: "task-write",
          authorAgentId: "team-wt-e2e:builder",
          claim: "写入变更只存在于 Builder 的独立 worktree。",
          evidenceRefs: [input.worktreePath],
          confidence: "high",
          status: "accepted",
          challengeIds: [],
          sourceResultId: "result-write",
        },
      ],
      challenges: [],
      decisions:
        input.status === "completed"
          ? [
              {
                id: "decision-final",
                title: "Worktree final decision",
                rationale: "Required task is complete and the isolated worktree has been closed.",
                acceptedFindingIds: ["finding-write"],
                rejectedFindingIds: [],
                challengeIds: [],
                evidenceRefs: [input.worktreePath],
                sourceResultIds: ["result-write"],
                confidence: "high",
                status: "accepted",
                madeByAgentId: "team-wt-e2e:lead",
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
          status: "passed",
          severity: "blocking",
          message: "所有 required task 已完成。",
        },
        {
          id: "gate-worktrees-merged",
          title: "Worktrees merged or discarded",
          status: openWorktree ? "failed" : "passed",
          severity: "blocking",
          message: openWorktree
            ? input.blockedMessage ?? "仍有 1 个 worktree 未合并或未丢弃。"
            : "所有 worktree 已合并、丢弃或关闭。",
        },
      ],
      capabilityAudit: [],
      events: [
        {
          id: "event-worktree-created",
          type: "worktree_created",
          at: now,
          actorAgentId: "team-wt-e2e:lead",
          targetAgentId: "team-wt-e2e:builder",
          message: "Builder isolated worktree created.",
          data: { path: input.worktreePath, repo: input.repo },
        },
      ],
    },
  };
}

async function installWorktreeFixture(page: Page, repo: string, worktreePath: string) {
  const calls: Array<Record<string, unknown>> = [];
  let currentRun: AgentTeamRun | null = null;

  await page.route("**/api/agent/*/teams", async (route: Route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { runs: currentRun ? [currentRun] : [] } });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push(body);

    if (body.type === "start") {
      currentRun = teamRun({ repo, worktreePath });
      return route.fulfill({ json: { ok: true, run: currentRun } });
    }

    if (body.type === "merge_worktree" && body.strategy === "keep_branch") {
      currentRun = teamRun({
        repo,
        worktreePath,
        worktreeStatus: "merge_pending",
        blockedMessage: "Worktree 已保留，需要手动合并或丢弃后才能总结。",
      });
      return route.fulfill({ json: { ok: true, run: currentRun } });
    }

    if (body.type === "merge_worktree" && body.strategy === "discard") {
      currentRun = teamRun({ repo, worktreePath, worktreeStatus: "cleaned" });
      return route.fulfill({ json: { ok: true, run: currentRun } });
    }

    if (body.type === "transition" && body.status === "completed") {
      const hasOpenWorktree = (currentRun ?? teamRun({ repo, worktreePath })).members.some(
        (member) =>
          member.worktree?.status === "active" ||
          member.worktree?.status === "merge_pending"
      );
      if (hasOpenWorktree) {
        currentRun = teamRun({
          repo,
          worktreePath,
          worktreeStatus:
            currentRun?.members.find((member) => member.id === "team-wt-e2e:builder")?.worktree
              ?.status === "merge_pending"
              ? "merge_pending"
              : "active",
        });
        return route.fulfill({
          json: {
            ok: false,
            run: currentRun,
            blockedReasons: ["Team has unmerged worktrees"],
          },
        });
      }
      currentRun = teamRun({
        repo,
        worktreePath,
        worktreeStatus: "cleaned",
        status: "completed",
      });
      return route.fulfill({ json: { ok: true, run: currentRun, blockedReasons: [] } });
    }

    return route.fulfill({ json: { ok: true, run: currentRun ?? teamRun({ repo, worktreePath }) } });
  });

  return calls;
}

test("agent team worktree: unresolved worktree blocks finalize until closed", async ({
  bootedPage: page,
}) => {
  const { repo, worktreePath } = createGitFixture();
  const calls = await installWorktreeFixture(page, repo, worktreePath);

  await editor(page).fill("/team Team worktree E2E：验证独立改动区阻止提前总结");
  await expect(page.getByTestId("mode-chip-team")).toBeVisible();
  await sendBtn(page).click();
  await expect(page.getByText("准备启动团队协作")).toBeVisible();
  await page.getByRole("button", { name: "开始" }).click();

  await expect.poll(() => calls.some((call) => call.type === "start")).toBe(true);
  const workspace = page.getByTestId("agent-team-workspace");
  await expect(workspace).toBeVisible();
  await workspace.getByRole("button", { name: "查看过程" }).click();
  const worktreeItem = page.getByTestId("agent-team-worktree-item");
  await expect(worktreeItem).toContainText("team/builder-e2e");
  await expect(worktreeItem).toContainText(path.basename(worktreePath));

  await page
    .getByTestId("agent-team-run-card")
    .getByRole("button", { name: "生成总结" })
    .click();
  await expect(page.getByText("还有独立改动区没有处理。")).toBeVisible();

  await worktreeItem.getByRole("button", { name: "保留" }).click();
  await expect
    .poll(() =>
      calls.some(
        (call) =>
          call.type === "merge_worktree" &&
          call.memberId === "team-wt-e2e:builder" &&
          call.strategy === "keep_branch"
      )
    )
    .toBe(true);
  await expect(worktreeItem).toContainText("待手动处理");

  const transitionCount = calls.filter((call) => call.type === "transition").length;
  await page
    .getByTestId("agent-team-run-card")
    .getByRole("button", { name: "生成总结" })
    .click();
  await expect
    .poll(() => calls.filter((call) => call.type === "transition").length)
    .toBe(transitionCount + 1);
  await expect(page.getByText("还有独立改动区没有处理。")).toBeVisible();

  await worktreeItem.getByRole("button", { name: "丢弃" }).click();
  await expect
    .poll(() =>
      calls.some(
        (call) =>
          call.type === "merge_worktree" &&
          call.memberId === "team-wt-e2e:builder" &&
          call.strategy === "discard"
      )
    )
    .toBe(true);
  await expect(worktreeItem).toContainText("已清理");

  await page
    .getByTestId("agent-team-run-card")
    .getByRole("button", { name: "生成总结" })
    .click();
  await expect(
    page.getByRole("main").getByText("Required task is complete and the isolated worktree has been closed.")
  ).toBeVisible();
});

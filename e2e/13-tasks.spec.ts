import { installApiFixtures, test, expect } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import type {
  LongTaskDashboard,
  LongTaskDefinition,
  LongTaskRun,
  TaskFinding,
} from "@/lib/tasks/types";

async function installTasksFixture(page: Page) {
  await page.addInitScript(() => {
    const now = Date.now();
    (window as unknown as { __tasksDashboard: LongTaskDashboard }).__tasksDashboard = {
      tasks: [],
      runs: [],
      findings: [],
      dueTasks: [],
      inboxCount: 0,
    };
    (window as unknown as { __taskNow: number }).__taskNow = now;
  });

  await page.route("**/api/tasks", async (route: Route) => {
    const method = route.request().method();
    const dashboard = await page.evaluate(() => {
      const w = window as unknown as { __tasksDashboard: LongTaskDashboard };
      return w.__tasksDashboard;
    });
    if (method === "GET") return route.fulfill({ json: dashboard });

    const body = JSON.parse(route.request().postData() ?? "{}") as Record<
      string,
      unknown
    >;
    const next = await page.evaluate((input) => {
      const w = window as unknown as { __tasksDashboard: LongTaskDashboard };
      const dash = w.__tasksDashboard;
      const now = Date.now();
      if (input.type === "create") {
        const task: LongTaskDefinition = {
          id: "task-1",
          title: String(input.title),
          prompt: String(input.prompt),
          projectPath: String(input.projectPath),
          provider: String(input.provider),
          modelId: String(input.modelId),
          cadence: input.cadence === "daily" ? "daily" : "manual",
          enabled: true,
          skillIds: [],
          permissionPolicy: {
            requireApprovalBeforeWrite: true,
            requireApprovalBeforeNetwork: true,
            maxDurationMinutes: 60,
          },
          status: "scheduled",
          createdAt: now,
          updatedAt: now,
          nextRunAt: now - 1000,
        };
        dash.tasks = [task];
        dash.dueTasks = [task];
        return { task, dashboard: dash };
      }
      if (input.type === "run_due" || input.type === "run") {
        const task = dash.tasks[0]!;
        const run: LongTaskRun = {
          id: "run-1",
          taskId: task.id,
          status: "completed_with_findings",
          startedAt: now,
          updatedAt: now,
          endedAt: now,
          summary: "发现 1 个需要你处理的新事项。",
          findingIds: ["finding-1"],
        };
        const finding: TaskFinding = {
          id: "finding-1",
          taskId: task.id,
          runId: run.id,
          title: "CI 连续失败",
          body: "主分支 CI 在登录流程上连续失败，需要你确认是否优先处理。",
          severity: "critical",
          status: "unread",
          createdAt: now,
          updatedAt: now,
        };
        dash.runs = [run];
        dash.findings = [finding];
        dash.inboxCount = 1;
        dash.dueTasks = [];
        dash.tasks = [{ ...task, status: "completed", lastRunId: run.id }];
        return { dashboard: dash };
      }
      if (input.type === "finding_status") {
        dash.findings = dash.findings.map((finding) =>
          finding.id === input.id
            ? { ...finding, status: String(input.status) as TaskFinding["status"] }
            : finding
        );
        dash.inboxCount = dash.findings.filter((f) => f.status === "unread").length;
        return { dashboard: dash };
      }
      return { dashboard: dash };
    }, body);
    return route.fulfill({ json: { ok: true, ...next } });
  });
}

test("tasks: create, run due, and resolve inbox finding", async ({ page }) => {
  await installApiFixtures(page);
  await installTasksFixture(page);

  await page.goto("/tasks");
  await expect(page.getByText("长期任务", { exact: true })).toBeVisible();

  await page.getByPlaceholder("例如：每日检查 CI 和高优先级反馈").fill("每日检查 CI");
  await page
    .getByPlaceholder("告诉 Diga 需要持续关注什么、什么情况下需要汇报、什么时候等待你确认。")
    .fill("每天检查 CI 和高优先级用户反馈，有异常时汇报。");
  await page.getByLabel("运行频率").selectOption("daily");
  await page.getByRole("button", { name: /保存任务/ }).click();

  await expect(page.getByText("每日检查 CI").first()).toBeVisible();
  await expect(page.getByText("到期", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /运行到期任务/ }).click();
  await expect(page.getByText("CI 连续失败")).toBeVisible();
  await expect(page.getByText("发现 1 个需要你处理的新事项。")).toBeVisible();

  await page.getByRole("button", { name: "已解决" }).click();
  await expect(page.getByText("当前没有需要你处理的新事项。")).toBeVisible();
});

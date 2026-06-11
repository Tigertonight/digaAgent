import { installApiFixtures, installSseMock, test, expect } from "./fixtures";
import type { LongTaskDashboard } from "@/lib/tasks/types";

function textMessage(text: string) {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

test("mobile: 长会话加载更早内容使用分页 cursor", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await installSseMock(page);
  await installApiFixtures(page, {
    sessionsResponse: {
      sessions: [
        {
          id: "mobile-long-session",
          path: "/tmp/e2e-sessions/mobile-long-session.jsonl",
          cwd: "/tmp/e2e-cwd",
          name: "Mobile long session",
          firstMessage: "Mobile long session",
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 160,
          isRunning: false,
        },
      ],
    },
  });
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "mini-pi-remote",
      JSON.stringify({
        token: "remote-token",
        deviceId: "device-1",
        baseUrl: window.location.origin,
        candidates: [window.location.origin],
        instanceId: "instance-1",
      })
    );
  });

  const contextUrls: string[] = [];
  await page.route("**/api/sessions/mobile-long-session/context**", async (route) => {
    const url = route.request().url();
    contextUrls.push(url);
    const parsed = new URL(url);
    if (parsed.searchParams.has("before")) {
      return route.fulfill({
        json: {
          messages: [textMessage("older page marker")],
          beforeCursor: null,
          hasMoreBefore: false,
        },
      });
    }
    return route.fulfill({
      json: {
        messages: Array.from({ length: 80 }, (_, index) =>
          textMessage(`tail message ${index + 1}`)
        ),
        beforeCursor: 120,
        hasMoreBefore: true,
        truncatedBefore: 120,
      },
    });
  });

  await page.goto("/mobile");
  await page.getByTitle("会话").click();
  await page.getByText("Mobile long session").click();

  await expect(page.getByText("tail message 80", { exact: true })).toBeVisible();
  await expect(page.getByText("tail message 1", { exact: true })).not.toBeVisible();

  await page.getByRole("button", { name: /加载更早/ }).click();
  await page.getByRole("button", { name: /加载更早/ }).click();
  await expect(page.getByText("tail message 1", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /加载更早内容/ }).click();
  await expect(page.getByText("older page marker")).toBeVisible();
  expect(contextUrls.some((url) => new URL(url).searchParams.get("before") === "120")).toBe(true);
});

test("mobile: shows long-task inbox and resolves findings", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await installSseMock(page);
  await installApiFixtures(page);
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "mini-pi-remote",
      JSON.stringify({
        token: "remote-token",
        deviceId: "device-1",
        baseUrl: window.location.origin,
        candidates: [window.location.origin],
        instanceId: "instance-1",
      })
    );
    const now = Date.now();
    (window as unknown as { __mobileTasks: LongTaskDashboard }).__mobileTasks = {
      tasks: [
        {
          id: "task-1",
          title: "每日检查线上反馈",
          prompt: "检查高优先级反馈。",
          projectPath: "/tmp/e2e-cwd",
          provider: "openai-codex",
          modelId: "gpt-5.5",
          cadence: "daily",
          enabled: true,
          skillIds: [],
          permissionPolicy: {
            requireApprovalBeforeWrite: true,
            requireApprovalBeforeNetwork: true,
            maxDurationMinutes: 60,
          },
          status: "completed",
          createdAt: now,
          updatedAt: now,
          lastRunId: "run-1",
          lastSummary: "发现 1 个需要处理的反馈。",
        },
      ],
      runs: [
        {
          id: "run-1",
          taskId: "task-1",
          status: "completed_with_findings",
          startedAt: now,
          updatedAt: now,
          endedAt: now,
          summary: "发现 1 个需要处理的反馈。",
          checkpoints: [
            {
              id: "checkpoint-1",
              kind: "completed",
              title: "任务完成，发现需要处理的事项",
              createdAt: now,
            },
          ],
          findingIds: ["finding-1"],
        },
      ],
      findings: [
        {
          id: "finding-1",
          taskId: "task-1",
          runId: "run-1",
          title: "移动端登录反馈升高",
          body: "过去一小时有多条移动端登录失败反馈，需要确认是否优先处理。",
          severity: "warning",
          status: "unread",
          createdAt: now,
          updatedAt: now,
        },
      ],
      dueTasks: [],
      inboxCount: 1,
      scheduler: {
        enabled: true,
        intervalMs: 60000,
        running: false,
        lastCheckedAt: now,
        lastStartedCount: 0,
      },
    };
  });
  await page.goto("/mobile");

  await expect(page.getByText("任务收件箱")).toBeVisible();
  await expect(page.getByText("移动端登录反馈升高")).toBeVisible();
  await expect(page.getByText(/最近状态：任务完成/)).toBeVisible();
  await expect(page.getByText("1 待办")).toBeVisible();
  await page.getByRole("button", { name: "查看报告" }).click();
  await expect(page.getByText("任务报告")).toBeVisible();
  const reportSheet = page.getByTestId("mobile-task-report-sheet");
  await expect(
    reportSheet.getByText("过去一小时有多条移动端登录失败反馈，需要确认是否优先处理。")
  ).toBeVisible();
  await expect(reportSheet.getByText("执行时间线")).toBeVisible();

  await reportSheet.getByRole("button", { name: "已解决" }).click();
  await expect(page.getByText("移动端登录反馈升高")).not.toBeVisible();
});

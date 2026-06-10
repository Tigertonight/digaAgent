import { installApiFixtures, installSseMock, test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const editor = (page: Page) => page.locator("textarea").first();
const sendBtn = (page: Page) => page.getByRole("button", { name: /^Send$/ });

async function activeAgentId(page: Page): Promise<string> {
  const handle = await page.waitForFunction(() => {
    const w = window as unknown as {
      __mockEventSources: Array<{ url: string; readyState: number }>;
    };
    const open = [...w.__mockEventSources]
      .reverse()
      .find((h) => h.readyState === 1);
    if (!open) return null;
    const m = open.url.match(/\/api\/agent\/([^/]+)\/events/);
    return m ? m[1] : null;
  });
  return (await handle.jsonValue()) as string;
}

test("reliability: pending approval 可通过 snapshot 恢复为审批气泡", async ({
  bootedPage: page,
}) => {
  await page.route("**/api/agent/*/approval", async (route) => {
    const method = route.request().method();
    const url = route.request().url();
    const agentId = url.match(/\/api\/agent\/([^/]+)\/approval/)?.[1];
    if (method === "GET") {
      return route.fulfill({
        json: {
          approvals: [
            {
              id: `${agentId}:tool-restored`,
              agentId,
              toolCallId: "tool-restored",
              toolName: "bash",
              input: { command: "rm -rf /tmp/e2e-danger" },
              reason: "rule",
              ruleId: "dangerous-bash-destructive",
              defaultDecision: "deny",
              createdAt: Date.now(),
            },
          ],
        },
      });
    }
    return route.fulfill({ json: { ok: true } });
  });

  await editor(page).fill("trigger approval restore");
  await sendBtn(page).click();
  await activeAgentId(page);

  await expect(page.getByText(/需要确认：bash/)).toBeVisible();
  await expect(page.getByText("rm -rf /tmp/e2e-danger")).toBeVisible();
});

test("reliability: 桌面端首次 SSE attach 只监听最新事件", async ({
  bootedPage: page,
}) => {
  await editor(page).fill("check first sse cursor");
  await sendBtn(page).click();
  await activeAgentId(page);

  const latestOpenUrl = await page.evaluate(() => {
    const w = window as unknown as {
      __mockEventSources: Array<{ url: string; readyState: number }>;
    };
    return [...w.__mockEventSources]
      .reverse()
      .find((h) => h.readyState === 1)?.url;
  });

  expect(latestOpenUrl).toContain("since=latest");
});

test("reliability: pending clarification 可恢复并提交推荐项", async ({
  bootedPage: page,
}) => {
  let posted: unknown = null;
  await page.route("**/api/agent/*/clarification", async (route) => {
    const method = route.request().method();
    const url = route.request().url();
    const agentId = url.match(/\/api\/agent\/([^/]+)\/clarification/)?.[1];
    if (method === "GET") {
      return route.fulfill({
        json: {
          clarifications: [
            {
              id: `${agentId}:q-restored`,
              agentId,
              requestId: "q-restored",
              title: "需要你确认下一步",
              question: "先做 MVP 还是完整重构？",
              context: "两条路径成本不同。",
              options: [
                {
                  id: "mvp",
                  label: "先做 MVP",
                  description: "更快闭环，不影响现有布局",
                  value: "先实现 MVP",
                },
                {
                  id: "full",
                  label: "完整重构",
                  description: "长期更干净，但风险更高",
                  value: "完整重构",
                },
              ],
              recommendedOptionId: "mvp",
              createdAt: Date.now(),
            },
          ],
        },
      });
    }
    posted = await route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });

  await editor(page).fill("trigger clarification restore");
  await sendBtn(page).click();
  await activeAgentId(page);

  await expect(page.getByText("需要你确认下一步")).toBeVisible();
  await expect(page.getByText("先做 MVP 还是完整重构？")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /推荐\s+先做 MVP/ })
  ).toBeVisible();

  await page.getByRole("button", { name: /先做 MVP/ }).click();
  await expect.poll(() => posted).toEqual({
    requestId: "q-restored",
    selectedOptionId: "mvp",
  });
});

test("reliability: 搜索冷构建显示 building 和 timeout 提示", async ({
  bootedPage: page,
}) => {
  await page.route("**/api/search", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    return route.fulfill({
      json: {
        results: [],
        builtAt: Date.now(),
        durationMs: 10_000,
        totalDocs: 0,
        indexStatus: "rebuilt",
        indexBuildMs: 10_000,
      },
    });
  });

  await page.getByPlaceholder("搜索全部 session…").fill("slow query");

  await expect(page.getByText(/Building index/)).toBeVisible();
  await expect(
    page.getByText(/Building index is taking longer than usual/)
  ).toBeVisible({ timeout: 7_000 });
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("reliability: 切换历史 session 不触发 prompt POST", async ({
  page,
}) => {
  const sessions = [
    {
      id: "session-a",
      path: "/tmp/e2e-sessions/session-a.jsonl",
      cwd: "/tmp/e2e-cwd",
      name: "Switch A",
      firstMessage: "Switch A",
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: 1,
      isRunning: false,
    },
    {
      id: "session-b",
      path: "/tmp/e2e-sessions/session-b.jsonl",
      cwd: "/tmp/e2e-cwd",
      name: "Switch B",
      firstMessage: "Switch B",
      created: new Date().toISOString(),
      modified: new Date(Date.now() - 1000).toISOString(),
      messageCount: 1,
      isRunning: false,
    },
  ];
  const promptPosts: unknown[] = [];

  await installSseMock(page);
  await installApiFixtures(page, { sessionsResponse: { sessions } });
  await page.route("**/api/sessions/*/context", async (route) => {
    return route.fulfill({
      json: {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "restored historical prompt" }],
          },
        ],
        forkableUserMessages: [],
      },
    });
  });
  await page.route("**/api/agent/*", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      if (body?.type === "prompt") {
        promptPosts.push(body);
      }
    }
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto("/?e2e=1");
  await page.getByText("Switch A").click();
  await page.waitForTimeout(200);
  await page.getByText("Switch B").click();
  await page.waitForTimeout(200);

  expect(promptPosts).toEqual([]);
});

import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const editor = (page: Page) => page.locator("textarea").first();
const sendBtn = (page: Page) => page.getByTitle("Send", { exact: true });

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

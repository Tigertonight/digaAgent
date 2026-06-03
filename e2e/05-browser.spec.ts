import { test, expect, pushSseEvent } from "./fixtures";
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

test("browser panel: browser_state SSE 同步截图和操作日志", async ({
  bootedPage: page,
}) => {
  await editor(page).fill("verify localhost in browser");
  await sendBtn(page).click();
  const agentId = await activeAgentId(page);

  await page.getByLabel("Browser 面板").click();
  await expect(page.getByText("Open a URL or ask the agent")).toBeVisible();

  await pushSseEvent(
    page,
    agentId,
    {
      type: "browser_state",
      snapshot: {
        status: "ready",
        url: "http://localhost:3000/settings",
        title: "Settings",
        screenshotDataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        updatedAt: Date.now(),
        error: null,
        logs: [
          {
            id: "log-1",
            action: "open",
            label: "http://localhost:3000/settings",
            status: "done",
            createdAt: Date.now(),
            completedAt: Date.now(),
          },
        ],
      },
    },
    "20"
  );

  await expect(
    page.locator('input[value="http://localhost:3000/settings"]')
  ).toBeVisible();
  await expect(page.getByText("READY")).toBeVisible();
  await expect(page.getByText("· Settings")).toBeVisible();
  await expect(page.getByAltText("Browser screenshot")).toBeVisible();
  await expect(page.getByText("Browser actions")).toBeVisible();
  await expect(page.getByText("open")).toBeVisible();
  await expect(page.getByText("http://localhost:3000/settings")).toBeVisible();
});

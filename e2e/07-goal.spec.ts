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

test("goal: slash command sets goal and renders goal bar updates", async ({
  bootedPage: page,
}) => {
  const actions: string[] = [];
  const goalSetPayload = page.waitForRequest((req) => {
    if (!req.url().match(/\/api\/agent\/[^/]+$/)) return false;
    if (req.method() !== "POST") return false;
    const body = req.postData() ?? "";
    return body.includes('"type":"goal_set"') && body.includes("Ship durable goal mode");
  });

  await page.route("**/api/agent/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.endsWith("/api/agent/new") || url.includes("/events") || req.method() !== "POST") {
      return route.fallback();
    }
    const body = req.postDataJSON() as { type?: string };
    if (body.type?.startsWith("goal_")) actions.push(body.type);
    return route.fulfill({ json: { ok: true } });
  });

  await page.waitForFunction(() => {
    try {
      return Boolean(
        localStorage.getItem("pi-provider-id") &&
          localStorage.getItem("pi-model-id")
      );
    } catch {
      return false;
    }
  });
  await page.waitForTimeout(500);
  await editor(page).fill("/goal Ship durable goal mode");
  await expect(sendBtn(page)).toBeEnabled();
  await sendBtn(page).click();
  await goalSetPayload;

  const agentId = await activeAgentId(page);
  await pushSseEvent(
    page,
    agentId,
    {
      type: "goal_updated",
      goal: {
        objective: "Ship durable goal mode",
        status: "active",
        turns: 1,
        blockedStreak: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
    "20"
  );

  await expect(page.getByTestId("goal-bar")).toBeVisible();
  await expect(page.getByText("Ship durable goal mode")).toBeVisible();
  await expect(page.getByLabel("Pause goal")).toBeVisible();

  await pushSseEvent(
    page,
    agentId,
    {
      type: "progress_updated",
      progress: {
        steps: [
          {
            id: "inspect",
            title: "Inspect goal runtime",
            status: "completed",
            summary: "Found current goal mode surfaces.",
          },
          {
            id: "ship",
            title: "Ship progress panel",
            status: "running",
          },
        ],
        artifacts: [
          {
            id: "local",
            kind: "url",
            title: "localhost:3000",
            href: "http://localhost:3000",
            createdAt: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      },
    },
    "21"
  );
  await expect(page.getByTestId("progress-panel")).toBeVisible();
  await expect(page.getByText("Inspect goal runtime")).toBeVisible();
  await expect(page.getByText("Ship progress panel")).toBeVisible();
  await expect(page.getByText("localhost:3000")).toBeVisible();

  await page.getByLabel("Pause goal").click();
  await expect.poll(() => actions).toContain("goal_pause");

  await pushSseEvent(
    page,
    agentId,
    {
      type: "goal_updated",
      goal: {
        objective: "Ship durable goal mode",
        status: "paused",
        turns: 1,
        blockedStreak: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
    "22"
  );
  await page.getByLabel("Resume goal").click();
  await expect.poll(() => actions).toContain("goal_resume");

  await page.getByLabel("Clear goal").click();
  await expect.poll(() => actions).toContain("goal_clear");
});

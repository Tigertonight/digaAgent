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

async function pushAssistantMessage(
  page: Page,
  agentId: string,
  text: string,
  startSeq = 1
) {
  await pushSseEvent(page, agentId, { type: "agent_start" }, String(startSeq));
  await pushSseEvent(
    page,
    agentId,
    {
      type: "message_start",
      message: { role: "assistant", timestamp: Date.now() },
    },
    String(startSeq + 1)
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    },
    String(startSeq + 2)
  );
  await pushSseEvent(page, agentId, { type: "agent_end" }, String(startSeq + 3));
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
        steps: [
          {
            id: "log-1",
            action: "open",
            label: "http://localhost:3000/settings",
            status: "done",
            url: "http://localhost:3000/settings",
            title: "Settings",
            screenshotDataUrl:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
            createdAt: Date.now(),
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
  await expect(page.getByText("Browser actions", { exact: true })).toBeVisible();
  await expect(page.getByText("open").first()).toBeVisible();
  await expect(page.getByTitle("http://localhost:3000/settings").first()).toBeVisible();
  await expect(page.getByText("Step timeline")).toBeVisible();
  await page.getByRole("button", { name: /open/ }).last().click();
  await expect(page.getByText("replay")).toBeVisible();

  const shot = page.getByAltText("Browser screenshot");
  const box = await shot.boundingBox();
  if (!box) throw new Error("screenshot missing bounding box");
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55);
  await page.mouse.up();
  await page.getByLabel("Browser annotation comment").fill("Button overlaps here");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(editor(page)).toHaveValue(/Button overlaps here/);
});

test("browser panel: browser_state 自动展开并显示虚拟鼠标", async ({
  bootedPage: page,
}) => {
  await editor(page).fill("search with browser");
  await sendBtn(page).click();
  const agentId = await activeAgentId(page);

  await expect(page.getByText("Open a URL or ask the agent")).toBeHidden();

  await pushSseEvent(
    page,
    agentId,
    {
      type: "browser_state",
      snapshot: {
        status: "ready",
        url: "https://www.baidu.com/s?wd=%E8%BF%AA%E8%BF%A6",
        title: "百度搜索",
        screenshotDataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        updatedAt: Date.now(),
        error: null,
        pointer: {
          x: 0.42,
          y: 0.34,
          action: "click",
          label: "#kw",
          updatedAt: Date.now(),
        },
        logs: [
          {
            id: "log-click",
            action: "click",
            label: "#kw",
            status: "done",
            createdAt: Date.now(),
            completedAt: Date.now(),
          },
        ],
        steps: [],
      },
    },
    "20"
  );

  await expect(page.getByText("READY")).toBeVisible();
  await expect(page.getByAltText("Browser screenshot")).toBeVisible();
  await expect(page.getByLabel("Browser virtual cursor")).toBeVisible();
  await expect(page.getByText("click").first()).toBeVisible();
});

test("browser panel: 外部站点需要显式 allow,本地站点自动允许", async ({
  bootedPage: page,
}) => {
  let externalDecision = "unknown";
  await page.route("**/api/browser/policy**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const target = url.searchParams.get("url") ?? "https://example.com";
    const origin = target.includes("localhost")
      ? "http://localhost:3000"
      : "https://example.com";
    if (method === "GET") {
      const decision = origin.includes("localhost")
        ? "local"
        : externalDecision;
      return route.fulfill({
        json: {
          origin,
          decision,
          policy: {
            allowedOrigins: decision === "allowed" ? [origin] : [],
            blockedOrigins: decision === "blocked" ? [origin] : [],
          },
        },
      });
    }
    const body = (await route.request().postDataJSON()) as { type?: string };
    externalDecision = body.type === "allow" ? "allowed" : body.type === "block" ? "blocked" : "unknown";
    return route.fulfill({ json: { ok: true, origin, policy: {} } });
  });

  await editor(page).fill("open browser");
  await sendBtn(page).click();
  await activeAgentId(page);
  await page.getByLabel("Browser 面板").click();

  const urlInput = page.getByLabel("Browser URL");
  await urlInput.fill("https://example.com/docs");
  await expect(page.getByText("unknown", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByText("allowed", { exact: true })).toBeVisible();

  await urlInput.fill("http://localhost:3000/settings");
  await expect(page.getByText("local", { exact: true })).toBeVisible();
});

test("browser panel: assistant 链接点击后在右侧打开而不是外跳", async ({
  bootedPage: page,
}) => {
  const popupEvents: Page[] = [];
  page.on("popup", (popup) => popupEvents.push(popup));

  await editor(page).fill("return a browser link");
  await sendBtn(page).click();
  const agentId = await activeAgentId(page);
  await pushAssistantMessage(
    page,
    agentId,
    "这里是链接：[Fixture](http://localhost:3000/browser-task-fixture.html)",
    30
  );

  await page.getByRole("link", { name: "Fixture" }).click();

  await expect(page.getByLabel("Browser URL")).toHaveValue(
    "http://localhost:3000/browser-task-fixture.html"
  );
  await expect(page.getByText("Browser actions", { exact: true })).toBeVisible();
  expect(popupEvents).toHaveLength(0);
});

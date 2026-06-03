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

test("composer: queue_update 显示 queued follow-up 内容", async ({
  bootedPage: page,
}) => {
  await editor(page).fill("start task");
  await sendBtn(page).click();
  const agentId = await activeAgentId(page);

  await pushSseEvent(
    page,
    agentId,
    {
      type: "queue_update",
      steering: [],
      followUp: ["run tests after the current edit", "then summarize changes"],
    },
    "10"
  );

  await expect(page.getByText("Queued 2 messages")).toBeVisible();
  await page.getByText("Queued 2 messages").click();
  await expect(page.getByText("run tests after the current edit")).toBeVisible();
  await expect(page.getByText("then summarize changes")).toBeVisible();
});

test("composer: ArrowUp/ArrowDown 召回输入历史", async ({
  bootedPage: page,
}) => {
  await editor(page).fill("first prompt");
  await sendBtn(page).click();
  await expect(editor(page)).toHaveValue("");

  await editor(page).fill("second prompt");
  await sendBtn(page).click();
  await expect(editor(page)).toHaveValue("");

  await editor(page).focus();
  await page.keyboard.press("ArrowUp");
  await expect(editor(page)).toHaveValue("second prompt");

  await page.keyboard.press("ArrowUp");
  await expect(editor(page)).toHaveValue("first prompt");

  await page.keyboard.press("ArrowDown");
  await expect(editor(page)).toHaveValue("second prompt");

  await page.keyboard.press("ArrowDown");
  await expect(editor(page)).toHaveValue("");
});

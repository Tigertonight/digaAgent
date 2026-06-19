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

test("tool truncation: write validation failure shows segmented recovery", async ({
  bootedPage: page,
}) => {
  await editor(page).fill("create a long audit report");
  await sendBtn(page).click();
  const agentId = await activeAgentId(page);

  await pushSseEvent(page, agentId, { type: "agent_start" }, "20");
  await pushSseEvent(
    page,
    agentId,
    {
      type: "tool_execution_start",
      toolCallId: "tool-truncated-write",
      toolName: "write",
      args: { path: "docs/report.md" },
    },
    "21",
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "tool_execution_end",
      toolCallId: "tool-truncated-write",
      isError: true,
      result: {
        content: [
          {
            type: "text",
            text:
              'Validation failed for tool "write":\n' +
              "  - content: must have required properties content",
          },
        ],
      },
    },
    "22",
  );

  await page
    .locator('button[title="展开细节"]')
    .filter({ hasText: "执行失败：写入 docs/report.md" })
    .click();
  await page.locator('[data-testid="tool-frame"] > button').click();
  await expect(page.getByText("工具参数被截断")).toBeVisible();
  await expect(page.getByText(/先写短骨架/)).toBeVisible();
  await expect(page.getByText(/字段：content/)).toBeVisible();
});

test("tool truncation: workflow script failure recommends draftRef", async ({
  bootedPage: page,
}) => {
  await editor(page).fill("/workflow audit session code");
  await sendBtn(page).click();
  const agentId = await activeAgentId(page);

  await pushSseEvent(page, agentId, { type: "agent_start" }, "30");
  await pushSseEvent(
    page,
    agentId,
    {
      type: "tool_execution_start",
      toolCallId: "tool-truncated-workflow",
      toolName: "run_workflow_script",
      args: { objective: "audit session code", rationale: "needs harness" },
    },
    "31",
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "tool_execution_end",
      toolCallId: "tool-truncated-workflow",
      isError: true,
      result:
        "run_workflow_script received neither a script, a valid draftRef, nor a valid skillRef. If you intended to pass a large inline script, it was likely truncated.",
    },
    "32",
  );

  await page
    .locator('button[title="展开细节"]')
    .filter({ hasText: "执行失败：调用 run workflow script" })
    .click();
  await page.locator('[data-testid="tool-frame"] > button').click();
  await expect(page.getByText("工具参数被截断")).toBeVisible();
  await expect(page.getByText(/保存为 draft/)).toBeVisible();
  await expect(page.getByText(/字段：script/)).toBeVisible();
});

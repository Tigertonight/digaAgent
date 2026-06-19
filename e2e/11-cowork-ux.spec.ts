import { test as base, expect } from "@playwright/test";
import { installApiFixtures, installSseMock, pushSseEvent } from "./fixtures";

const unauthProviders = {
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      hasAuth: false,
      models: [
        {
          id: "gpt-4o-mini",
          name: "GPT-4o mini",
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
    },
  ],
  total: 1,
  authedCount: 0,
  defaultProvider: "openai",
  defaultModelId: "gpt-4o-mini",
};

base("cowork ux: composer explains why send is blocked", async ({ page }) => {
  await installSseMock(page);
  await installApiFixtures(page, { providersResponse: unauthProviders });
  await page.goto("/?e2e=1");
  await page.evaluate(() => {
    try {
      localStorage.clear();
      localStorage.setItem("pi-provider-id", "openai");
      localStorage.setItem("pi-model-id", "gpt-4o-mini");
    } catch {}
  });
  await page.reload();

  await expect(page.getByTestId("composer-readiness")).toContainText("没有可用模型");
  await page.locator("textarea").first().fill("hello");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  await page.getByTestId("composer-readiness").getByRole("button", { name: "配置模型" }).click();
  await expect(page.getByRole("heading", { name: "开始使用 Diga Agent" })).toBeVisible();
  await expect(page.getByText("本地 / 自定义端点")).toBeVisible();
});

async function activeAgentId(page: import("@playwright/test").Page): Promise<string> {
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

base("cowork ux: tool calls show narration and expandable details", async ({
  page,
}) => {
  await installSseMock(page);
  await installApiFixtures(page);
  await page.goto("/?e2e=1");
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {}
  });
  await page.reload();

  await page.locator("textarea").first().fill("run tool narration");
  await page.getByTitle("Send", { exact: true }).click();
  const agentId = await activeAgentId(page);

  await pushSseEvent(
    page,
    agentId,
    {
      type: "message_start",
      message: {
        role: "assistant",
        responseId: "tool-narration-msg",
        content: [],
        timestamp: Date.now(),
      },
    },
    "tool-1"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "/tmp/e2e-cwd/app.tsx", offset: 1, limit: 20 },
    },
    "tool-2"
  );

  await expect(page.getByTestId("assistant-process-group")).toBeVisible();
  await expect(page.getByText(/处理中 \d+ 秒/)).toBeVisible();
  await expect(page.getByTestId("assistant-process-group")).toContainText("正在查看");
  await expect(page.getByText("(empty)")).toBeHidden();

  await page.getByRole("button", { name: /正在查看 .*app\.tsx/ }).last().click();
  await expect(
    page.getByRole("button", { name: /正在查看 .*app\.tsx/ }).first()
  ).toBeVisible();

  await pushSseEvent(
    page,
    agentId,
    {
      type: "tool_execution_end",
      toolCallId: "read-1",
      result: [{ type: "text", text: "const ok = true;" }],
      isError: false,
    },
    "tool-3"
  );
  await expect(page.getByTestId("assistant-process-group")).toBeVisible();

  await pushSseEvent(
    page,
    agentId,
    {
      type: "tool_execution_start",
      toolCallId: "test-1",
      toolName: "bash",
      args: { command: "npm run test" },
    },
    "tool-4"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "tool_execution_end",
      toolCallId: "test-1",
      result: { stderr: "timeout waiting for worker" },
      isError: true,
    },
    "tool-5"
  );

  await expect(page.getByText(/验证：npm run test.*曾失败/)).toBeVisible();
  await page.getByTestId("assistant-process-toggle").click();
  await expect(page.getByText("执行失败：验证：npm run test")).toBeVisible();
});

base("cowork ux: final answer collapses intermediate execution steps", async ({
  page,
}) => {
  await installSseMock(page);
  await installApiFixtures(page);
  await page.goto("/?e2e=1");
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {}
  });
  await page.reload();

  await page.locator("textarea").first().fill("start project");
  await page.getByTitle("Send", { exact: true }).click();
  const agentId = await activeAgentId(page);

  await pushSseEvent(
    page,
    agentId,
    {
      type: "message_start",
      message: {
        role: "assistant",
        responseId: "process-msg",
        content: [],
        timestamp: Date.now(),
      },
    },
    "collapse-1"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "tool_execution_start",
      toolCallId: "bash-collapse",
      toolName: "bash",
      args: { command: "npm run dev" },
    },
    "collapse-2"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "tool_execution_end",
      toolCallId: "bash-collapse",
      result: { stdout: "ready on 5173" },
      isError: false,
    },
    "collapse-3"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "tool_execution_start",
      toolCallId: "browser-collapse",
      toolName: "browser_open",
      args: { url: "http://127.0.0.1:5173/" },
    },
    "collapse-3b"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "tool_execution_end",
      toolCallId: "browser-collapse",
      result: { error: "In-app browser host is not connected" },
      isError: true,
    },
    "collapse-3c"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
      },
    },
    "collapse-4"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "message_start",
      message: {
        role: "assistant",
        responseId: "final-msg",
        content: [],
        timestamp: Date.now() + 1,
      },
    },
    "collapse-5"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "项目已启动，访问 http://127.0.0.1:5173/ 即可。",
      },
    },
    "collapse-6"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "项目已启动，访问 http://127.0.0.1:5173/ 即可。",
          },
        ],
      },
    },
    "collapse-7"
  );
  await pushSseEvent(page, agentId, { type: "agent_end" }, "collapse-8");

  await expect(page.getByText("项目已启动，访问")).toBeVisible();
  await expect(page.getByTestId("assistant-process-group")).toBeVisible();
  await expect(page.getByText(/已处理/)).toBeVisible();
  await expect(page.getByText("In-app browser host is not connected")).toBeHidden();

  await page.getByTestId("assistant-process-toggle").click();
  await expect(page.getByText("执行失败：打开页面：http://127.0.0.1:5…")).toBeVisible();
});

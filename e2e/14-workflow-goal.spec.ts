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

function workflowRun(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "workflow-e2e",
    parentAgentId: "agent-1",
    objective: "Audit latest session workflow behavior",
    rationale: "Reproduce workflow/goal/subagent session issues.",
    status: "running",
    script: "workflow.checkpoint('recon-done', true);",
    manifest: {
      capabilities: ["spawn_agent", "read_files"],
      maxAgents: 8,
      maxConcurrency: 4,
      timeoutMs: 600000,
      runtime: "process",
    },
    checkpoints: [],
    artifacts: [],
    logs: [],
    traceEvents: [],
    createdAt: now,
    ...overrides,
  };
}

test("workflow/goal: explicit /goal overrides an active Workflow chip before sending", async ({
  bootedPage: page,
}) => {
  const agentPosts: unknown[] = [];

  await page.route("**/api/agent/*", async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    if (!pathname.match(/^\/api\/agent\/[^/]+$/) || req.method() !== "POST") {
      return route.fallback();
    }
    const body = req.postDataJSON() as { type?: string };
    if (body.type === "goal_set" || body.type === "prompt") {
      agentPosts.push(body);
    }
    return route.fulfill({ json: { ok: true } });
  });

  await editor(page).fill("/workflow inspect workflow mode");
  await expect(page.getByTestId("mode-chip-workflow")).toBeVisible();
  await expect(editor(page)).toHaveValue("inspect workflow mode");

  await editor(page).fill("/goal ");
  await sendBtn(page).click();

  await expect(page.getByTestId("mode-chip-goal")).toBeVisible();
  await expect(editor(page)).toHaveValue("");
  await expect(page.getByText("请输入 goal 描述")).toBeVisible();
  expect(agentPosts).toEqual([]);

  await editor(page).fill("Ship durable goal routing");
  await sendBtn(page).click();

  await expect.poll(() => agentPosts.length).toBe(1);
  expect(agentPosts[0]).toMatchObject({
    type: "goal_set",
    objective: "Ship durable goal routing",
  });
});

test("workflow: slash command sends visible objective plus hidden workflow aside", async ({
  bootedPage: page,
}) => {
  const agentPosts: Array<Record<string, unknown>> = [];

  await page.route("**/api/agent/*", async (route) => {
    const req = route.request();
    const pathname = new URL(req.url()).pathname;
    if (!pathname.match(/^\/api\/agent\/[^/]+$/) || req.method() !== "POST") {
      return route.fallback();
    }
    const body = req.postDataJSON() as Record<string, unknown>;
    if (body.type === "goal_set" || body.type === "prompt") {
      agentPosts.push(body);
    }
    return route.fulfill({ json: { ok: true } });
  });

  await editor(page).fill("/workflow Audit latest session workflow behavior");
  await expect(page.getByTestId("mode-chip-workflow")).toBeVisible();
  await sendBtn(page).click();

  await expect.poll(() => agentPosts.length).toBe(1);
  const payload = agentPosts[0];
  expect(payload.type).toBe("prompt");
  expect(payload.text).toContain("Audit latest session workflow behavior");
  expect(payload.text).toContain("<<<CONTEXT_ASIDE>>>");
  expect(payload.text).toContain("run_workflow_script");
  expect(payload.clientRequestId).toEqual(expect.any(String));

  await expect(
    page.getByText("Audit latest session workflow behavior")
  ).toBeVisible();
  await expect(page.getByText("<<<CONTEXT_ASIDE>>>")).toHaveCount(0);
});

test("workflow: SSE card shows checkpoints, artifacts, failure, and resume prompt", async ({
  bootedPage: page,
}) => {
  await editor(page).fill("/workflow Audit latest session workflow behavior");
  await sendBtn(page).click();
  const agentId = await activeAgentId(page);
  const now = Date.now();

  await pushSseEvent(
    page,
    agentId,
    { type: "workflow_start", run: workflowRun({ parentAgentId: agentId, createdAt: now }) },
    "30"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "workflow_checkpoint",
      workflowId: "workflow-e2e",
      checkpoint: {
        name: "recon-done",
        value: { length: 50 },
        createdAt: now + 1,
      },
    },
    "31"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "workflow_artifact",
      workflowId: "workflow-e2e",
      artifact: {
        name: "recon.md",
        value: "RECON: workflow and goal session routes inspected.",
        createdAt: now + 2,
      },
    },
    "32"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "workflow_log",
      workflowId: "workflow-e2e",
      log: {
        level: "info",
        message: "stage:start:audit",
        createdAt: now + 3,
      },
    },
    "33"
  );
  await pushSseEvent(
    page,
    agentId,
    {
      type: "workflow_end",
      workflowId: "workflow-e2e",
      status: "failed",
      endedAt: now + 1000,
      checkpoints: [
        { name: "recon-done", value: { length: 50 }, createdAt: now + 1 },
      ],
      artifacts: [
        {
          name: "recon.md",
          value: "RECON: workflow and goal session routes inspected.",
          createdAt: now + 2,
        },
      ],
      logs: [
        { level: "info", message: "stage:start:audit", createdAt: now + 3 },
      ],
      error: "workflow capability required: shell",
    },
    "34"
  );

  await page.getByTestId("assistant-process-toggle").click();
  await expect(page.getByText("Workflow").first()).toBeVisible();
  await expect(page.getByText("failed")).toBeVisible();
  await expect(page.getByText("recon-done")).toBeVisible();
  await expect(page.getByText("recon.md")).toBeVisible();
  await expect(page.getByText("stage:start:audit")).toBeVisible();
  await expect(page.getByText("Resume")).toBeVisible();

  await page.getByText("Resume").click();
  await expect(editor(page)).toHaveValue(/workflowId: workflow-e2e/);
  await expect(editor(page)).toHaveValue(
    /previousObjective: Audit latest session workflow behavior/
  );
  await expect(editor(page)).toHaveValue(/resumeFromWorkflowId/);
});

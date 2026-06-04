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

async function activeKey(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __chatAppDiag?: { activeKey: () => string };
    };
    return w.__chatAppDiag!.activeKey();
  });
}

test("subagents: SSE card expands answer, shows audit badges, and retries one task", async ({
  bootedPage: page,
}) => {
  const subagentActions: unknown[] = [];

  await page.route("**/api/agent/*/subagents", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      subagentActions.push(req.postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { batches: [] } });
  });

  await editor(page).fill("请分 2 个 subagent 回答采购规则问题");
  await expect(sendBtn(page)).toBeEnabled();
  await sendBtn(page).click();
  const agentId = await activeAgentId(page);

  const now = Date.now();
  const batch = {
    id: "batch-e2e",
    parentAgentId: agentId,
    status: "running",
    reason: "Answer independent procurement questions.",
    createdAt: now,
    planning: {
      status: "accepted",
      plannedAt: now,
      rationale: "Questions are independent and can run in parallel.",
      taskCount: 2,
      requestedConcurrency: 2,
      concurrency: 2,
      maxConcurrency: 6,
      warnings: [],
    },
    tasks: [
      {
        id: "q1",
        title: "Q1: 小额快速采购金额上限",
        prompt: "回答小额快速采购金额上限",
        role: "rag",
        status: "pending",
      },
      {
        id: "q2",
        title: "Q2: 集采和自采的区别",
        prompt: "回答集采和自采区别",
        role: "general",
        status: "pending",
      },
    ],
  };

  await pushSseEvent(
    page,
    agentId,
    {
      type: "subagent_batch_start",
      batch,
    },
    "10"
  );

  await expect(page.getByText("Subagents")).toBeVisible();
  await expect(page.getByText("Planner: accepted")).toBeVisible();
  await expect(page.getByText("2 tasks")).toBeVisible();
  await expect(page.getByText("concurrency 2")).toBeVisible();

  await pushSseEvent(
    page,
    agentId,
    {
      type: "subagent_task_start",
      batchId: "batch-e2e",
      taskId: "q1",
      agentId: "child-q1",
      title: "Q1: 小额快速采购金额上限",
      role: "rag",
      startedAt: now + 50,
    },
    "11"
  );

  await pushSseEvent(
    page,
    agentId,
    {
      type: "subagent_task_end",
      batchId: "batch-e2e",
      taskId: "q1",
      status: "completed",
      agentId: "child-q1",
      answer:
        "直接答案：小额快速采购的金额上限为 30 万元人民币。来源依据：采购规则知识库条目。",
      answerPreview: "小额快速采购的金额上限为 30 万元人民币。",
      sessionFile: "/tmp/e2e-sessions/child-q1.jsonl",
      usage: { turns: 5, inputTokens: 1200, outputTokens: 220 },
      endedAt: now + 500,
      verification: {
        status: "passed",
        verifiedAt: now + 501,
        checks: [
          {
            id: "answer_present",
            status: "passed",
            message: "Answer is present.",
          },
        ],
      },
    },
    "12"
  );

  await pushSseEvent(
    page,
    agentId,
    {
      type: "subagent_batch_end",
      batchId: "batch-e2e",
      status: "completed",
      endedAt: now + 800,
      results: [
        {
          taskId: "q1",
          agentId: "child-q1",
          status: "completed",
          answer:
            "直接答案：小额快速采购的金额上限为 30 万元人民币。来源依据：采购规则知识库条目。",
          sessionFile: "/tmp/e2e-sessions/child-q1.jsonl",
          startedAt: now + 50,
          endedAt: now + 500,
        },
      ],
      verification: {
        status: "warning",
        verifiedAt: now + 801,
        summary: "1 passed, 1 warning, 0 failed.",
        passed: 1,
        warnings: 1,
        failed: 0,
      },
      synthesis: {
        status: "partial",
        generatedAt: now + 802,
        summary: "Synthesis partial: 1 usable, 1 caution, 0 rejected.",
        usableTaskIds: ["q1"],
        cautionTaskIds: ["q2"],
        rejectedTaskIds: [],
        instructions: "Combine usable results and flag pending gaps.",
      },
      auditEvents: [
        {
          type: "batch_created",
          at: now,
          message: "Created subagent batch with 2 task(s).",
        },
        {
          type: "task_started",
          at: now + 50,
          taskId: "q1",
          message: "Started subagent task Q1.",
        },
        {
          type: "batch_completed",
          at: now + 800,
          message: "Subagent batch ended as completed.",
        },
      ],
    },
    "13"
  );

  await expect(page.getByText("warning").first()).toBeVisible();
  await expect(page.getByText("Synthesis: partial")).toBeVisible();
  await expect(
    page.getByText("Synthesis partial: 1 usable, 1 caution, 0 rejected.")
  ).toBeVisible();
  await expect(page.getByText("1 usable", { exact: true })).toBeVisible();
  await expect(page.getByText("1 caution", { exact: true })).toBeVisible();
  await expect(page.getByText("0 rejected", { exact: true })).toBeVisible();
  await expect(page.getByText("Audit: 3 events")).toBeVisible();
  await expect(page.getByText("Subagent batch ended as completed.").first()).toBeVisible();
  await expect(page.getByText("Q1: 小额快速采购金额上限")).toBeVisible();
  await expect(page.getByText("Skill: gbrain-query")).toBeVisible();
  await expect(page.getByText("运行了 5 轮")).toBeVisible();
  await expect(page.getByText("/tmp/e2e-sessions/child-q1.jsonl")).toBeVisible();
  await expect(page.getByText("30 万元人民币")).toBeVisible();

  await page.getByLabel("重试这个 subagent task").first().click();
  await expect.poll(() => subagentActions).toContainEqual({
    type: "retry",
    batchId: "batch-e2e",
    taskId: "q1",
  });
});

test("subagents: restored unfinished batch can create a parent agent and continue", async ({
  bootedPage: page,
}) => {
  const now = Date.now();
  const parentSession = {
    id: "parent-restored",
    path: "/tmp/e2e-sessions/parent-restored.jsonl",
    cwd: "/tmp/e2e-cwd",
    name: "Restored parent",
    firstMessage: "Restored parent",
    created: new Date(now - 5_000).toISOString(),
    modified: new Date(now - 4_000).toISOString(),
    messageCount: 2,
  };
  const childSession = {
    id: "child-restored-q1",
    path: "/tmp/e2e-sessions/child-restored-q1.jsonl",
    cwd: "/tmp/e2e-cwd",
    name: "Subagent q1",
    firstMessage: "Subagent q1",
    parentSessionPath: parentSession.path,
    created: new Date(now - 3_000).toISOString(),
    modified: new Date(now - 2_000).toISOString(),
    messageCount: 1,
  };
  const agentNewPayloads: unknown[] = [];
  const subagentActions: unknown[] = [];

  await page.route("**/api/sessions", async (route) => {
    return route.fulfill({
      json: { sessions: [parentSession, childSession] },
    });
  });

  await page.route("**/api/sessions/parent-restored/context", async (route) => {
    return route.fulfill({
      json: {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "继续之前的多 agent 任务" }],
            timestamp: now - 4_500,
          },
        ],
        forkableUserMessages: [],
        subagentBatches: [
          {
            id: "batch-restored-e2e",
            parentAgentId: "previous-parent-agent",
            parentSessionPath: parentSession.path,
            status: "running",
            reason: "Resume unfinished procurement questions.",
            createdAt: now - 3_500,
            planning: {
              status: "accepted",
              plannedAt: now - 3_500,
              rationale: "Independent questions remain unfinished.",
              taskCount: 2,
              requestedConcurrency: 2,
              concurrency: 2,
              maxConcurrency: 6,
              warnings: [],
            },
            tasks: [
              {
                id: "rq1",
                title: "Restored Q1: 已完成答案",
                prompt: "回答已完成问题",
                role: "rag",
                status: "completed",
                agentId: "child-restored-q1",
                answer: "恢复出的历史答案：30 万元人民币。",
                answerPreview: "恢复出的历史答案：30 万元人民币。",
                sessionFile: childSession.path,
                startedAt: now - 3_000,
                endedAt: now - 2_500,
                verification: {
                  status: "passed",
                  verifiedAt: now - 2_400,
                  checks: [
                    {
                      id: "answer_present",
                      status: "passed",
                      message: "Answer is present.",
                    },
                  ],
                },
              },
              {
                id: "rq2",
                title: "Restored Q2: 待继续任务",
                prompt: "继续回答未完成问题",
                role: "general",
                status: "pending",
              },
            ],
            auditEvents: [
              {
                type: "batch_created",
                at: now - 3_500,
                message: "Created subagent batch with 2 task(s).",
              },
              {
                type: "batch_resumed",
                at: now - 2_000,
                message: "Resume requested for 1 unfinished subagent task(s).",
              },
            ],
          },
        ],
      },
    });
  });

  await page.route("**/api/agent/new", async (route) => {
    agentNewPayloads.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        id: "agent-restored-parent",
        sessionId: parentSession.id,
        sessionFile: parentSession.path,
        thinkingLevel: "medium",
        supportsThinking: true,
        availableThinkingLevels: ["low", "medium", "high"],
        model: {
          provider: "anthropic",
          id: "claude-haiku-4-5-20251001",
          name: "Claude Haiku 4.5",
        },
      },
    });
  });

  await page.route("**/api/agent/*/subagents", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      subagentActions.push({
        url: req.url(),
        body: req.postDataJSON(),
      });
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { batches: [] } });
  });

  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect(page.getByText("Restored parent")).toBeVisible();
  await expect(page.getByText("1 subagent")).toBeVisible();
  await page.getByText("Restored parent").click();

  await expect(page.getByText("Subagents")).toBeVisible();
  await expect(page.getByText("Resume unfinished procurement questions.")).toBeVisible();
  await expect(page.getByText("Planner: accepted")).toBeVisible();
  await expect(page.getByText("Restored Q1: 已完成答案")).toBeVisible();
  await expect(page.getByText("恢复出的历史答案：30 万元人民币。")).toBeVisible();
  await expect(page.getByText("Restored Q2: 待继续任务")).toBeVisible();
  await expect(page.getByText("Audit: 2 events")).toBeVisible();
  await expect(
    page.getByText("Resume requested for 1 unfinished subagent task(s).").first()
  ).toBeVisible();
  await expect(page.getByLabel("打开 child subagent session")).toBeVisible();

  await page.getByLabel("打开 child subagent session").click();
  await page.waitForFunction(
    (expectedKey) => {
      const w = window as unknown as {
        __chatAppDiag?: { activeKey: () => string };
      };
      return w.__chatAppDiag?.activeKey() === expectedKey;
    },
    childSession.path
  );
  expect(await activeKey(page)).toBe(childSession.path);

  await page.getByText("Restored parent").click();
  await expect(page.getByLabel("继续执行未完成的 subagent tasks")).toBeVisible();

  await page.getByLabel("继续执行未完成的 subagent tasks").click();

  await expect.poll(() => agentNewPayloads).toContainEqual(
    expect.objectContaining({
      sessionPath: parentSession.path,
    })
  );
  await expect.poll(() => subagentActions).toContainEqual({
    url: "http://localhost:3000/api/agent/agent-restored-parent/subagents",
    body: {
      type: "resume",
      batchId: "batch-restored-e2e",
    },
  });
});

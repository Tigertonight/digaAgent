import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const TEST_LOCAL_SECRET = "vitest-agent-workflows-secret";

const agentRegistryMock = vi.hoisted(() => ({
  abortSubagentsForParent: vi.fn(),
  abortWorkflowsForParent: vi.fn(),
  getAgent: vi.fn(),
  retryWorkflowScriptForParent: vi.fn(),
}));

const workflowStoreMock = vi.hoisted(() => ({
  getWorkflowRun: vi.fn(),
  listWorkflowRuns: vi.fn(),
  putWorkflowArtifact: vi.fn(),
  workflowResumeSnapshot: vi.fn(),
}));

vi.mock("@/lib/agent-registry", () => agentRegistryMock);
vi.mock("@/lib/workflows/debug-bundle", () => ({
  buildWorkflowDebugBundle: vi.fn(() => ({ debug: true })),
}));
vi.mock("@/lib/shared/git-worktree", () => ({
  createGitWorktreeManager: vi.fn(() => ({})),
}));
vi.mock("@/lib/workflows/server-store", () => workflowStoreMock);

function localReq(body: unknown) {
  return new Request("http://localhost:3000/api/agent/agent-1/workflows", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-diga-agent-local-secret": TEST_LOCAL_SECRET,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agent/[id]/workflows", () => {
  const previousSecret = process.env.DIGA_AGENT_LOCAL_SECRET;

  beforeAll(() => {
    process.env.DIGA_AGENT_LOCAL_SECRET = TEST_LOCAL_SECRET;
  });

  afterAll(() => {
    if (previousSecret === undefined) {
      delete process.env.DIGA_AGENT_LOCAL_SECRET;
    } else {
      process.env.DIGA_AGENT_LOCAL_SECRET = previousSecret;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    agentRegistryMock.getAgent.mockReturnValue({
      id: "agent-1",
      cwd: "/repo",
      session: { model: "gpt-test" },
    });
    workflowStoreMock.listWorkflowRuns.mockReturnValue([]);
    workflowStoreMock.workflowResumeSnapshot.mockReturnValue({});
  });

  it("rejects manual workflow retry without workflowId", async () => {
    const { POST } = await import("./route");
    const res = await POST(localReq({ type: "retry_workflow_script" }), {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "workflowId is required",
    });
    expect(
      agentRegistryMock.retryWorkflowScriptForParent,
    ).not.toHaveBeenCalled();
  });

  it("retries a failed workflow script for the parent agent", async () => {
    agentRegistryMock.retryWorkflowScriptForParent.mockResolvedValue({
      workflowId: "wf-1",
      status: "running",
    });

    const { POST } = await import("./route");
    const res = await POST(
      localReq({ type: "retry_workflow_script", workflowId: "wf-1" }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      result: { workflowId: "wf-1", status: "running" },
    });
    expect(agentRegistryMock.retryWorkflowScriptForParent).toHaveBeenCalledWith(
      "agent-1",
      "wf-1",
    );
  });

  it("returns the retry failure message when script retry cannot restart", async () => {
    agentRegistryMock.retryWorkflowScriptForParent.mockRejectedValue(
      new Error("workflow script is not retryable"),
    );

    const { POST } = await import("./route");
    const res = await POST(
      localReq({ type: "retry_workflow_script", workflowId: "wf-1" }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: "workflow script is not retryable",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetRuntimeEventStoreForTest,
  listRuntimeEvents,
} from "@/lib/runtime/event-store";

const agentRegistryMock = vi.hoisted(() => ({
  abortLocalCodingAssistantAgent: vi.fn(),
  abortSubagentsForParent: vi.fn(),
  abortWorkflowsForParent: vi.fn(),
  claimClientRequest: vi.fn(() => true),
  clearClientRequest: vi.fn(),
  createAgent: vi.fn(),
  disposeAgent: vi.fn(),
  finishStreamingAfterPromptError: vi.fn(),
  getAgent: vi.fn(),
  getModelRegistry: vi.fn(),
  isLocalCodingAssistantAgent: vi.fn(() => false),
  LOCAL_CODING_ASSISTANT_MODELS: [],
  LOCAL_CODING_ASSISTANT_PROVIDER_ID: "local-coding-assistant",
  promptLocalCodingAssistantAgent: vi.fn(),
  pushExternalEvent: vi.fn(),
  pushGoalEvent: vi.fn(),
  pushProgressEvent: vi.fn(),
}));

vi.mock("@/lib/agent-registry", () => agentRegistryMock);
vi.mock("@/lib/remote/auth", () => ({
  assertRemoteAuth: vi.fn(async () => null),
}));
vi.mock("@/lib/subagents/registry", () => ({
  listDefinitions: vi.fn(() => []),
}));
vi.mock("@/lib/composer/aside-prompt", () => ({
  composePromptWithAside: vi.fn((text: string) => ({
    displayText: text,
    finalText: text,
    mentionDirective: null,
  })),
  parseAttachments: vi.fn(() => []),
}));
vi.mock("@/lib/communication/instructions", () => ({
  withCommunicationInstructions: vi.fn((text: string) => text),
}));
vi.mock("@/lib/communication/settings", () => ({
  getCommunicationSettings: vi.fn(async () => ({})),
}));
vi.mock("@/lib/clarification/server-store", () => ({
  listPendingClarifications: vi.fn(() => []),
  resolveClarification: vi.fn(() => false),
}));
vi.mock("@/lib/goal/server-store", () => ({
  clearGoal: vi.fn(),
  findAgentIdBySessionId: vi.fn(() => null),
  getGoal: vi.fn(() => null),
  listGoalEvidence: vi.fn(() => []),
  listGoalTurns: vi.fn(() => []),
  normalizeObjective: vi.fn((value: unknown) =>
    typeof value === "string" ? value.trim() : "",
  ),
  setGoal: vi.fn(),
  setGoalStatus: vi.fn(),
}));
vi.mock("@/lib/goal/update", () => ({
  applyGoalUpdate: vi.fn(),
}));
vi.mock("@/lib/progress/server-store", () => ({
  clearProgress: vi.fn(() => ({ groups: [], steps: [], artifacts: [] })),
  failOpenProgress: vi.fn(() => ({ groups: [], steps: [], artifacts: [] })),
  getProgress: vi.fn(() => ({ groups: [], steps: [], artifacts: [] })),
  updateProgress: vi.fn(() => ({ groups: [], steps: [], artifacts: [] })),
}));
vi.mock("@/lib/progress/file-store", () => ({
  readPersistedProgress: vi.fn(async () => null),
  writePersistedProgress: vi.fn(async () => undefined),
}));
vi.mock("@/lib/evidence/server-store", () => ({
  listEvidence: vi.fn(() => []),
}));
vi.mock("@/lib/api/error-response", () => ({
  internalErrorResponse: vi.fn((e: unknown) =>
    Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    ),
  ),
}));

const ALL_TOOLS = [
  "read",
  "delegate_subagents",
  "run_workflow_script",
  "run_workflow_template",
  "list_workflow_skills",
  "list_workflow_templates",
  "read_workflow_resource",
  "save_workflow_skill",
  "list_workflow_script_drafts",
  "read_workflow_script_draft",
  "save_workflow_script_draft",
];

function makeSession(promptImpl = vi.fn(async () => undefined)) {
  let active = ["read", "delegate_subagents", "run_workflow_script"];
  return {
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    model: { provider: "test", id: "model", name: "Model" },
    prompt: promptImpl,
    getAllTools: vi.fn(() => ALL_TOOLS.map((name) => ({ name }))),
    getActiveToolNames: vi.fn(() => active.slice()),
    setActiveToolsByName: vi.fn((names: string[]) => {
      active = names.slice();
    }),
  };
}

function makeAgent(session: ReturnType<typeof makeSession>) {
  return {
    id: "agent-1",
    cwd: "/repo",
    isStreaming: false,
    session,
  };
}

function localReq(body: unknown) {
  return new Request("http://localhost:3000/api/agent/agent-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agent/[id] workflow mode tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRuntimeEventStoreForTest();
  });

  afterEach(() => {
    __resetRuntimeEventStoreForTest();
  });

  it("temporarily enables only workflow tools for workflow mode prompts", async () => {
    const session = makeSession();
    agentRegistryMock.getAgent.mockReturnValue(makeAgent(session));
    const { POST } = await import("./route");

    const res = await POST(
      localReq({ type: "prompt", text: "audit", workflowMode: true }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(200);
    expect(session.prompt).toHaveBeenCalledWith("audit", undefined);
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(2);
    expect(session.setActiveToolsByName).toHaveBeenNthCalledWith(1, [
      "run_workflow_script",
      "run_workflow_template",
      "list_workflow_skills",
      "list_workflow_templates",
      "read_workflow_resource",
      "save_workflow_skill",
      "list_workflow_script_drafts",
      "read_workflow_script_draft",
      "save_workflow_script_draft",
    ]);
    expect(session.setActiveToolsByName).toHaveBeenNthCalledWith(2, [
      "read",
      "delegate_subagents",
      "run_workflow_script",
    ]);
    expect(session.setActiveToolsByName.mock.calls[0]?.[0]).not.toContain(
      "delegate_subagents",
    );
    expect(listRuntimeEvents({ source: "workflow" })).toEqual([
      expect.objectContaining({
        type: "workflow_mode_start",
        status: "running",
        payload: expect.objectContaining({
          delegateDirectDisabled: true,
          delegateWasActive: true,
        }),
      }),
    ]);
  });

  it("restores active tools when workflow mode prompt fails", async () => {
    const session = makeSession(
      vi.fn(async () => {
        throw new Error("model failed");
      }),
    );
    agentRegistryMock.getAgent.mockReturnValue(makeAgent(session));
    const { POST } = await import("./route");

    const res = await POST(
      localReq({ type: "prompt", text: "audit", workflowMode: true }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(500);
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(2);
    expect(session.setActiveToolsByName).toHaveBeenLastCalledWith([
      "read",
      "delegate_subagents",
      "run_workflow_script",
    ]);
    expect(
      agentRegistryMock.finishStreamingAfterPromptError,
    ).toHaveBeenCalledWith("agent-1");
  });

  it("does not change active tools for normal prompts", async () => {
    const session = makeSession();
    agentRegistryMock.getAgent.mockReturnValue(makeAgent(session));
    const { POST } = await import("./route");

    const res = await POST(localReq({ type: "prompt", text: "audit" }), {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(res.status).toBe(200);
    expect(session.prompt).toHaveBeenCalledWith("audit", undefined);
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(listRuntimeEvents({ source: "workflow" })).toEqual([]);
  });
});

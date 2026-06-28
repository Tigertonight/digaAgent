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
  finishStreamingAfterAbort: vi.fn(),
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

const agentTeamStoreMock = vi.hoisted(() => ({
  listAgentTeamRuns: vi.fn(() => []),
  listAgentTeamRunsByParentSessionPath: vi.fn(() => []),
}));

vi.mock("@/lib/agent-registry", () => agentRegistryMock);
vi.mock("@/lib/agent-team/server-store", () => agentTeamStoreMock);
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
    agent: {
      state: { messages: [] as Array<{ role?: string; content?: unknown }> },
    },
    model: { provider: "test", id: "model", name: "Model" },
    prompt: promptImpl,
    sessionManager: {
      appendMessage: vi.fn(),
      _rewriteFile: vi.fn(),
      flushed: false,
    },
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

function localGet(action: string) {
  return new Request(`http://localhost:3000/api/agent/agent-1?action=${action}`, {
    method: "GET",
  });
}

describe("POST /api/agent/[id] workflow mode tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentTeamStoreMock.listAgentTeamRuns.mockReturnValue([]);
    agentTeamStoreMock.listAgentTeamRunsByParentSessionPath.mockReturnValue([]);
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
    expect(session.prompt).toHaveBeenCalledWith("audit");
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
    expect(session.prompt).toHaveBeenCalledWith("audit");
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(listRuntimeEvents({ source: "workflow" })).toEqual([]);
  });

  it("cleans Agent Team markers and provider think tags before prompting again", async () => {
    const session = makeSession(
      vi.fn(async () => {
        expect(session.agent.state.messages[0]?.content).toBe("最终回答");
        expect(session.agent.state.messages[1]?.content).toEqual([
          { type: "text", text: "可见结论" },
        ]);
      }),
    );
    session.agent.state.messages = [
      {
        role: "assistant",
        content:
          "<think>internal rubric</think>\n最终回答\n<!-- agent-team-final:{\"kind\":\"verification\",\"verdict\":\"pass\"} -->",
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "<think>hidden</think>可见结论<!-- agent-team-final:{} -->",
          },
        ],
      },
    ];
    agentRegistryMock.getAgent.mockReturnValue(makeAgent(session));
    const { POST } = await import("./route");

    const res = await POST(localReq({ type: "prompt", text: "继续解释" }), {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(res.status).toBe(200);
    expect(session.prompt).toHaveBeenCalledWith("继续解释");
  });

  it("answers short Team conclusion explanation follow-ups locally", async () => {
    const session = makeSession();
    agentTeamStoreMock.listAgentTeamRuns.mockReturnValue([
      {
        id: "team-1",
        status: "completed",
        objective: "只读确认 definitely-not-a-real-file-xyz.ts 是否存在",
        parentAgentId: "agent-1",
        parentSessionPath: "/tmp/session.jsonl",
        updatedAt: 200,
        board: {
          decisions: [
            {
              rationale:
                "不存在 — 当前项目里没有找到 `/definitely-not-a-real-file-xyz.ts`。",
            },
          ],
        },
      },
    ] as never);
    agentRegistryMock.getAgent.mockReturnValue(makeAgent(session));
    const { POST } = await import("./route");

    const res = await POST(localReq({ type: "prompt", text: "这个结论用一句话解释一下。" }), {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ localTeamAnswer: true });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.sessionManager.appendMessage).toHaveBeenCalledTimes(2);
    expect(session.sessionManager.appendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        role: "user",
        content: "这个结论用一句话解释一下。",
      }),
    );
    expect(session.sessionManager.appendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("不存在 — 当前项目里没有找到"),
          }),
        ]),
      }),
    );
    expect(session.sessionManager._rewriteFile).toHaveBeenCalled();
    expect(session.sessionManager.flushed).toBe(true);
    expect(agentRegistryMock.pushExternalEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "message_start",
        message: expect.objectContaining({
          role: "user",
          content: "这个结论用一句话解释一下。",
        }),
      }),
    );
    expect(agentRegistryMock.pushExternalEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "message_start",
        message: expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining("不存在 — 当前项目里没有找到"),
            }),
          ]),
        }),
      }),
    );
  });

  it("answers simple Team evidence follow-ups locally without calling the model", async () => {
    const session = makeSession();
    agentTeamStoreMock.listAgentTeamRuns.mockReturnValue([
      {
        id: "team-1",
        status: "completed",
        objective: "只读确认 app/__team_probe_file__.tsx 是否存在",
        parentAgentId: "agent-1",
        parentSessionPath: "/tmp/session.jsonl",
        updatedAt: 200,
        board: {
          decisions: [
            {
              rationale: "存在 — 已确认 app/__team_probe_file__.tsx 在当前项目中。",
              status: "accepted",
            },
          ],
          findings: [
            {
              id: "f-1",
              claim: "存在：app/__team_probe_file__.tsx 在当前项目中。",
              status: "accepted",
              evidenceRefs: ["file:app/__team_probe_file__.tsx"],
            },
          ],
          challenges: [],
        },
      },
    ] as never);
    agentRegistryMock.getAgent.mockReturnValue(makeAgent(session));
    const { POST } = await import("./route");

    const res = await POST(
      localReq({ type: "prompt", text: "刚才结论的证据是哪一个文件？一句话。" }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ localTeamAnswer: true });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.sessionManager.appendMessage).toHaveBeenCalledTimes(2);
    expect(session.sessionManager.appendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        role: "user",
        content: "刚才结论的证据是哪一个文件？一句话。",
      }),
    );
    expect(session.sessionManager.appendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("app/__team_probe_file__.tsx"),
          }),
        ]),
      }),
    );
    expect(session.sessionManager._rewriteFile).toHaveBeenCalled();
    expect(session.sessionManager.flushed).toBe(true);
    expect(agentRegistryMock.pushExternalEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "message_start",
        message: expect.objectContaining({
          role: "user",
          content: "刚才结论的证据是哪一个文件？一句话。",
        }),
      }),
    );
    expect(agentRegistryMock.pushExternalEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "message_start",
        message: expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining("app/__team_probe_file__.tsx"),
            }),
          ]),
        }),
      }),
    );
    expect(agentRegistryMock.pushExternalEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "message_end" }),
    );
  });

  it("answers root package evidence follow-ups locally when the Team objective names package.json", async () => {
    const session = makeSession();
    agentTeamStoreMock.listAgentTeamRuns.mockReturnValue([
      {
        id: "team-1",
        status: "completed",
        objective: "只读确认 package.json 是否存在",
        parentAgentId: "agent-1",
        parentSessionPath: "/tmp/session.jsonl",
        updatedAt: 200,
        board: {
          decisions: [
            {
              rationale: "存在 — 已确认 package.json 在当前项目中。",
              status: "accepted",
            },
          ],
          findings: [],
          challenges: [],
        },
      },
    ] as never);
    agentRegistryMock.getAgent.mockReturnValue(makeAgent(session));
    const { POST } = await import("./route");

    const res = await POST(
      localReq({ type: "prompt", text: "刚才结论的证据来源是什么？一句话。" }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ localTeamAnswer: true });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.sessionManager.appendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("package.json"),
          }),
        ]),
      }),
    );
  });

  it("lets the model answer evidence follow-ups when no concrete evidence path is available", async () => {
    const prompt = vi.fn(async () => undefined);
    const session = makeSession(prompt);
    agentTeamStoreMock.listAgentTeamRuns.mockReturnValue([
      {
        id: "team-1",
        status: "completed",
        objective: "检查当前实现是否合理",
        parentAgentId: "agent-1",
        parentSessionPath: "/tmp/session.jsonl",
        updatedAt: 200,
        board: {
          decisions: [
            {
              rationale: "通过 — 当前实现整体合理。",
              status: "accepted",
            },
          ],
          findings: [],
          challenges: [],
        },
      },
    ] as never);
    agentRegistryMock.getAgent.mockReturnValue(makeAgent(session));
    const { POST } = await import("./route");

    const res = await POST(
      localReq({ type: "prompt", text: "刚才结论的证据来源是什么？一句话。" }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.not.toMatchObject({ localTeamAnswer: true });
    expect(prompt).toHaveBeenCalledOnce();
    expect(session.sessionManager.appendMessage).not.toHaveBeenCalled();
  });

  it("uses the current session Team result before older runs from the same agent", async () => {
    const session = makeSession();
    agentTeamStoreMock.listAgentTeamRuns.mockReturnValue([
      {
        id: "old-team",
        status: "completed",
        objective: "只读确认 app/old_file.tsx 是否存在",
        parentAgentId: "agent-1",
        parentSessionPath: "/tmp/other-session.jsonl",
        updatedAt: 300,
        board: {
          decisions: [{ rationale: "存在 — app/old_file.tsx。", status: "accepted" }],
          findings: [],
          challenges: [],
        },
      },
      {
        id: "current-team",
        status: "completed",
        objective: "只读确认 app/__current_session_file__.tsx 是否存在",
        parentAgentId: "agent-1",
        parentSessionPath: "/tmp/session.jsonl",
        updatedAt: 200,
        board: {
          decisions: [
            {
              rationale: "不存在 — 当前项目里没有找到 app/__current_session_file__.tsx。",
              status: "accepted",
            },
          ],
          findings: [],
          challenges: [],
        },
      },
    ] as never);
    agentRegistryMock.getAgent.mockReturnValue(makeAgent(session));
    const { POST } = await import("./route");

    const res = await POST(
      localReq({ type: "prompt", text: "证据来自哪个文件？一句话。" }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(200);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(agentRegistryMock.pushExternalEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "message_start",
        message: expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining("app/__current_session_file__.tsx"),
            }),
          ]),
        }),
      }),
    );
  });
});

describe("DELETE /api/agent/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires remote auth before disposing an agent", async () => {
    const { assertRemoteAuth } = await import("@/lib/remote/auth");
    vi.mocked(assertRemoteAuth).mockResolvedValueOnce(
      Response.json({ error: "unauthorized" }, { status: 401 }) as never,
    );
    const { DELETE } = await import("./route");

    const res = await DELETE(
      new Request("http://localhost:3000/api/agent/agent-1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(401);
    expect(agentRegistryMock.disposeAgent).not.toHaveBeenCalled();
  });

  it("awaits dispose after auth succeeds", async () => {
    const { assertRemoteAuth } = await import("@/lib/remote/auth");
    vi.mocked(assertRemoteAuth).mockResolvedValueOnce(null);
    agentRegistryMock.disposeAgent.mockResolvedValueOnce(undefined);
    const { DELETE } = await import("./route");

    const res = await DELETE(
      new Request("http://localhost:3000/api/agent/agent-1", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "agent-1" }) },
    );

    expect(res.status).toBe(200);
    expect(agentRegistryMock.disposeAgent).toHaveBeenCalledWith("agent-1");
  });
});

describe("GET /api/agent/[id] stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails open when session stats are temporarily unavailable", async () => {
    const session = makeSession();
    Object.assign(session, {
      model: {
        provider: "test",
        id: "model",
        name: "Model",
        contextWindow: 1000,
      },
      getSessionStats: vi.fn(() => {
        throw new Error("usage is not ready");
      }),
      getContextUsage: vi.fn(() => ({ total: 10 })),
    });
    agentRegistryMock.getAgent.mockReturnValue(makeAgent(session));
    const { GET } = await import("./route");

    const res = await GET(localGet("stats"), {
      params: Promise.resolve({ id: "agent-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    });
    expect(json.contextUsage).toBeNull();
    expect(json.contextWindow).toBe(1000);
    expect(json.warning).toContain("usage is not ready");
  });
});

describe("POST /api/agent/[id] abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the unified forced finish path after aborting work", async () => {
    const session = makeSession();
    const abort = vi.fn(async () => undefined);
    Object.assign(session, { abort });
    agentRegistryMock.getAgent.mockReturnValue({
      ...makeAgent(session),
      isStreaming: true,
    });
    const { POST } = await import("./route");

    const res = await POST(localReq({ type: "abort" }), {
      params: Promise.resolve({ id: "agent-1" }),
    });

    expect(res.status).toBe(200);
    expect(agentRegistryMock.abortWorkflowsForParent).toHaveBeenCalledWith(
      "agent-1"
    );
    expect(agentRegistryMock.abortSubagentsForParent).toHaveBeenCalledWith(
      "agent-1"
    );
    expect(abort).toHaveBeenCalled();
    expect(agentRegistryMock.finishStreamingAfterAbort).toHaveBeenCalledWith(
      "agent-1"
    );
  });
});

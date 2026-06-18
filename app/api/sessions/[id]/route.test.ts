import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_LOCAL_SECRET = "vitest-session-route-secret";

const sessionsMock = vi.hoisted(() => ({
  collectSessionDescendants: vi.fn(),
  findSessionPathById: vi.fn(),
  getSessionDetail: vi.fn(),
}));

const sessionManagerMock = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock("@/lib/sessions", () => sessionsMock);
vi.mock("@/lib/meta/store", () => ({ deleteMeta: vi.fn() }));
vi.mock("@/lib/progress/file-store", () => ({ deletePersistedProgress: vi.fn() }));
vi.mock("@/lib/subagents/server-store", () => ({
  removeBatchesByParentSessionPath: vi.fn(),
}));
vi.mock("@/lib/agent-registry", () => ({
  disposeAgent: vi.fn(),
  listAgentSummaries: vi.fn(() => []),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: sessionManagerMock,
}));

function localReq(method: string, body?: unknown) {
  return new Request("http://localhost:3000/api/sessions/session-1", {
    method,
    headers: {
      "content-type": "application/json",
      "x-diga-agent-local-secret": TEST_LOCAL_SECRET,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/sessions/[id]", () => {
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
    sessionsMock.findSessionPathById.mockResolvedValue("/tmp/session-1.jsonl");
    sessionManagerMock.open.mockReturnValue({
      appendSessionInfo: vi.fn(),
    });
  });

  it("rejects overlong rename requests before opening the session", async () => {
    const { PATCH } = await import("./route");
    const res = await PATCH(localReq("PATCH", { name: "x".repeat(201) }), {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "name must be at most 200 characters",
    });
    expect(sessionManagerMock.open).not.toHaveBeenCalled();
  });
});

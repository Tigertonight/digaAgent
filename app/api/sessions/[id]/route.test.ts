import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_LOCAL_SECRET = "vitest-session-route-secret";

const sessionsMock = vi.hoisted(() => ({
  collectSessionDescendants: vi.fn(),
  findSessionPathById: vi.fn(),
  getSessionDetail: vi.fn(),
  // T1.3: 路由在删除后会调用该函数失效 listAll 缓存。
  invalidateSessionListCache: vi.fn(),
}));

const fsMock = vi.hoisted(() => ({
  unlink: vi.fn(),
}));

const sessionManagerMock = vi.hoisted(() => ({
  open: vi.fn(),
}));

const metaStoreMock = vi.hoisted(() => ({
  deleteMeta: vi.fn(),
}));

const progressStoreMock = vi.hoisted(() => ({
  deletePersistedProgress: vi.fn(),
}));

const subagentStoreMock = vi.hoisted(() => ({
  removeBatchesByParentSessionPath: vi.fn(),
}));

const agentRegistryMock = vi.hoisted(() => ({
  disposeAgent: vi.fn<(agentId: string) => Promise<void>>(),
  listAgentSummaries: vi.fn<
    () => Array<{ agentId: string; sessionFile: string | null }>
  >(() => []),
}));

vi.mock("@/lib/sessions", () => sessionsMock);
vi.mock("node:fs", () => ({ promises: fsMock }));
vi.mock("@/lib/meta/store", () => metaStoreMock);
vi.mock("@/lib/progress/file-store", () => progressStoreMock);
vi.mock("@/lib/subagents/server-store", () => subagentStoreMock);
vi.mock("@/lib/agent-registry", () => agentRegistryMock);
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
    sessionsMock.collectSessionDescendants.mockResolvedValue([
      { id: "session-1", path: "/tmp/session-1.jsonl" },
    ]);
    sessionManagerMock.open.mockReturnValue({
      appendSessionInfo: vi.fn(),
    });
    fsMock.unlink.mockResolvedValue(undefined);
    metaStoreMock.deleteMeta.mockResolvedValue(undefined);
    progressStoreMock.deletePersistedProgress.mockResolvedValue(undefined);
    agentRegistryMock.disposeAgent.mockResolvedValue(undefined);
    agentRegistryMock.listAgentSummaries.mockReturnValue([]);
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

  it("returns partial delete success without clearing metadata for failed targets", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionsMock.collectSessionDescendants.mockResolvedValue([
      { id: "ok", path: "/tmp/ok.jsonl" },
      { id: "busy", path: "/tmp/busy.jsonl" },
    ]);
    agentRegistryMock.listAgentSummaries.mockReturnValue([
      { agentId: "agent-ok", sessionFile: "/tmp/ok.jsonl" },
      { agentId: "agent-busy", sessionFile: "/tmp/busy.jsonl" },
    ]);
    fsMock.unlink.mockImplementation(async (path: string) => {
      if (path.includes("busy")) {
        const err = new Error("busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
    });

    const { DELETE } = await import("./route");
    const res = await DELETE(localReq("DELETE"), {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(res.status).toBe(207);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      partial: true,
      inMemoryDisposed: true,
      deleted: ["ok"],
      failed: [{ id: "busy", error: "EBUSY" }],
    });
    expect(metaStoreMock.deleteMeta).toHaveBeenCalledWith("ok");
    expect(metaStoreMock.deleteMeta).not.toHaveBeenCalledWith("busy");
    expect(progressStoreMock.deletePersistedProgress).toHaveBeenCalledWith("ok");
    expect(progressStoreMock.deletePersistedProgress).not.toHaveBeenCalledWith(
      "busy"
    );
    expect(agentRegistryMock.disposeAgent).toHaveBeenCalledWith("agent-ok");
    expect(agentRegistryMock.disposeAgent).not.toHaveBeenCalledWith("agent-busy");
    errorSpy.mockRestore();
  });

  it("keeps in-memory agents when every session file delete fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionsMock.collectSessionDescendants.mockResolvedValue([
      { id: "busy", path: "/tmp/busy.jsonl" },
    ]);
    agentRegistryMock.listAgentSummaries.mockReturnValue([
      { agentId: "agent-busy", sessionFile: "/tmp/busy.jsonl" },
    ]);
    fsMock.unlink.mockImplementation(async () => {
      const err = new Error("busy") as NodeJS.ErrnoException;
      err.code = "EBUSY";
      throw err;
    });

    const { DELETE } = await import("./route");
    const res = await DELETE(localReq("DELETE"), {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: "some sessions failed to delete",
      inMemoryDisposed: false,
      failed: [{ id: "busy", error: "EBUSY" }],
      deleted: [],
    });
    expect(metaStoreMock.deleteMeta).not.toHaveBeenCalled();
    expect(progressStoreMock.deletePersistedProgress).not.toHaveBeenCalled();
    expect(agentRegistryMock.disposeAgent).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

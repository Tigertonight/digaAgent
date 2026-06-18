import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_LOCAL_SECRET = "vitest-session-fork-secret";

const sessionsMock = vi.hoisted(() => ({
  findSessionPathById: vi.fn(),
  getForkableUserMessages: vi.fn(),
  getSessionDetail: vi.fn(),
}));

const sessionManagerMock = vi.hoisted(() => ({
  forkFrom: vi.fn(),
}));

vi.mock("@/lib/sessions", () => sessionsMock);
vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: sessionManagerMock,
}));

function localReq(body: unknown) {
  return new Request("http://localhost:3000/api/sessions/source/fork", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-diga-agent-local-secret": TEST_LOCAL_SECRET,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/sessions/[id]/fork", () => {
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
    sessionsMock.findSessionPathById.mockResolvedValue("/tmp/source.jsonl");
    sessionsMock.getForkableUserMessages.mockResolvedValue([
      { entryId: "entry-ok", text: "fork here" },
    ]);
    sessionsMock.getSessionDetail.mockResolvedValue({
      id: "source",
      path: "/tmp/source.jsonl",
      info: { cwd: "/repo" },
    });
    sessionManagerMock.forkFrom.mockReturnValue({
      branch: vi.fn(),
      getSessionId: () => "forked",
      getSessionFile: () => "/tmp/forked.jsonl",
    });
  });

  it("rejects a targetEntryId outside the current session branch", async () => {
    const { POST } = await import("./route");
    const res = await POST(localReq({ targetEntryId: "other-entry" }), {
      params: Promise.resolve({ id: "source" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "targetEntryId does not belong to this session branch",
    });
    expect(sessionManagerMock.forkFrom).not.toHaveBeenCalled();
  });

  it("forks only after validating targetEntryId ownership", async () => {
    const { POST } = await import("./route");
    const res = await POST(localReq({ targetEntryId: "entry-ok" }), {
      params: Promise.resolve({ id: "source" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      id: "forked",
      path: "/tmp/forked.jsonl",
      cwd: "/repo",
      targetEntryId: "entry-ok",
    });
    expect(sessionManagerMock.forkFrom).toHaveBeenCalledWith(
      "/tmp/source.jsonl",
      "/repo"
    );
    const forkedManager = sessionManagerMock.forkFrom.mock.results[0].value;
    expect(forkedManager.branch).toHaveBeenCalledWith("entry-ok");
  });
});

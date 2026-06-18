import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_LOCAL_SECRET = "vitest-session-meta-secret";

const sessionsMock = vi.hoisted(() => ({
  findSessionPathById: vi.fn(),
}));

const metaStoreMock = vi.hoisted(() => ({
  readMeta: vi.fn(),
  updateMeta: vi.fn(),
}));

vi.mock("@/lib/sessions", () => sessionsMock);
vi.mock("@/lib/meta/store", () => metaStoreMock);

function localReq(method: string, body?: unknown) {
  return new Request("http://localhost:3000/api/sessions/session-1/meta", {
    method,
    headers: {
      "content-type": "application/json",
      "x-diga-agent-local-secret": TEST_LOCAL_SECRET,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/sessions/[id]/meta", () => {
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
    metaStoreMock.updateMeta.mockResolvedValue({ id: "session-1", pinned: true });
  });

  it("rejects PATCH for missing sessions before writing meta", async () => {
    sessionsMock.findSessionPathById.mockResolvedValue(null);
    const { PATCH } = await import("./route");
    const res = await PATCH(localReq("PATCH", { pinned: true }), {
      params: Promise.resolve({ id: "session-1" }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: "session not found",
    });
    expect(metaStoreMock.updateMeta).not.toHaveBeenCalled();
  });

  it("ignores lastSeenAt values far in the future", async () => {
    const { PATCH } = await import("./route");
    const res = await PATCH(
      localReq("PATCH", { lastSeenAt: Date.now() + 60 * 60 * 1000 }),
      { params: Promise.resolve({ id: "session-1" }) }
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "no writable fields in body",
    });
    expect(metaStoreMock.updateMeta).not.toHaveBeenCalled();
  });
});

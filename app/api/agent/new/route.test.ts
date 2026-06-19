/**
 * T1.1: POST /api/agent/new 的 sessionPath 越权防护测试。
 *
 * 验证：
 * - 未提供 sessionPath：不调 assertTrustedSessionPath，正常创建
 * - 提供 sessionPath 但不在可信清单：返回 400，不进入 createAgent
 * - 提供 sessionPath 且命中可信清单：正常创建，且使用清单里的 path
 * - createAgent 内部异常：返回 internalErrorResponse 风格 500（不再含 stack）
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_LOCAL_SECRET = "vitest-agent-new-secret";

const sessionsMock = vi.hoisted(() => ({
  assertTrustedSessionPath: vi.fn(),
  TrustedSessionPathError: class TrustedSessionPathError extends Error {
    constructor(message = "sessionPath not in trusted list") {
      super(message);
      this.name = "TrustedSessionPathError";
    }
  },
}));

const filesPolicyMock = vi.hoisted(() => ({
  assertPathAllowed: vi.fn((p: string) => p),
}));

const registryMock = vi.hoisted(() => ({
  createAgent: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock("@/lib/sessions", () => sessionsMock);
vi.mock("@/lib/files/policy", () => filesPolicyMock);
vi.mock("@/lib/agent-registry", () => registryMock);
vi.mock("@/lib/api/error-response", () => ({
  internalErrorResponse: () =>
    new Response(JSON.stringify({ error: "internal" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }),
}));

function localReq(body: unknown) {
  return new Request("http://localhost:3000/api/agent/new", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-diga-agent-local-secret": TEST_LOCAL_SECRET,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agent/new", () => {
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
    registryMock.createAgent.mockResolvedValue({
      id: "agent-1",
      sessionId: "sess-1",
      sessionFile: "/trusted/path.jsonl",
    });
    registryMock.getAgent.mockReturnValue({
      session: {
        thinkingLevel: undefined,
        supportsThinking: () => false,
        getAvailableThinkingLevels: () => [],
        model: { provider: "openai", id: "gpt", name: "gpt" },
      },
    });
  });

  it("provider/modelId 缺失时返回 400 且不调 createAgent", async () => {
    const { POST } = await import("./route");
    const res = await POST(localReq({ cwd: "/x" }));
    expect(res.status).toBe(400);
    expect(registryMock.createAgent).not.toHaveBeenCalled();
  });

  it("无 sessionPath 时不调 assertTrustedSessionPath，仍可创建", async () => {
    const { POST } = await import("./route");
    const res = await POST(
      localReq({ provider: "openai", modelId: "gpt", cwd: "/x" }),
    );
    expect(res.status).toBe(200);
    expect(sessionsMock.assertTrustedSessionPath).not.toHaveBeenCalled();
    expect(registryMock.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt",
        sessionPath: undefined,
      }),
    );
  });

  it("sessionPath 不在可信清单时返回 400，不进入 createAgent", async () => {
    sessionsMock.assertTrustedSessionPath.mockRejectedValueOnce(
      new sessionsMock.TrustedSessionPathError(),
    );
    const { POST } = await import("./route");
    const res = await POST(
      localReq({
        provider: "openai",
        modelId: "gpt",
        cwd: "/x",
        sessionPath: "/etc/hosts",
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "sessionPath not allowed",
    });
    expect(registryMock.createAgent).not.toHaveBeenCalled();
  });

  it("sessionPath 命中可信清单时使用清单 path 创建", async () => {
    sessionsMock.assertTrustedSessionPath.mockResolvedValueOnce(
      "/trusted/path.jsonl",
    );
    const { POST } = await import("./route");
    const res = await POST(
      localReq({
        provider: "openai",
        modelId: "gpt",
        cwd: "/x",
        sessionPath: "/trusted/path.jsonl",
      }),
    );
    expect(res.status).toBe(200);
    expect(registryMock.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionPath: "/trusted/path.jsonl",
      }),
    );
  });

  it("createAgent 抛异常时走 internalErrorResponse（不带 stack）", async () => {
    registryMock.createAgent.mockRejectedValueOnce(new Error("boom"));
    const { POST } = await import("./route");
    const res = await POST(
      localReq({ provider: "openai", modelId: "gpt", cwd: "/x" }),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).not.toHaveProperty("stack");
  });
});

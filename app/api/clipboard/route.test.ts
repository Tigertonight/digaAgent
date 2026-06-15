import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clipboard/runtime", () => ({
  writeClipboardText: vi.fn(async (text: string) => {
    const value = text.trim();
    if (!value) {
      throw new Error("text required");
    }
    return { ok: true, length: value.length };
  }),
}));

import { writeClipboardText } from "@/lib/clipboard/runtime";
import { POST } from "./route";

// 装饰器在 local secret 未设时会拒绝远程请求。测试中创建一个 secret
// 并走 same-origin local fast path。
const TEST_LOCAL_SECRET = "vitest-local-secret";

function clipboardRequest(body: unknown, opts: { local?: boolean } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.local !== false) {
    headers["x-diga-agent-local-secret"] = TEST_LOCAL_SECRET;
  }
  return new Request("http://localhost/api/clipboard", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/clipboard", () => {
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
  });

  it("writes text to the clipboard", async () => {
    const response = await POST(
      clipboardRequest({ text: " https://example.com " }),
    );

    await expect(response.json()).resolves.toEqual({ ok: true, length: 19 });
    expect(response.status).toBe(200);
    expect(writeClipboardText).toHaveBeenCalledWith(" https://example.com ");
  });

  it("rejects empty clipboard text", async () => {
    const response = await POST(clipboardRequest({ text: "   " }));

    await expect(response.json()).resolves.toEqual({ error: "text required" });
    expect(response.status).toBe(400);
  });

  it("rejects remote callers without local secret", async () => {
    const response = await POST(
      clipboardRequest({ text: "hi" }, { local: false }),
    );
    // 远程访问被拒：401 或 403 都可以（具体看 remote-access settings）。
    expect([401, 403]).toContain(response.status);
    expect(writeClipboardText).not.toHaveBeenCalled();
  });
});

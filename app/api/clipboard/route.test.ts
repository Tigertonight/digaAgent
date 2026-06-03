import { beforeEach, describe, expect, it, vi } from "vitest";

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

function clipboardRequest(body: unknown) {
  return new Request("http://localhost/api/clipboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/clipboard", () => {
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
});

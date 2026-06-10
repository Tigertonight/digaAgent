import { describe, expect, it } from "vitest";
import { toUserFacingError, userFacingMessage } from "./user-facing-error";

describe("user-facing error mapping", () => {
  it("maps auth and pairing failures to rescan guidance", () => {
    const error = toUserFacingError("load failed 200/401/401", {
      context: "remote",
    });
    expect(error.code).toBe("pairing_required");
    expect(error.title).toBe("需要重新扫码");
    expect(error.message).toContain("重新生成二维码");
  });

  it("maps public tunnel network failures to public unavailable", () => {
    const error = toUserFacingError("Load failed", {
      baseUrl: "https://example.trycloudflare.com",
      context: "remote",
    });
    expect(error.code).toBe("public_unavailable");
    expect(error.message).toContain("公网通道暂时不可达");
  });

  it("keeps unknown errors useful without leaking empty strings", () => {
    expect(userFacingMessage("", { context: "settings" })).toBe(
      "操作没有完成，请稍后重试。"
    );
  });
});

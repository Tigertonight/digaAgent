import { describe, expect, it } from "vitest";
// vitest 配置允许测试 import .js
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isAllowedWebviewSrc } = require("./security-policy") as {
  isAllowedWebviewSrc: (src: string | undefined | null) => {
    ok: boolean;
    reason?: string;
  };
};

describe("isAllowedWebviewSrc (A4-3 webview src 协议白名单)", () => {
  it("放行 https / http", () => {
    expect(isAllowedWebviewSrc("https://example.com").ok).toBe(true);
    expect(isAllowedWebviewSrc("http://localhost:3000").ok).toBe(true);
  });

  it("放行 about:blank（应用初始化态）", () => {
    expect(isAllowedWebviewSrc("about:blank").ok).toBe(true);
  });

  it("放行空 src（attach 时 Chromium 走默认）", () => {
    expect(isAllowedWebviewSrc("").ok).toBe(true);
    expect(isAllowedWebviewSrc(undefined).ok).toBe(true);
    expect(isAllowedWebviewSrc(null).ok).toBe(true);
  });

  it("拒绝 file:// 读本地文件", () => {
    const v = isAllowedWebviewSrc("file:///etc/passwd");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/file:/);
  });

  it("拒绝 chrome:// / about: (除 about:blank)", () => {
    expect(isAllowedWebviewSrc("chrome://settings").ok).toBe(false);
    expect(isAllowedWebviewSrc("about:flags").ok).toBe(false);
  });

  it("拒绝 javascript: / data: 等可执行协议", () => {
    expect(isAllowedWebviewSrc("javascript:alert(1)").ok).toBe(false);
    expect(isAllowedWebviewSrc("data:text/html,<script>alert(1)</script>").ok).toBe(
      false
    );
  });

  it("拒绝畸形 URL", () => {
    const v = isAllowedWebviewSrc("not a url");
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("malformed-url");
  });

  it("两端空白被 trim", () => {
    expect(isAllowedWebviewSrc("   https://example.com   ").ok).toBe(true);
  });
});

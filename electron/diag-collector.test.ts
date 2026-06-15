import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { redactLine, sanitizeRendererSnapshot } = require("./diag-collector") as {
  redactLine: (line: string) => string;
  sanitizeRendererSnapshot: (input: unknown) => Record<string, unknown> | null;
};

describe("diag-collector.redactLine (敏感信息脱敏)", () => {
  it("sk- 开头的 anthropic / openai key 被脱敏", () => {
    const out = redactLine("got key sk-ant-abcdefghijk1234567890XYZ in env");
    expect(out).not.toContain("abcdefghijk1234567890");
    expect(out).toMatch(/\[redacted\]/);
  });

  it("Bearer token 被脱敏", () => {
    const out = redactLine("Authorization: Bearer abcdef1234567890");
    expect(out).not.toContain("abcdef1234567890");
    expect(out).toMatch(/\[redacted\]/);
  });

  it("长 hex / token-like 串被脱敏", () => {
    const long = "a".repeat(50);
    const out = redactLine("trace " + long);
    expect(out).not.toContain(long);
  });

  it("普通日志原样保留（短词、中文、路径）", () => {
    const line = "[ok] /api/health -> 200 (用户主目录 /Users/yz)";
    const out = redactLine(line);
    expect(out).toBe(line);
  });

  it("空串 / 数字 / 短串不被处理", () => {
    expect(redactLine("")).toBe("");
    expect(redactLine("5 messages")).toBe("5 messages");
    expect(redactLine("ok")).toBe("ok");
  });
});

describe("sanitizeRendererSnapshot (Diag-2 renderer 状态限制)", () => {
  it("null / 非对象 → null", () => {
    expect(sanitizeRendererSnapshot(null)).toBeNull();
    expect(sanitizeRendererSnapshot(undefined)).toBeNull();
    expect(sanitizeRendererSnapshot(42)).toBeNull();
    expect(sanitizeRendererSnapshot("x")).toBeNull();
  });

  it("空对象 → null", () => {
    expect(sanitizeRendererSnapshot({})).toBeNull();
  });

  it("保留已知字段、丢掉未知字段", () => {
    const out = sanitizeRendererSnapshot({
      url: "http://localhost:3000/",
      providersCount: 3,
      online: true,
      cookies: "sneaky=evil",
      __proto__: { polluted: true },
    });
    expect(out).toEqual({
      url: "http://localhost:3000/",
      providersCount: 3,
      online: true,
    });
    expect(out).not.toHaveProperty("cookies");
    expect(out).not.toHaveProperty("polluted");
  });

  it("长字段被截断到已知上限", () => {
    const out = sanitizeRendererSnapshot({
      url: "x".repeat(2000),
      userAgent: "u".repeat(2000),
    });
    expect(out?.url as string).toHaveLength(500);
    expect(out?.userAgent as string).toHaveLength(500);
  });

  it("负数 / 小数 被强转为非负整数", () => {
    const out = sanitizeRendererSnapshot({
      providersCount: -5,
      authedProvidersCount: 2.7,
      windowErrorCount: -1,
    });
    expect(out?.providersCount).toBe(0);
    expect(out?.authedProvidersCount).toBe(2);
    expect(out?.windowErrorCount).toBe(0);
  });

  it("recentWindowErrors 只取前 10、丢掉缺 message 的", () => {
    const errs = Array.from({ length: 20 }, (_, i) => ({
      message: `error-${i}`,
      source: "file.js",
      line: i,
      col: 0,
      ts: 100 + i,
    }));
    errs.push({ message: "", source: "x", line: 0, col: 0, ts: 0 });
    const out = sanitizeRendererSnapshot({ recentWindowErrors: errs });
    expect(Array.isArray(out?.recentWindowErrors)).toBe(true);
    expect((out!.recentWindowErrors as unknown[]).length).toBe(10);
  });

  it("类型错误的字段被丢", () => {
    const out = sanitizeRendererSnapshot({
      url: 123,
      online: "yes",
      locale: { evil: 1 },
    });
    expect(out).toBeNull();
  });
});

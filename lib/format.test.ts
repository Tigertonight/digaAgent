import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatTokens,
  formatMessageTime,
  formatRelativeTime,
  shortCwd,
} from "./format";

describe("formatTokens", () => {
  it("returns raw number when < 1k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("uses 1 decimal when 1k–10k", () => {
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(9999)).toBe("10.0k");
  });

  it("uses 0 decimal when 10k–1M", () => {
    expect(formatTokens(10_000)).toBe("10k");
    expect(formatTokens(123_456)).toBe("123k");
  });

  it("uses M suffix when >= 1M", () => {
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(12_500_000)).toBe("12.5M");
  });
});

describe("formatMessageTime", () => {
  beforeEach(() => {
    // 固定 now = 2026-06-15 12:00:00 local
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty string for falsy / non-finite ts", () => {
    expect(formatMessageTime()).toBe("");
    expect(formatMessageTime(0)).toBe("");
    expect(formatMessageTime(NaN)).toBe("");
  });

  it("returns HH:MM when same day as now", () => {
    const ts = new Date(2026, 5, 15, 9, 5, 0).getTime();
    expect(formatMessageTime(ts)).toBe("09:05");
  });

  it("returns M月D日 HH:MM when different day", () => {
    const ts = new Date(2026, 4, 1, 23, 59, 0).getTime();
    expect(formatMessageTime(ts)).toBe("5月1日 23:59");
  });
});

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty for non-finite input", () => {
    expect(formatRelativeTime("not-a-date")).toBe("");
  });

  it("returns 'just now' when < 1 minute ago", () => {
    expect(formatRelativeTime(Date.now() - 30_000)).toBe("just now");
  });

  it("returns Nm ago for minutes (1–59)", () => {
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe("5m ago");
  });

  it("returns Nh ago for hours (1–23)", () => {
    expect(formatRelativeTime(Date.now() - 3 * 60 * 60_000)).toBe("3h ago");
  });

  it("returns Nd ago for days (1–6)", () => {
    expect(formatRelativeTime(Date.now() - 2 * 24 * 60 * 60_000)).toBe(
      "2d ago"
    );
  });

  it("falls back to locale date when >= 7 days", () => {
    const out = formatRelativeTime(Date.now() - 10 * 24 * 60 * 60_000);
    expect(out).not.toBe("");
    // 不强校验具体格式（依赖 ICU 数据），仅断言不是上面任一相对短语
    expect(out).not.toMatch(/ago|just now/);
  });
});

describe("shortCwd", () => {
  it("returns empty for empty input", () => {
    expect(shortCwd("")).toBe("");
  });

  it("returns trimmed path unchanged when <= 2 segments", () => {
    expect(shortCwd("/Users/alice")).toBe("~");
    expect(shortCwd("/foo")).toBe("/foo");
    expect(shortCwd("/foo/bar")).toBe("/foo/bar");
  });

  it("collapses to …/last2 when > 2 segments", () => {
    expect(shortCwd("/Users/alice/proj/app/src")).toBe("…/app/src");
    expect(shortCwd("/a/b/c/d")).toBe("…/c/d");
  });
});

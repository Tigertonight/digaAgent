import { describe, expect, it } from "vitest";
import { extractMentionsFromPaste } from "./paste-mentions";

describe("extractMentionsFromPaste", () => {
  it("提取单个 @/abs/path", () => {
    const r = extractMentionsFromPaste("看下 @/Users/me/proj/foo.ts");
    expect(r.paths).toEqual(["/Users/me/proj/foo.ts"]);
    expect(r.remainingText).toBe("看下");
  });

  it("提取多个，保留顺序与去重", () => {
    const r = extractMentionsFromPaste(
      "@/a/b.ts 帮看 @/c/d.tsx @/a/b.ts 重复"
    );
    expect(r.paths).toEqual(["/a/b.ts", "/c/d.tsx"]);
    expect(r.remainingText).toBe("帮看 重复");
  });

  it("没有 mention → paths 空、文本不变", () => {
    const r = extractMentionsFromPaste("普通文本，不含 mention");
    expect(r.paths).toEqual([]);
    expect(r.remainingText).toBe("普通文本，不含 mention");
  });

  it("@ 在单词中间不算 mention", () => {
    const r = extractMentionsFromPaste("user@host:/etc/foo");
    expect(r.paths).toEqual([]);
    expect(r.remainingText).toBe("user@host:/etc/foo");
  });

  it("相对 @./foo 不识别", () => {
    const r = extractMentionsFromPaste("@./foo @/Users/a.ts");
    expect(r.paths).toEqual(["/Users/a.ts"]);
    expect(r.remainingText).toBe("@./foo");
  });

  it("@ 后立即遇空格不识别（避免 `@ 主题` 这种自然写法误伤）", () => {
    const r = extractMentionsFromPaste("@ 这是一个题目 @/x.ts");
    expect(r.paths).toEqual(["/x.ts"]);
    expect(r.remainingText).toBe("@ 这是一个题目");
  });

  it("空字符串", () => {
    const r = extractMentionsFromPaste("");
    expect(r.paths).toEqual([]);
    expect(r.remainingText).toBe("");
  });

  it("纯 mention 文本（只有路径）→ remainingText 为空", () => {
    const r = extractMentionsFromPaste("@/a/b.ts @/c/d.ts");
    expect(r.paths).toEqual(["/a/b.ts", "/c/d.ts"]);
    expect(r.remainingText.trim()).toBe("");
  });

  it("路径含特殊字符（点、横线、下划线）", () => {
    const r = extractMentionsFromPaste("@/a/b-c.test_v2.ts");
    expect(r.paths).toEqual(["/a/b-c.test_v2.ts"]);
    expect(r.remainingText.trim()).toBe("");
  });
});

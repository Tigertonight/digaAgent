/**
 * RFC-3 Phase B / F2：tokenize 单测。
 *
 * 覆盖：
 *   - 空 / 空白
 *   - 纯英文 + 大小写归一 + 数字
 *   - 纯中文 + bigram + 单字
 *   - 中英混合
 *   - 标点 / emoji 作为分隔符
 *   - tokenizeQuery 多关键词
 */

import { describe, expect, it } from "vitest";

import { tokenize, tokenizeQuery } from "./tokenize";

describe("tokenize()", () => {
  it("空字符串返回 []", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });

  it("英文 lowercase + 数字", () => {
    const tokens = tokenize("Hello World 123 ABC");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
    expect(tokens).toContain("123");
    expect(tokens).toContain("abc");
  });

  it("英文去重", () => {
    const tokens = tokenize("foo Foo FOO foo");
    const fooCount = tokens.filter((t) => t === "foo").length;
    expect(fooCount).toBe(1);
  });

  it("中文：单字 + bigram", () => {
    const tokens = tokenize("采购单");
    expect(tokens).toContain("采");
    expect(tokens).toContain("购");
    expect(tokens).toContain("单");
    expect(tokens).toContain("采购");
    expect(tokens).toContain("购单");
  });

  it("中文短词只产生单字（长度 1 段）", () => {
    const tokens = tokenize("中");
    expect(tokens).toContain("中");
    // 不应有 bigram
    expect(tokens.every((t) => t.length === 1)).toBe(true);
  });

  it("标点和空格作为分隔符（不跨段 bigram）", () => {
    const tokens = tokenize("采购，单");
    // "采购" 是同段 bigram；但 "购单" 不应出现（被逗号隔开）
    expect(tokens).toContain("采");
    expect(tokens).toContain("购");
    expect(tokens).toContain("单");
    expect(tokens).toContain("采购");
    expect(tokens).not.toContain("购单");
  });

  it("中英混合", () => {
    const tokens = tokenize("Hello 采购 World");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
    expect(tokens).toContain("采");
    expect(tokens).toContain("购");
    expect(tokens).toContain("采购");
  });

  it("emoji 不作为 token", () => {
    const tokens = tokenize("hello 😀 world");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
    expect(tokens).not.toContain("😀");
  });

  it("纯标点返回 []", () => {
    expect(tokenize("!!! ??? ,,, ...")).toEqual([]);
  });
});

describe("tokenizeQuery()", () => {
  it("空 query 返回 []", () => {
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery("   ")).toEqual([]);
  });

  it("单词 query", () => {
    const tokens = tokenizeQuery("hello");
    expect(tokens).toEqual(expect.arrayContaining(["hello"]));
  });

  it("多 token query（空格分隔）", () => {
    const tokens = tokenizeQuery("采购 hello");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("采");
    expect(tokens).toContain("购");
    expect(tokens).toContain("采购");
  });

  it("中文逗号也作分隔符", () => {
    const tokens = tokenizeQuery("采购，订单");
    expect(tokens).toContain("采购");
    expect(tokens).toContain("订单");
  });

  it("去重", () => {
    const tokens = tokenizeQuery("foo foo Foo");
    expect(tokens.filter((t) => t === "foo")).toHaveLength(1);
  });
});

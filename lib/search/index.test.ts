/**
 * RFC-3 Phase B / F2：buildIndex + search 单测。
 */

import { describe, expect, it } from "vitest";

import { buildIndex, search } from "./index";
import type { SearchDoc } from "./types";

function makeDoc(
  sessionId: string,
  entries: Array<{ entryId: string; text: string; kind?: "user" | "assistant" }>,
): SearchDoc {
  const fullText = entries.map((e) => e.text).join("\n");
  return {
    sessionId,
    path: `/tmp/${sessionId}.jsonl`,
    cwd: "/tmp",
    indexedAt: 1_700_000_000_000,
    fullText,
    hits: entries.map((e) => ({
      entryId: e.entryId,
      kind: e.kind ?? "user",
      text: e.text,
    })),
  };
}

describe("buildIndex()", () => {
  it("空 docs 返回空索引", () => {
    const idx = buildIndex([]);
    expect(idx.docs.size).toBe(0);
    expect(idx.inverted.size).toBe(0);
    expect(idx.builtAt).toBeGreaterThan(0);
  });

  it("英文文档：token → sessionId 倒排正确", () => {
    const idx = buildIndex([
      makeDoc("s1", [{ entryId: "e1", text: "hello world" }]),
      makeDoc("s2", [{ entryId: "e2", text: "hello there" }]),
    ]);
    expect(idx.inverted.get("hello")).toEqual(new Set(["s1", "s2"]));
    expect(idx.inverted.get("world")).toEqual(new Set(["s1"]));
    expect(idx.inverted.get("there")).toEqual(new Set(["s2"]));
  });

  it("中文文档：bigram 倒排", () => {
    const idx = buildIndex([
      makeDoc("s1", [{ entryId: "e1", text: "采购单审批" }]),
    ]);
    expect(idx.inverted.get("采购")).toEqual(new Set(["s1"]));
    expect(idx.inverted.get("购单")).toEqual(new Set(["s1"]));
    expect(idx.inverted.get("审批")).toEqual(new Set(["s1"]));
  });
});

describe("search()", () => {
  const idx = buildIndex([
    makeDoc("s1", [
      { entryId: "e1", text: "hello world from session one" },
      { entryId: "e2", text: "采购单的审批流程" },
    ]),
    makeDoc("s2", [
      { entryId: "e3", text: "hello there session two" },
      { entryId: "e4", text: "another payment record" },
    ]),
    makeDoc("s3", [{ entryId: "e5", text: "purely chinese 采购订单 only" }]),
  ]);

  it("空 query 返回 []", () => {
    expect(search(idx, "")).toEqual([]);
    expect(search(idx, "   ")).toEqual([]);
  });

  it("单 token 命中多 session", () => {
    const results = search(idx, "hello");
    const ids = results.map((r) => r.sessionId).sort();
    expect(ids).toEqual(["s1", "s2"]);
  });

  it("多 token AND：必须全部命中", () => {
    const results = search(idx, "hello world");
    expect(results.map((r) => r.sessionId)).toEqual(["s1"]);
  });

  it("无命中 token → []", () => {
    expect(search(idx, "nonexistent")).toEqual([]);
  });

  it("部分 token 无命中 → AND 失败返回 []", () => {
    expect(search(idx, "hello nonexistent")).toEqual([]);
  });

  it("中文 bigram 命中", () => {
    const results = search(idx, "采购");
    const ids = results.map((r) => r.sessionId).sort();
    expect(ids).toEqual(["s1", "s3"]);
  });

  it("命中结果含 snippet 和 matchedTokens", () => {
    const results = search(idx, "world");
    expect(results).toHaveLength(1);
    expect(results[0].hits).toHaveLength(1);
    expect(results[0].hits[0]).toMatchObject({
      entryId: "e1",
      kind: "user",
      matchedTokens: ["world"],
    });
    expect(results[0].hits[0].snippet).toContain("world");
  });

  it("limit 截断", () => {
    const results = search(idx, "hello", 1);
    expect(results).toHaveLength(1);
  });

  it("score 排序：多 token 命中靠前", () => {
    const idx2 = buildIndex([
      makeDoc("a", [{ entryId: "e", text: "hello world" }]), // hello + world 都中
      makeDoc("b", [{ entryId: "e", text: "hello there" }]), // 只 hello
    ]);
    const results = search(idx2, "hello world");
    expect(results[0].sessionId).toBe("a"); // a 应该排第一（b 根本不该出现因为 AND）
    expect(results).toHaveLength(1);
  });

  it("snippet 过长时加省略号", () => {
    const longText = "x".repeat(200) + " needle " + "y".repeat(200);
    const idx2 = buildIndex([
      makeDoc("s", [{ entryId: "e", text: longText }]),
    ]);
    const results = search(idx2, "needle");
    expect(results[0].hits[0].snippet).toContain("needle");
    expect(results[0].hits[0].snippet.startsWith("…")).toBe(true);
    expect(results[0].hits[0].snippet.endsWith("…")).toBe(true);
  });
});

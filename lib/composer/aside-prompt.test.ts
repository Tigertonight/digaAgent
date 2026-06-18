import { describe, expect, it } from "vitest";
import {
  composePromptWithAside,
  parseAttachments,
} from "./aside-prompt";
import { stripContextAside } from "@/lib/context-aside";

describe("composePromptWithAside", () => {
  it("无附件、无 mention：finalText === displayText === text", () => {
    const r = composePromptWithAside("hello world", [], { specialistIds: [] });
    expect(r.displayText).toBe("hello world");
    expect(r.finalText).toBe("hello world");
    expect(r.mentionDirective).toBeNull();
  });

  it("有附件：finalText 包 CONTEXT_ASIDE，displayText 不变", () => {
    const r = composePromptWithAside(
      "看下这两个",
      ["/a/b.ts", "/c/d.tsx"],
      { specialistIds: [] }
    );
    expect(r.displayText).toBe("看下这两个");
    expect(r.finalText).toContain("看下这两个");
    expect(r.finalText).toContain("Referenced files/folders");
    expect(r.finalText).toContain("@/a/b.ts");
    expect(r.finalText).toContain("@/c/d.tsx");
    // P2 一致性：前端 stripContextAside 后回到 displayText。
    expect(stripContextAside(r.finalText)).toBe("看下这两个");
  });

  it("@agent mention 命中：mentionDirective 非 null，displayText 去 @ 后", () => {
    const r = composePromptWithAside(
      "@coder fix this",
      [],
      { specialistIds: ["coder", "writer"] }
    );
    expect(r.mentionDirective).not.toBeNull();
    expect(r.mentionDirective?.agentIds).toEqual(["coder"]);
    expect(r.displayText).toBe("fix this");
    // finalText 仍含 directive
    expect(r.finalText).toContain("CONTEXT_ASIDE");
    expect(r.finalText).toContain("delegate_subagents");
    // 用户气泡（stripContextAside）只看到干净原话。
    expect(stripContextAside(r.finalText)).toBe("fix this");
  });

  it("@agent mention + attachments 同时存在：两段 aside 都进 finalText", () => {
    const r = composePromptWithAside(
      "@coder review @path",
      ["/x.ts"],
      { specialistIds: ["coder"] }
    );
    expect(r.finalText).toContain("Referenced files/folders");
    expect(r.finalText).toContain("delegate_subagents");
  });

  it("specialistIds 空数组：mentionDirective 永远 null（即使含 @x）", () => {
    const r = composePromptWithAside(
      "@anyone hello",
      [],
      { specialistIds: [] }
    );
    expect(r.mentionDirective).toBeNull();
    expect(r.displayText).toBe("@anyone hello");
    expect(r.finalText).toBe("@anyone hello");
  });

  it("空 attachments：不出现 ASIDE 包裹", () => {
    const r = composePromptWithAside("hi", [], { specialistIds: [] });
    expect(r.finalText).not.toContain("CONTEXT_ASIDE");
  });
});

describe("parseAttachments", () => {
  it("非数组 → 空", () => {
    expect(parseAttachments(undefined)).toEqual([]);
    expect(parseAttachments(null)).toEqual([]);
    expect(parseAttachments("a")).toEqual([]);
    expect(parseAttachments({ paths: ["a"] })).toEqual([]);
  });

  it("过滤非 string 元素", () => {
    expect(parseAttachments(["a", 1, null, "b", { p: "c" }])).toEqual([
      "a",
      "b",
    ]);
  });

  it("正常数组原样返回", () => {
    expect(parseAttachments(["/a", "/b"])).toEqual(["/a", "/b"]);
  });
});

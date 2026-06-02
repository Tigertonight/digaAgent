import { describe, it, expect } from "vitest";
import { matchRule } from "./matcher";
import type { ApprovalRule } from "./types";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

/**
 * 构造一个最小可用的 ToolCallEvent。
 * SDK 的 ToolCallEvent 是个 discriminated union，这里强转一下方便测试；
 * matcher 只读 toolName + input，不关心其他字段。
 */
function makeEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "tc-test",
    toolName,
    input,
  } as ToolCallEvent;
}

function rule(id: string, match: ApprovalRule["match"]): ApprovalRule {
  return { id, name: id, match, on: "ask" };
}

describe("matchRule", () => {
  it("toolName 单值命中", () => {
    const r = rule("r1", { toolName: "bash" });
    expect(matchRule(makeEvent("bash", { command: "ls" }), [r])).toBe(r);
  });

  it("toolName 单值不命中", () => {
    const r = rule("r1", { toolName: "bash" });
    expect(matchRule(makeEvent("read", { path: "x" }), [r])).toBeUndefined();
  });

  it("toolName 数组命中（命中其中一个）", () => {
    const r = rule("r1", { toolName: ["bash", "edit"] });
    expect(matchRule(makeEvent("edit", { path: "x", oldString: "a", newString: "b" }), [r])).toBe(r);
  });

  it("toolName 数组不命中（都不在内）", () => {
    const r = rule("r1", { toolName: ["bash", "edit"] });
    expect(matchRule(makeEvent("read", { path: "x" }), [r])).toBeUndefined();
  });

  it("inputMatch.contains 命中其中一个 keyword", () => {
    const r = rule("r1", {
      toolName: "bash",
      inputMatch: { command: { contains: ["rm -rf", "shutdown"] } },
    });
    expect(matchRule(makeEvent("bash", { command: "sudo rm -rf /tmp/foo" }), [r])).toBe(r);
  });

  it("inputMatch.contains 全都不命中", () => {
    const r = rule("r1", {
      toolName: "bash",
      inputMatch: { command: { contains: ["rm -rf", "shutdown"] } },
    });
    expect(matchRule(makeEvent("bash", { command: "ls -la" }), [r])).toBeUndefined();
  });

  it("inputMatch.regex 命中", () => {
    const r = rule("r1", {
      toolName: "bash",
      inputMatch: { command: { regex: "^git\\s+reset\\s+--hard" } },
    });
    expect(matchRule(makeEvent("bash", { command: "git reset --hard HEAD~1" }), [r])).toBe(r);
  });

  it("inputMatch.regex 不命中", () => {
    const r = rule("r1", {
      toolName: "bash",
      inputMatch: { command: { regex: "^git\\s+reset\\s+--hard" } },
    });
    expect(matchRule(makeEvent("bash", { command: "git status" }), [r])).toBeUndefined();
  });

  it("inputMatch + toolName 是 AND（toolName 命中但 inputMatch 不命中 → no match）", () => {
    const r = rule("r1", {
      toolName: "bash",
      inputMatch: { command: { contains: ["rm -rf"] } },
    });
    expect(matchRule(makeEvent("bash", { command: "ls" }), [r])).toBeUndefined();
  });

  it("空 matcher {} 匹配任意 event", () => {
    const r = rule("r1", {});
    expect(matchRule(makeEvent("read", { path: "x" }), [r])).toBe(r);
  });

  it("inputMatch 字段不存在 → 不命中", () => {
    const r = rule("r1", {
      toolName: "bash",
      inputMatch: { nonExistent: { contains: ["x"] } },
    });
    expect(matchRule(makeEvent("bash", { command: "ls" }), [r])).toBeUndefined();
  });

  it("inputMatch 字段值非 string → 不命中", () => {
    const r = rule("r1", {
      toolName: "bash",
      inputMatch: { command: { contains: ["x"] } },
    });
    expect(matchRule(makeEvent("bash", { command: 42 }), [r])).toBeUndefined();
  });

  it("inputMatch.contains 与 .regex 是 AND（同字段下都要满足）", () => {
    const r = rule("r1", {
      toolName: "bash",
      inputMatch: {
        command: { contains: ["rm"], regex: "-rf" },
      },
    });
    // 同时有 "rm" 且 regex 匹配 "-rf"
    expect(matchRule(makeEvent("bash", { command: "rm -rf /tmp/x" }), [r])).toBe(r);
    // 有 "rm" 但 regex 不匹配
    expect(matchRule(makeEvent("bash", { command: "rm /tmp/x" }), [r])).toBeUndefined();
  });

  it("多条规则按顺序返回第一条命中的", () => {
    const r1 = rule("r1", { toolName: "edit" });
    const r2 = rule("r2", { toolName: "bash" });
    const r3 = rule("r3", { toolName: "bash", inputMatch: { command: { contains: ["rm"] } } });
    // event 是 bash + rm，r2 / r3 都命中，但 r2 在前
    expect(matchRule(makeEvent("bash", { command: "rm x" }), [r1, r2, r3])).toBe(r2);
  });

  it("空规则数组返回 undefined", () => {
    expect(matchRule(makeEvent("bash", { command: "ls" }), [])).toBeUndefined();
  });

  it("contains 的 keyword 数组为空 → 视为该子条件无约束（只看其他条件）", () => {
    const r = rule("r1", {
      toolName: "bash",
      inputMatch: { command: { contains: [] } },
    });
    // contains: [] 不阻止命中（无 keyword 要求）
    expect(matchRule(makeEvent("bash", { command: "anything" }), [r])).toBe(r);
  });
});

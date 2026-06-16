import { describe, expect, it } from "vitest";
import type { MessagePart } from "@/lib/types";
import { narrateTool, shortPath, shouldHideTool } from "./tool";

type Tool = Extract<MessagePart, { kind: "tool" }>;
const tool = (toolName: string, args: unknown, status: Tool["status"] = "running", extra: Partial<Tool> = {}): Tool => ({
  kind: "tool",
  toolCallId: "t1",
  toolName,
  args,
  status,
  ...extra,
});

describe("tool narration", () => {
  it("keeps useful search query text", () => {
    expect(narrateTool(tool("search", { query: "今天公司大事" })).primary).toBe(
      "正在查找：今天公司大事"
    );
  });

  it("recognizes hibo knowledge query and strips flags", () => {
    expect(
      narrateTool(tool("bash", { command: "hibo info 年假怎么请 --cookie secret" })).primary
    ).toBe("正在帮你查询知识库：年假怎么请");
  });

  it("recognizes hibo meeting query", () => {
    expect(
      narrateTool(tool("bash", { command: "hibo meeting rooms --date 2026-06-12" })).primary
    ).toBe("正在帮你查询会议室");
  });

  it("recognizes skill SKILL.md reads as learning a skill", () => {
    expect(
      narrateTool(
        tool("read", { path: "/app/skills/weather/SKILL.md" })
      ).primary
    ).toBe("正在学习「weather」技能");
  });

  it("recognizes skill scripts as using a skill", () => {
    expect(
      narrateTool(
        tool("bash", {
          command:
            "/app/skills/oa-employee-festival/scripts/getBirthBlessing.sh --cookie abc",
        })
      ).primary
    ).toBe("正在使用「oa-employee-festival」技能");
  });

  it("shortens file path to last two segments", () => {
    expect(shortPath("from /a/b/c/Foo.java")).toBe("c/Foo.java");
    expect(narrateTool(tool("read", { path: "/a/b/c/Foo.java" })).primary).toBe(
      "正在查看 c/Foo.java"
    );
  });

  it("hides internal process and progress tools", () => {
    expect(shouldHideTool(tool("update_progress", {}))).toBe(true);
    expect(shouldHideTool(tool("bash", { command: "Process: quiet-otter" }))).toBe(true);
  });

  it("sanitizes secrets in fallback terminal commands", () => {
    expect(
      narrateTool(tool("bash", { command: "curl https://x --token abc123" })).primary
    ).toBe("正在运行终端命令：curl https://x --token ***");
  });

  it("adds recovery text on error", () => {
    const n = narrateTool(
      tool("bash", { command: "npm test" }, "error", {
        result: { stderr: "boom" },
        isError: true,
      })
    );
    expect(n.primary).toContain("执行失败：验证");
    expect(n.recovery).toContain("boom");
  });
});

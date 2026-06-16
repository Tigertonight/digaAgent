import { describe, expect, it } from "vitest";
import { isWorthNarrating, narrateTool, shouldHideTool, type ToolPart } from "./tool";

const mk = (over: Partial<ToolPart>): ToolPart => ({
  kind: "tool",
  toolCallId: "call_1",
  toolName: "read",
  args: {},
  status: "running",
  ...over,
}) as ToolPart;

describe("narrateTool — Phase 1 规则升级", () => {
  it("read 工具：保留末两段路径", () => {
    const n = narrateTool(mk({ toolName: "read", args: { path: "/a/b/c/Foo.java" } }));
    expect(n.primary).toContain("查看");
    expect(n.primary).toContain("c/Foo.java");
    expect(n.hidden).toBeFalsy();
  });

  it("write 工具：写入文案", () => {
    const n = narrateTool(
      mk({
        toolName: "write",
        status: "done",
        args: { path: "/repo/lib/foo.ts", content: "x" },
      })
    );
    expect(n.primary).toContain("写入");
    expect(n.primary).toContain("lib/foo.ts");
  });

  it("bash + 验证类命令：使用『验证』动词", () => {
    const n = narrateTool(
      mk({ toolName: "bash", args: { command: "npm run test" } })
    );
    expect(n.primary).toContain("正在");
    expect(n.primary).toMatch(/验证|test/);
  });

  it("bash + 含 cookie：屏蔽 secret", () => {
    const n = narrateTool(
      mk({
        toolName: "bash",
        args: {
          command:
            "/app/skills/oa-employee-festival/scripts/getBirth.sh --cookie SECRET",
        },
      })
    );
    // 命中 skill 路径 → 走"使用技能"路径
    expect(n.primary).toContain("使用");
    expect(n.primary).toContain("oa-employee-festival");
  });

  it("read SKILL.md：识别为学习技能", () => {
    const n = narrateTool(
      mk({
        toolName: "read",
        args: { path: "/Users/me/.pi/agent/skills/weather/SKILL.md" },
      })
    );
    expect(n.primary).toContain("学习");
    expect(n.primary).toContain("weather");
  });

  it("web_search：保留查询词", () => {
    const n = narrateTool(
      mk({
        toolName: "web_search",
        args: { query: "今天公司有啥大事" },
      })
    );
    expect(n.primary).toContain("搜索");
    expect(n.primary).toContain("今天公司");
  });

  it("hibo meeting query：转为「查询会议室」", () => {
    const n = narrateTool(
      mk({
        toolName: "bash",
        args: {
          command: "hibo meeting query --date 2026-06-13 --start 14:00",
        },
      })
    );
    expect(n.primary).toContain("会议室");
  });

  it("error 状态时输出 recovery 提示", () => {
    const n = narrateTool(
      mk({
        toolName: "read",
        status: "error",
        isError: true,
        args: { path: "/a/b/Foo.java" },
        result: { error: "ENOENT: no such file" },
      })
    );
    expect(n.recovery).toBeTruthy();
    expect(n.recovery).toContain("ENOENT");
  });
});

describe("isWorthNarrating — Phase 3 LLM 白名单", () => {
  it("只允许 exec / 搜索类进入 LLM 增强", () => {
    expect(
      isWorthNarrating(
        mk({ toolName: "bash", args: { command: "hibo info 年假" } })
      )
    ).toBe(true);
    expect(
      isWorthNarrating(
        mk({ toolName: "web_search", args: { query: "小红书新闻" } })
      )
    ).toBe(true);
    expect(
      isWorthNarrating(mk({ toolName: "read", args: { path: "/a/b/Foo.ts" } }))
    ).toBe(false);
    expect(
      isWorthNarrating(
        mk({
          toolName: "bash",
          args: { command: "/app/skills/weather/scripts/run.sh" },
        })
      )
    ).toBe(false);
  });
});

describe("shouldHideTool — Phase 2 降噪", () => {
  it("update_progress / goal_update 隐藏", () => {
    expect(shouldHideTool(mk({ toolName: "update_progress" }))).toBe(true);
    expect(shouldHideTool(mk({ toolName: "goal_update" }))).toBe(true);
  });
  it("read / write / bash 不隐藏", () => {
    expect(shouldHideTool(mk({ toolName: "read", args: { path: "/a/b" } }))).toBe(false);
    expect(shouldHideTool(mk({ toolName: "bash", args: { command: "ls" } }))).toBe(false);
  });
  it("Process: quiet-otter 这种内部代号路径隐藏", () => {
    expect(
      shouldHideTool(mk({ toolName: "process", args: { status: "Process: quiet-otter" } }))
    ).toBe(true);
  });
});

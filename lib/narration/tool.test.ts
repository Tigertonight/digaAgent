import { describe, expect, it } from "vitest";
import {
  detectTruncatedToolCall,
  isWorthNarrating,
  narrateTool,
  shouldHideTool,
  type ToolPart,
} from "./tool";

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

describe("narrateTool — grep / rg 命令 label 不拽出整条命令", () => {
  it("bash 里的长 grep 命令只取 pattern，不拽 file 列表", () => {
    const n = narrateTool(
      mk({
        toolName: "bash",
        status: "done",
        args: {
          command:
            'grep -n "deleteSession|removeSession" lib/session-runner.ts lib/meta/store.ts app/hooks/useSessions.ts app/mobile/MobileApp.ts',
        },
      })
    );
    // 以前会脓成 "已完成：查找：-n "deleteSession|removeSession" lib/..."、
    // 依赖后续 truncate；现在只保留 pattern。
    expect(n.primary).toContain("查找");
    expect(n.primary).toContain("deleteSession|removeSession");
    expect(n.primary).not.toContain("lib/session-runner.ts");
    expect(n.primary).not.toContain("app/mobile/MobileApp.ts");
  });

  it("rg 后面跟多个 -g flag 也能到 pattern", () => {
    const n = narrateTool(
      mk({
        toolName: "bash",
        status: "done",
        args: {
          command:
            "rg -n 'executeDeleteSession' -g '*.test.ts' -g '!node_modules' lib/ app/",
        },
      })
    );
    expect(n.primary).toContain("查找");
    expect(n.primary).toContain("executeDeleteSession");
    expect(n.primary).not.toContain("node_modules");
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

describe("工具失败错误透出 + 截断检测", () => {
  const validationResult = (text: string) => ({ content: [{ type: "text", text }] });

  it("透出 write 校验失败的真实错误（result 为 {content:[...]} 包装）", () => {
    const n = narrateTool(
      mk({
        toolName: "write",
        status: "error",
        isError: true,
        args: { path: "/repo/docs/session-audit-2026-06-18.md" },
        result: validationResult(
          'Validation failed for tool "write":\n  - content: must have required properties content'
        ),
      })
    );
    // 不再是泛泛的「工具返回了错误状态」
    expect(n.recovery).toBeTruthy();
    expect(n.recovery).toContain("content");
  });

  it("识别截断特征并给出分段重写建议", () => {
    const n = narrateTool(
      mk({
        toolName: "write",
        status: "error",
        isError: true,
        args: { path: "/repo/docs/report.md" },
        result: validationResult(
          'Validation failed for tool "write":\n  - content: must have required properties content'
        ),
      })
    );
    expect(n.recovery).toContain("疑似被截断");
    expect(n.recovery).toContain("分多次追加");
  });

  it("detectTruncatedToolCall 命中缺失必填大字段，非截断返回 null", () => {
    expect(
      detectTruncatedToolCall(
        'Validation failed for tool "write": - content: must have required properties content'
      )
    ).toBe("content");
    expect(
      detectTruncatedToolCall(
        'Validation failed for tool "edit": - edits: is required'
      )
    ).toBe("edits");
    // 普通运行时错误不应被误判为截断
    expect(detectTruncatedToolCall("ENOENT: no such file or directory")).toBeNull();
    expect(
      detectTruncatedToolCall('Validation failed for tool "read": - path: must be string')
    ).toBeNull();
  });
});

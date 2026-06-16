import { describe, expect, it } from "vitest";
import {
  detectSkillFromPath,
  isInternalNoiseTool,
  isVerificationCommand,
  shortPath,
  shorten,
} from "./tool-utils";

describe("shortPath", () => {
  it("仅保留末两段", () => {
    expect(shortPath("/Users/me/code/lib/foo.ts")).toBe("lib/foo.ts");
  });
  it("一段或两段直接保留", () => {
    expect(shortPath("foo.ts")).toBe("foo.ts");
    expect(shortPath("lib/foo.ts")).toBe("lib/foo.ts");
  });
  it("URL 不动（避免误截断 https://）", () => {
    expect(shortPath("https://docs.example.com/a/b/c")).toBe(
      "https://docs.example.com/a/b/c"
    );
  });
  it("反斜杠当分隔符", () => {
    expect(shortPath("C:\\Users\\me\\code\\lib\\foo.ts")).toBe("lib/foo.ts");
  });
});

describe("shorten", () => {
  it("长文本截断带省略号", () => {
    const text = "a".repeat(200);
    expect(shorten(text, 50).length).toBe(50);
    expect(shorten(text, 50).endsWith("…")).toBe(true);
  });
  it("空字符串返回空", () => {
    expect(shorten("", 10)).toBe("");
  });
  it("折叠空白", () => {
    expect(shorten("hi   there\n\nfriend", 80)).toBe("hi there friend");
  });
});

describe("detectSkillFromPath", () => {
  it("SKILL.md 视为学习技能", () => {
    expect(
      detectSkillFromPath("/app/skills/weather/SKILL.md")
    ).toEqual({ skillName: "weather", isLearning: true });
  });
  it("脚本路径视为使用技能", () => {
    expect(
      detectSkillFromPath(
        "/app/skills/oa-employee-festival/scripts/getBlessing.sh"
      )
    ).toEqual({ skillName: "oa-employee-festival", isLearning: false });
  });
  it("非 skills 路径返回 null", () => {
    expect(detectSkillFromPath("/Users/me/foo.ts")).toBeNull();
  });
  it(".pi/agent/skills 也识别", () => {
    expect(
      detectSkillFromPath("/Users/me/.pi/agent/skills/find-skills/SKILL.md")
    ).toEqual({ skillName: "find-skills", isLearning: true });
  });
});

describe("isVerificationCommand", () => {
  it("识别 npm test / lint", () => {
    expect(isVerificationCommand("npm run test")).toBe(true);
    expect(isVerificationCommand("npm run lint -- --max-warnings=0")).toBe(true);
  });
  it("不把日常 ls/grep 当验证", () => {
    expect(isVerificationCommand("ls -la")).toBe(false);
    expect(isVerificationCommand("git status")).toBe(false);
  });
});

describe("isInternalNoiseTool", () => {
  it("update_progress / goal_update 等被隐藏", () => {
    expect(isInternalNoiseTool("update_progress")).toBe(true);
    expect(isInternalNoiseTool("Goal_Update")).toBe(true);
  });
  it("read / write 不会被错误隐藏", () => {
    expect(isInternalNoiseTool("read")).toBe(false);
    expect(isInternalNoiseTool("bash")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  agentTeamMemberSessionTitleFromText,
  sessionDisplayTitle,
} from "./display-title";

describe("session display title", () => {
  it("turns Agent Team teammate prompts into readable member task titles", () => {
    const prompt = [
      "You are a teammate in an Agent Team run.",
      "Team objective: 检查 agent team",
      "Your member id: team-1:researcher",
      "Task id: evidence",
      "Task title: 定位代码与证据",
      "Task description: 查找相关文件",
    ].join("\n");

    expect(agentTeamMemberSessionTitleFromText(prompt)).toBe("资料员：定位代码与证据");
  });

  it("prefers explicit titles before the teammate prompt fallback", () => {
    expect(
      sessionDisplayTitle({
        meta: { id: "s1", title: "用户标题" },
        name: "系统标题",
        firstMessage: "You are a teammate in an Agent Team run.",
      })
    ).toBe("用户标题");
  });

  it("falls back to the original first message for normal sessions", () => {
    expect(
      sessionDisplayTitle({
        firstMessage: "帮我检查项目",
      })
    ).toBe("帮我检查项目");
  });
});

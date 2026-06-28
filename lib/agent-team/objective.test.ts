import { describe, expect, it } from "vitest";
import { sanitizeAgentTeamObjective, summarizeAgentTeamObjective } from "./objective";

describe("sanitizeAgentTeamObjective", () => {
  it("keeps a normal objective unchanged", () => {
    expect(sanitizeAgentTeamObjective("请用团队协作复核 lib/agent-team")).toBe(
      "请用团队协作复核 lib/agent-team"
    );
  });

  it("removes top bar labels pasted before the objective", () => {
    expect(
      sanitizeAgentTeamObjective(
        "Branches System prompt Live 请用团队协作复核 lib/agent-team"
      )
    ).toBe("请用团队协作复核 lib/agent-team");
  });

  it("removes the legacy /team command prefix", () => {
    expect(
      sanitizeAgentTeamObjective(
        "/team TEAM_E2E：只读确认 app/page.tsx 是否存在"
      )
    ).toBe("TEAM_E2E：只读确认 app/page.tsx 是否存在");
  });

  it("removes modal title labels pasted as separate lines", () => {
    expect(
      sanitizeAgentTeamObjective(
        "System prompt\nLive\n请用团队协作复核 lib/agent-team"
      )
    ).toBe("请用团队协作复核 lib/agent-team");
  });

  it("strips hidden context aside before launching Team", () => {
    expect(
      sanitizeAgentTeamObjective(
        "审计 Team\n\n<<<CONTEXT_ASIDE>>>\ninternal mode\n<<<END_CONTEXT_ASIDE>>>"
      )
    ).toBe("审计 Team");
  });

  it("summarizes long objectives for compact Team cards", () => {
    const summary = summarizeAgentTeamObjective(
      "Branches System prompt Live 请用团队协作检查一个非常长的目标，确认完成态不会被原始 query 里的继续推进或需要处理这些字样污染默认状态展示。",
      36
    );

    expect(summary).toBe("请用团队协作检查一个非常长的目标，确认完成态不会被原始 query 里…");
    expect(summary).not.toContain("继续推进");
    expect(summary).not.toContain("需要处理");
  });
});

import { describe, expect, it } from "vitest";
import { createInitialAgentTeamRun } from "./mock";
import {
  inferAgentTeamPlannerTags,
  planAgentTeamDeterministic,
} from "./planner";

const baseSettings = {
  memberScale: "standard" as const,
  allowNetwork: false,
  allowWrite: false,
  allowWorktree: false,
  allowChallenges: true,
  requirePlanApproval: true,
  displayMode: "workspace" as const,
  writePolicy: "read_only" as const,
  networkPolicy: "disabled" as const,
  worktreePolicy: "none" as const,
  resultIngestionMode: "structured" as const,
  coordinationProfile: "basic" as const,
  stopConditions: {
    requiredTasksComplete: true,
    noOpenBlockingChallenges: true,
    leadFinalSynthesis: true,
  },
};

describe("Agent Team deterministic planner", () => {
  it("infers objective tags from Chinese and English wording", () => {
    expect(inferAgentTeamPlannerTags("帮我 review 代码并做回归测试")).toEqual([
      "code",
      "qa",
    ]);
    expect(inferAgentTeamPlannerTags("调研市场资料，输出报告")).toEqual([
      "research",
      "writing",
    ]);
    expect(inferAgentTeamPlannerTags("analyze sql metrics and dataset")).toEqual([
      "data",
    ]);
  });

  it("plans code/write teams with Builder while preserving stable core member ids", () => {
    const out = planAgentTeamDeterministic({
      objective: "帮我修复代码并 review 风险",
      settings: { ...baseSettings, allowWrite: true, writePolicy: "plan_approval" },
      runId: "team-x",
      leadAgentId: "team-x:lead",
      now: 100,
    });

    expect(out.profile).toBe("deterministic");
    expect(out.tags).toContain("code");
    expect(out.members.map((member) => member.id)).toContain("team-x:builder");
    expect(out.members.map((member) => member.id)).toContain("team-x:critic");
    expect(out.tasks.map((task) => task.id)).toContain("implementation-plan");
  });

  it("keeps member scale caps deterministic", () => {
    const small = planAgentTeamDeterministic({
      objective: "复杂架构审计，需要多视角",
      settings: { ...baseSettings, memberScale: "small" },
      runId: "team-small",
      leadAgentId: "team-small:lead",
      now: 100,
    });
    const deep = planAgentTeamDeterministic({
      objective: "复杂架构审计，需要多视角和数据分析",
      settings: { ...baseSettings, memberScale: "deep", allowWrite: true },
      runId: "team-deep",
      leadAgentId: "team-deep:lead",
      now: 100,
    });

    expect(small.members).toHaveLength(3);
    expect(deep.members).toHaveLength(7);
    expect(deep.members.some((member) => member.name === "Builder")).toBe(true);
  });

  it("writes planner metadata into created runs", () => {
    const run = createInitialAgentTeamRun("帮我 review lib/agent-team 代码并输出报告", {
      memberScale: "standard",
      allowWrite: true,
    });

    expect(run.plannerProfile).toBe("deterministic");
    expect(run.plannerInputs?.objective).toContain("lib/agent-team");
    expect(run.plannerInputs?.tags).toEqual(
      expect.arrayContaining(["code", "writing"])
    );
    expect(run.board.tasks.find((task) => task.id === "evidence")?.description).toContain("代码");
  });
});

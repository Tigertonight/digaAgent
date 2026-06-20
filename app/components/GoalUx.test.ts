import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GOAL_BLOCKED_CATEGORY_LABELS,
  GOAL_STATUS_LABELS,
  goalAcceptanceSummary,
} from "@/lib/goal/labels";

describe("Goal UX labels and acceptance criteria", () => {
  it("uses Chinese labels for goal status and blocked categories", () => {
    expect(GOAL_STATUS_LABELS.active).toBe("进行中");
    expect(GOAL_STATUS_LABELS.complete).toBe("已完成");
    expect(GOAL_BLOCKED_CATEGORY_LABELS.needs_user).toBe("等待用户输入");
    expect(GOAL_BLOCKED_CATEGORY_LABELS.tool_error).toBe("工具错误");
  });

  it("summarizes acceptance criteria progress", () => {
    expect(
      goalAcceptanceSummary([
        { id: "a", criterion: "A", status: "met" },
        { id: "b", criterion: "B", status: "pending" },
      ])
    ).toBe("已通过 1/2");
    expect(goalAcceptanceSummary(undefined)).toBe("未定义验收标准");
  });

  it("renders goal acceptance in GoalBar and GoalTimeline", () => {
    const goalBar = readFileSync(
      path.join(process.cwd(), "app/components/GoalBar.tsx"),
      "utf8"
    );
    const timeline = readFileSync(
      path.join(process.cwd(), "app/components/GoalTimeline.tsx"),
      "utf8"
    );
    const messagesScrollArea = readFileSync(
      path.join(process.cwd(), "app/components/MessagesScrollArea.tsx"),
      "utf8"
    );

    expect(goalBar).toContain("goalAcceptanceSummary(goal.acceptanceCriteria)");
    expect(goalBar).toContain("data-testid=\"goal-acceptance-panel\"");
    expect(timeline).toContain("GoalTimelineAcceptance");
    expect(timeline).toContain("goal: json.goal ?? null");
    expect(messagesScrollArea).toContain("data-testid=\"sticky-goal-summary\"");
    expect(messagesScrollArea).toContain("goalAcceptanceSummary(goal.acceptanceCriteria)");
  });
});

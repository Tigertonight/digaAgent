import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Mobile goal visibility", () => {
  it("renders a mobile goal strip and wires goal events/actions", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/mobile/MobileApp.tsx"),
      "utf8"
    );

    expect(source).toContain("data-testid=\"mobile-goal-strip\"");
    expect(source).toContain("goalStatusLabel(goal)");
    expect(source).toContain("goalAcceptanceSummary(goal.acceptanceCriteria)");
    expect(source).toContain("event?.type === \"goal_updated\"");
    expect(source).toContain("runGoalAction(\"goal_pause\")");
    expect(source).toContain("runGoalAction(\"goal_resume\")");
    expect(source).toContain("runGoalAction(\"goal_clear\")");
  });
});

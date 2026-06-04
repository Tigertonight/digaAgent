import { describe, expect, it, beforeEach } from "vitest";
import {
  __resetGoalStoreForTest,
  clearGoal,
  getGoal,
  noteGoalContinuation,
  setGoal,
  setGoalStatus,
} from "./server-store";

describe("goal server store", () => {
  beforeEach(() => {
    __resetGoalStoreForTest();
  });

  it("sets and clears a session goal", () => {
    const goal = setGoal("agent-1", " Finish the migration ");

    expect(goal.objective).toBe("Finish the migration");
    expect(goal.status).toBe("active");
    expect(goal.turns).toBe(0);
    expect(getGoal("agent-1")?.objective).toBe("Finish the migration");

    clearGoal("agent-1");
    expect(getGoal("agent-1")).toBeNull();
  });

  it("tracks continuations and terminal status", () => {
    setGoal("agent-1", "Ship goal mode");

    const continued = noteGoalContinuation("agent-1");
    expect(continued?.turns).toBe(1);
    expect(continued?.lastRunAt).toBeTypeOf("number");

    const complete = setGoalStatus("agent-1", "complete");
    expect(complete?.status).toBe("complete");
    expect(complete?.completedAt).toBeTypeOf("number");
  });

  it("stores blocked and pause reasons", () => {
    setGoal("agent-1", "Run all checks");

    expect(
      setGoalStatus("agent-1", "paused", { pauseReason: "Budget limit reached." })
        ?.pauseReason
    ).toBe("Budget limit reached.");
    expect(
      setGoalStatus("agent-1", "blocked", { blockedReason: "Missing API key." })
        ?.blockedReason
    ).toBe("Missing API key.");
  });
});

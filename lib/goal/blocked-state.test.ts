import { describe, expect, it } from "vitest";
import {
  BLOCKED_RETRY_THRESHOLD,
  buildBlockedState,
  inferBlockedCategory,
  shouldStopRetrying,
} from "./blocked-state";
import type { GoalBlockedState } from "./types";

describe("inferBlockedCategory", () => {
  it.each([
    ["Waiting for approval to run shell", "needs_approval"],
    ["Merge conflict in worktree", "merge_conflict"],
    ["Please provide the target environment", "needs_user"],
    ["Missing API key for provider", "external_dependency"],
    ["Operation blocked by policy", "policy"],
    ["Command failed with exit code 1", "tool_error"],
    ["Something weird happened", "unknown"],
    [undefined, "unknown"],
  ])("classifies %p as %s", (reason, expected) => {
    expect(inferBlockedCategory(reason as string | undefined).category).toBe(
      expected
    );
  });

  it("always provides a non-empty unblock action", () => {
    expect(inferBlockedCategory("anything").unblockAction.length).toBeGreaterThan(
      0
    );
    expect(inferBlockedCategory(undefined).unblockAction.length).toBeGreaterThan(
      0
    );
  });
});

describe("buildBlockedState", () => {
  it("starts a fresh state at count 1", () => {
    const state = buildBlockedState("Missing API key", undefined, 1000);
    expect(state.repeatedCount).toBe(1);
    expect(state.firstBlockedAt).toBe(1000);
    expect(state.lastBlockedAt).toBe(1000);
    expect(state.category).toBe("external_dependency");
  });

  it("increments count and preserves firstBlockedAt for the same blocker", () => {
    const first = buildBlockedState("Missing API key", undefined, 1000);
    const second = buildBlockedState("Missing API key", first, 2000);
    expect(second.repeatedCount).toBe(2);
    expect(second.firstBlockedAt).toBe(1000);
    expect(second.lastBlockedAt).toBe(2000);
  });

  it("resets count when the blocker changes", () => {
    const first = buildBlockedState("Missing API key", undefined, 1000);
    const second = buildBlockedState("Merge conflict", first, 2000);
    expect(second.repeatedCount).toBe(1);
    expect(second.firstBlockedAt).toBe(2000);
    expect(second.category).toBe("merge_conflict");
  });

  it("treats a resolved previous blocker as a fresh start", () => {
    const resolved: GoalBlockedState = {
      reason: "Missing API key",
      category: "external_dependency",
      unblockAction: "x",
      repeatedCount: 5,
      firstBlockedAt: 1,
      lastBlockedAt: 2,
      resolvedAt: 3,
    };
    const next = buildBlockedState("Missing API key", resolved, 4000);
    expect(next.repeatedCount).toBe(1);
    expect(next.firstBlockedAt).toBe(4000);
  });

  it("falls back to a default reason for empty input", () => {
    const state = buildBlockedState("  ", undefined, 1000);
    expect(state.reason).toBe("Blocked.");
  });
});

describe("shouldStopRetrying", () => {
  function stateWithCount(count: number): GoalBlockedState {
    return {
      reason: "x",
      category: "unknown",
      unblockAction: "y",
      repeatedCount: count,
      firstBlockedAt: 0,
      lastBlockedAt: 0,
    };
  }

  it("returns false below the threshold", () => {
    expect(shouldStopRetrying(stateWithCount(BLOCKED_RETRY_THRESHOLD - 1))).toBe(
      false
    );
  });

  it("returns true at the threshold", () => {
    expect(shouldStopRetrying(stateWithCount(BLOCKED_RETRY_THRESHOLD))).toBe(
      true
    );
  });

  it("returns false for undefined", () => {
    expect(shouldStopRetrying(undefined)).toBe(false);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setGoalStoreRootForTest,
  addGoalEvidence,
  getGoal,
  setGoal,
} from "./file-store";
import { applyGoalUpdate } from "./update";

describe("applyGoalUpdate (verifier integration)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "mini-pi-goals-"));
    __setGoalStoreRootForTest(root);
  });

  afterEach(() => {
    __setGoalStoreRootForTest(null);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns not-accepted when no goal exists", () => {
    const result = applyGoalUpdate("missing", { status: "complete" });
    expect(result.accepted).toBe(false);
    expect(result.goal).toBeNull();
  });

  it("rejects a premature complete with no evidence and keeps the goal active", () => {
    setGoal("agent-1", "Do the thing");

    const result = applyGoalUpdate("agent-1", { status: "complete" });

    expect(result.accepted).toBe(false);
    expect(result.rejectionNote).toBeTruthy();
    expect(result.rejectionNote).toContain("NOT accepted");
    // Goal must remain active.
    expect(getGoal("agent-1")?.status).toBe("active");
  });

  it("accepts complete once evidence exists", () => {
    setGoal("agent-1", "Do the thing");
    addGoalEvidence("agent-1", {
      id: "ev-1",
      kind: "test",
      title: "tests pass",
      createdAt: Date.now(),
    });

    const result = applyGoalUpdate("agent-1", { status: "complete" });

    expect(result.accepted).toBe(true);
    expect(result.rejectionNote).toBeUndefined();
    expect(getGoal("agent-1")?.status).toBe("complete");
    expect(getGoal("agent-1")?.completedAt).toBeTypeOf("number");
  });

  it("applies blocked directly without verification", () => {
    setGoal("agent-1", "Do the thing");

    const result = applyGoalUpdate("agent-1", {
      status: "blocked",
      blockedReason: "Missing API key",
    });

    expect(result.accepted).toBe(true);
    expect(getGoal("agent-1")?.status).toBe("blocked");
    expect(getGoal("agent-1")?.blockedReason).toBe("Missing API key");
  });

  it("writes a structured blocked state with inferred category", () => {
    setGoal("agent-1", "Do the thing");
    applyGoalUpdate("agent-1", {
      status: "blocked",
      blockedReason: "Waiting for approval",
    });

    const state = getGoal("agent-1")?.blockedState;
    expect(state?.category).toBe("needs_approval");
    expect(state?.repeatedCount).toBe(1);
    expect(state?.unblockAction).toBeTruthy();
    expect(getGoal("agent-1")?.blockedStreak).toBe(1);
  });

  it("increments repeatedCount when the same blocker recurs", () => {
    setGoal("agent-1", "Do the thing");
    applyGoalUpdate("agent-1", { status: "blocked", blockedReason: "stuck" });
    applyGoalUpdate("agent-1", { status: "blocked", blockedReason: "stuck" });

    expect(getGoal("agent-1")?.blockedState?.repeatedCount).toBe(2);
    expect(getGoal("agent-1")?.blockedStreak).toBe(2);
  });

  it("resets blocked streak and resolves state on accepted complete", () => {
    setGoal("agent-1", "Do the thing");
    applyGoalUpdate("agent-1", { status: "blocked", blockedReason: "stuck" });
    addGoalEvidence("agent-1", {
      id: "ev-1",
      kind: "test",
      title: "tests pass",
      createdAt: Date.now(),
    });
    // Goal is blocked; move back to a verifiable complete path. The verifier
    // reads status-independent inputs, so completing works once evidence exists.
    const result = applyGoalUpdate("agent-1", { status: "complete" });

    expect(result.accepted).toBe(true);
    expect(getGoal("agent-1")?.status).toBe("complete");
    expect(getGoal("agent-1")?.blockedStreak).toBe(0);
    expect(getGoal("agent-1")?.blockedState?.resolvedAt).toBeTypeOf("number");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setWorkflowStoreRootForTest,
  putWorkflowRun,
} from "../workflows/server-store";
import type { WorkflowRun } from "../workflows/types";
import {
  __setGoalStoreRootForTest,
  addGoalEvidence,
  getGoal,
  setGoal,
} from "./file-store";
import { applyGoalUpdate } from "./update";

describe("applyGoalUpdate (verifier integration)", () => {
  let root: string;
  let workflowRoot: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "mini-pi-goals-"));
    workflowRoot = mkdtempSync(path.join(os.tmpdir(), "mini-pi-workflows-"));
    __setGoalStoreRootForTest(root);
    __setWorkflowStoreRootForTest(workflowRoot);
  });

  afterEach(() => {
    __setGoalStoreRootForTest(null);
    __setWorkflowStoreRootForTest(null);
    rmSync(root, { recursive: true, force: true });
    rmSync(workflowRoot, { recursive: true, force: true });
  });

  function workflow(
    id: string,
    patch: Partial<WorkflowRun> & Pick<WorkflowRun, "parentAgentId" | "status" | "createdAt">
  ): WorkflowRun {
    return {
      id,
      objective: id,
      rationale: "test workflow",
      script: "return true;",
      manifest: {
        capabilities: ["spawn_agent", "read_files"],
        maxAgents: 8,
        maxConcurrency: 4,
        timeoutMs: 600000,
        runtime: "process",
      },
      artifacts: [],
      checkpoints: [],
      logs: [],
      ...patch,
    };
  }

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

  it("ignores failed workflows created before the active goal", () => {
    putWorkflowRun(
      workflow("old-failed", {
        parentAgentId: "agent-1",
        status: "failed",
        createdAt: Date.now() - 10000,
        endedAt: Date.now() - 9000,
      })
    );
    setGoal("agent-1", "Do the thing");
    addGoalEvidence("agent-1", {
      id: "ev-1",
      kind: "test",
      title: "tests pass",
      createdAt: Date.now(),
    });

    const result = applyGoalUpdate("agent-1", { status: "complete" });

    expect(result.accepted).toBe(true);
    expect(getGoal("agent-1")?.status).toBe("complete");
  });

  it("accepts when a later successful workflow supersedes an earlier goal-era failure", () => {
    const goal = setGoal("agent-1", "Do the thing");
    putWorkflowRun(
      workflow("failed-during-goal", {
        parentAgentId: "agent-1",
        status: "failed",
        createdAt: goal.createdAt + 1,
        endedAt: goal.createdAt + 2,
      })
    );
    putWorkflowRun(
      workflow("success-after-failure", {
        parentAgentId: "agent-1",
        status: "completed",
        createdAt: goal.createdAt + 3,
        endedAt: goal.createdAt + 4,
      })
    );
    addGoalEvidence("agent-1", {
      id: "ev-1",
      kind: "test",
      title: "tests pass",
      createdAt: Date.now(),
    });

    const result = applyGoalUpdate("agent-1", { status: "complete" });

    expect(result.accepted).toBe(true);
    expect(getGoal("agent-1")?.status).toBe("complete");
  });

  it("rejects when the newest goal-era workflow failure is unresolved", () => {
    const goal = setGoal("agent-1", "Do the thing");
    putWorkflowRun(
      workflow("success-before-failure", {
        parentAgentId: "agent-1",
        status: "completed",
        createdAt: goal.createdAt + 1,
        endedAt: goal.createdAt + 2,
      })
    );
    putWorkflowRun(
      workflow("failed-after-success", {
        parentAgentId: "agent-1",
        status: "failed",
        createdAt: goal.createdAt + 3,
        endedAt: goal.createdAt + 4,
      })
    );
    addGoalEvidence("agent-1", {
      id: "ev-1",
      kind: "test",
      title: "tests pass",
      createdAt: Date.now(),
    });

    const result = applyGoalUpdate("agent-1", { status: "complete" });

    expect(result.accepted).toBe(false);
    expect(result.rejectionNote).toContain("failed/aborted");
    expect(getGoal("agent-1")?.status).toBe("active");
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

import { describe, expect, it } from "vitest";
import type { GoalEvidence } from "./types";
import {
  buildVerifierRejectionNote,
  verifyGoalCompletion,
  type GoalVerifyInput,
} from "./verifier";

function evidence(id: string): GoalEvidence {
  return { id, kind: "file", title: id, createdAt: Date.now() };
}

function input(over: Partial<GoalVerifyInput> = {}): GoalVerifyInput {
  return {
    goal: { objective: "Ship feature" },
    evidence: [evidence("e1")],
    turns: [],
    ...over,
  };
}

describe("goal verifier v1", () => {
  it("accepts completion when evidence exists and nothing failed", () => {
    const result = verifyGoalCompletion(input());
    expect(result.decision).toBe("accept");
    expect(result.missingEvidence).toHaveLength(0);
  });

  it("rejects completion with no evidence", () => {
    const result = verifyGoalCompletion(input({ evidence: [] }));
    expect(result.decision).toBe("reject");
    expect(result.missingEvidence.join(" ")).toMatch(/evidence/i);
  });

  it("rejects completion when a workflow failed", () => {
    const result = verifyGoalCompletion(
      input({ workflowStatuses: ["completed", "failed"] })
    );
    expect(result.decision).toBe("reject");
    expect(result.missingEvidence.join(" ")).toMatch(/failed\/aborted/);
  });

  it("rejects completion when a workflow aborted", () => {
    const result = verifyGoalCompletion(
      input({ workflowStatuses: ["aborted"] })
    );
    expect(result.decision).toBe("reject");
  });

  it("accepts when all workflows completed", () => {
    const result = verifyGoalCompletion(
      input({ workflowStatuses: ["completed", "completed"] })
    );
    expect(result.decision).toBe("accept");
  });

  it("accepts when a failed workflow is superseded by a later completed run", () => {
    const result = verifyGoalCompletion(
      input({
        workflowRuns: [
          { status: "failed", createdAt: 1, id: "failed-old" },
          { status: "completed", createdAt: 2, id: "completed-new" },
        ],
      })
    );
    expect(result.decision).toBe("accept");
  });

  it("rejects when a failed workflow is newer than the latest completed run", () => {
    const result = verifyGoalCompletion(
      input({
        workflowRuns: [
          { status: "completed", createdAt: 1, id: "completed-old" },
          { status: "failed", createdAt: 2, id: "failed-new" },
        ],
      })
    );
    expect(result.decision).toBe("reject");
    expect(result.missingEvidence.join(" ")).toMatch(/failed\/aborted/);
  });

  it("rejects when a related workflow is still running", () => {
    const result = verifyGoalCompletion(
      input({ workflowRuns: [{ status: "running", createdAt: 1 }] })
    );
    expect(result.decision).toBe("reject");
    expect(result.missingEvidence.join(" ")).toMatch(/pending\/running/);
  });

  it("rejects when a required acceptance criterion is unmet", () => {
    const result = verifyGoalCompletion(
      input({
        goal: {
          objective: "Ship feature",
          acceptanceCriteria: [
            {
              id: "c1",
              criterion: "All tests pass",
              status: "pending",
            },
          ],
        },
      })
    );
    expect(result.decision).toBe("reject");
    expect(result.missingEvidence.join(" ")).toMatch(/All tests pass/);
  });

  it("accepts when all acceptance criteria are met", () => {
    const result = verifyGoalCompletion(
      input({
        goal: {
          objective: "Ship feature",
          acceptanceCriteria: [
            { id: "c1", criterion: "All tests pass", status: "met" },
          ],
        },
      })
    );
    expect(result.decision).toBe("accept");
  });

  it("aggregates multiple missing reasons", () => {
    const result = verifyGoalCompletion(
      input({
        evidence: [],
        workflowStatuses: ["failed"],
        goal: {
          objective: "x",
          acceptanceCriteria: [
            { id: "c1", criterion: "build green", status: "failed" },
          ],
        },
      })
    );
    expect(result.decision).toBe("reject");
    expect(result.missingEvidence.length).toBeGreaterThanOrEqual(3);
  });

  it("builds a readable rejection note", () => {
    const result = verifyGoalCompletion(input({ evidence: [] }));
    const note = buildVerifierRejectionNote(result);
    expect(note).toContain("NOT accepted");
    expect(note).toContain("Still missing:");
  });

  it("returns empty note for an accepted result", () => {
    const result = verifyGoalCompletion(input());
    expect(buildVerifierRejectionNote(result)).toBe("");
  });
});

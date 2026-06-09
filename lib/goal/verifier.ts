import type {
  AgentGoal,
  GoalAcceptanceCriterion,
  GoalEvidence,
  GoalTurn,
} from "./types";

export type GoalVerifyDecision = "accept" | "reject";

export interface GoalWorkflowStatus {
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  createdAt?: number;
  id?: string;
  objective?: string;
}

export interface GoalVerifyInput {
  goal: Pick<AgentGoal, "objective" | "acceptanceCriteria">;
  evidence: GoalEvidence[];
  turns: GoalTurn[];
  /**
   * Status of workflow runs launched under this goal's agent. The verifier only
   * cares whether any of them failed/aborted, so callers can pass a simple list.
   */
  workflowStatuses?: Array<"pending" | "running" | "completed" | "failed" | "aborted">;
  /**
   * Rich workflow status records, preferably scoped by the caller to the active
   * goal's lifecycle. When provided, failed/aborted runs are considered
   * unresolved only if no later completed workflow supersedes them.
   */
  workflowRuns?: GoalWorkflowStatus[];
}

export interface GoalVerifyResult {
  decision: GoalVerifyDecision;
  /** Human-readable explanation, surfaced to the model when rejected. */
  reason: string;
  /** Descriptions of what is still missing, when rejected. */
  missingEvidence: string[];
}

/**
 * Stop-time goal verifier (v1). Decides whether a model's `goal_update complete`
 * should be accepted based on collected evidence rather than the model's word.
 *
 * Rules (v1, intentionally conservative):
 *  1. No evidence at all -> reject (completion must be backed by something).
 *  2. Any related workflow is still running/pending -> reject.
 *  3. Any related workflow failed/aborted after the latest successful workflow
 *     -> reject (unresolved failure). Older failures can be superseded by a
 *     later successful validation workflow.
 *  4. Acceptance criteria exist and a required one is unmet -> reject.
 *
 * Otherwise accept. This is a pure function: callers gather the inputs (from the
 * goal store / workflow store) and pass them in, which keeps it fully testable.
 */
export function verifyGoalCompletion(
  input: GoalVerifyInput
): GoalVerifyResult {
  const missingEvidence: string[] = [];

  // Rule 1: completion requires at least one piece of evidence.
  if (input.evidence.length === 0) {
    missingEvidence.push(
      "At least one evidence artifact (file, test, diff, url, screenshot, browser, or log). Use update_progress to record concrete evidence."
    );
  }

  const workflowRuns = normalizeWorkflowRuns(input);

  // Rule 2: completion cannot be accepted while related workflows are active.
  const activeWorkflows = workflowRuns.filter(
    (run) => run.status === "pending" || run.status === "running"
  );
  if (activeWorkflows.length > 0) {
    missingEvidence.push(
      `Wait for ${activeWorkflows.length} pending/running workflow run(s) before completing.`
    );
  }

  // Rule 3: failed/aborted workflows block only until a later completed
  // workflow supersedes them. This avoids stale historical failures trapping a
  // goal after a successful rerun records fresh evidence.
  const latestCompletedIndex = workflowRuns
    .map((run, index) => ({ run, index }))
    .filter((item) => item.run.status === "completed")
    .map((item) => item.index)
    .at(-1) ?? -1;
  const failedWorkflows = workflowRuns.filter(
    (run, index) =>
      index > latestCompletedIndex &&
      (run.status === "failed" || run.status === "aborted")
  );
  if (failedWorkflows.length > 0) {
    missingEvidence.push(
      `Resolve ${failedWorkflows.length} failed/aborted workflow run(s) before completing.`
    );
  }

  // Rule 3: required acceptance criteria must be satisfied.
  const unmetCriteria = unmetRequiredCriteria(input.goal.acceptanceCriteria);
  for (const c of unmetCriteria) {
    missingEvidence.push(`Unsatisfied acceptance criterion: ${c.criterion}`);
  }

  if (missingEvidence.length > 0) {
    return {
      decision: "reject",
      reason:
        "Completion was not accepted because required evidence is missing. Keep working on the goal and record evidence, then mark complete again.",
      missingEvidence,
    };
  }

  return {
    decision: "accept",
    reason: "Completion accepted: evidence present and no unresolved failures.",
    missingEvidence: [],
  };
}

function normalizeWorkflowRuns(input: GoalVerifyInput): GoalWorkflowStatus[] {
  if (input.workflowRuns) {
    return input.workflowRuns
      .slice()
      .sort((a, b) =>
        typeof a.createdAt === "number" && typeof b.createdAt === "number"
          ? a.createdAt - b.createdAt
          : 0
      );
  }
  return (input.workflowStatuses ?? []).map((status) => ({ status }));
}

function unmetRequiredCriteria(
  criteria?: GoalAcceptanceCriterion[]
): GoalAcceptanceCriterion[] {
  if (!criteria || criteria.length === 0) return [];
  return criteria.filter((c) => c.status !== "met");
}

/**
 * Build a continuation prompt fragment from a rejected verification, telling the
 * model exactly what is still missing.
 */
export function buildVerifierRejectionNote(result: GoalVerifyResult): string {
  if (result.decision !== "reject") return "";
  const lines = [
    "The goal was NOT accepted as complete yet.",
    result.reason,
  ];
  if (result.missingEvidence.length > 0) {
    lines.push("Still missing:");
    for (const item of result.missingEvidence) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join("\n");
}

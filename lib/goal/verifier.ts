import type {
  AgentGoal,
  GoalAcceptanceCriterion,
  GoalEvidence,
  GoalTurn,
} from "./types";
import { evaluateRubric } from "@/lib/evaluation/evaluator";
import type {
  CriterionScoreInput,
  RubricCriterion,
  RubricEvaluation,
  RubricSpec,
} from "@/lib/evaluation/types";

export type GoalVerifyDecision = "accept" | "reject";

export interface GoalWorkflowStatus {
  status:
    | "pending"
    | "running"
    | "completed"
    | "completed_with_warnings"
    | "needs_continue"
    | "failed"
    | "aborted";
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
  workflowStatuses?: Array<
    | "pending"
    | "running"
    | "completed"
    | "completed_with_warnings"
    | "failed"
    | "aborted"
  >;
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
  /**
   * Weighted rubric result for UI, persistence, and iteration decisions. This is
   * additive: it never overrides the accept/reject gate above, it only enriches
   * it with a score, recommendation, and per-criterion breakdown.
   */
  evaluation: RubricEvaluation;
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
  const workflowRuns = normalizeWorkflowRuns(input);
  const evaluation = evaluateGoalCompletion(input, workflowRuns);

  // Rule 1: completion requires at least one piece of evidence.
  if (input.evidence.length === 0) {
    missingEvidence.push(
      "At least one evidence artifact (file, test, diff, url, screenshot, browser, or log). Use update_progress to record concrete evidence."
    );
  }

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
      evaluation,
    };
  }

  return {
    decision: "accept",
    reason: `Completion accepted: evidence present and no unresolved failures (score ${evaluation.totalScore.toFixed(
      2
    )} / ${evaluation.targetScore.toFixed(2)}).`,
    missingEvidence: [],
    evaluation,
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
 * Build and run an additive rubric evaluation for the goal. Uses only fields the
 * verifier already has, so it stays a pure function and requires no extra inputs.
 * The rubric mirrors the hard gate (evidence + workflow health + acceptance
 * criteria) but expresses it as a weighted score for UI and iteration decisions.
 */
function evaluateGoalCompletion(
  input: GoalVerifyInput,
  workflowRuns: GoalWorkflowStatus[]
): RubricEvaluation {
  const { rubric, scores } = goalRubricInput(input, workflowRuns);
  return evaluateRubric({
    rubric,
    subject: {},
    criteria: scores,
    repeatedBlockerCount: repeatedBlockedTurns(input.turns),
    createdAt: Date.now(),
  });
}

function goalRubricInput(
  input: GoalVerifyInput,
  workflowRuns: GoalWorkflowStatus[]
): { rubric: RubricSpec; scores: CriterionScoreInput[] } {
  const criteria: RubricCriterion[] = [
    {
      id: "goal-evidence",
      dimensionId: "evidence_traceability",
      importance: "essential",
      description:
        "Completion must be backed by at least one concrete evidence artifact.",
      evidenceRequired: ["goal_evidence"],
      hardFail: true,
    },
    {
      id: "workflow-health",
      dimensionId: "runtime_health",
      importance: "essential",
      description: "Related workflows must not be left failed or aborted.",
      hardFail: true,
    },
  ];
  for (const criterion of input.goal.acceptanceCriteria ?? []) {
    criteria.push({
      id: `acceptance:${criterion.id}`,
      dimensionId: "completion_gate",
      importance: "essential",
      description: criterion.criterion,
      hardFail: true,
    });
  }

  // Mirror the hard-gate logic so the score never disagrees with the decision:
  // active OR unsuperseded failed/aborted runs count as unhealthy.
  const latestCompletedIndex =
    workflowRuns
      .map((run, index) => ({ run, index }))
      .filter((item) => item.run.status === "completed")
      .map((item) => item.index)
      .at(-1) ?? -1;
  const unhealthyWorkflows = workflowRuns.filter(
    (run, index) =>
      run.status === "pending" ||
      run.status === "running" ||
      (index > latestCompletedIndex &&
        (run.status === "failed" || run.status === "aborted"))
  );

  const scores: CriterionScoreInput[] = [
    {
      criterionId: "goal-evidence",
      status: input.evidence.length > 0 ? "pass" : "fail",
      reason:
        input.evidence.length > 0
          ? "Goal has concrete evidence."
          : "Goal has no concrete evidence.",
      evidenceIds: input.evidence.map((item) => item.id),
    },
    {
      criterionId: "workflow-health",
      status: unhealthyWorkflows.length > 0 ? "fail" : "pass",
      reason:
        unhealthyWorkflows.length > 0
          ? `${unhealthyWorkflows.length} workflow run(s) are active or unresolved.`
          : "No active or unresolved workflow runs.",
    },
  ];
  for (const criterion of input.goal.acceptanceCriteria ?? []) {
    scores.push({
      criterionId: `acceptance:${criterion.id}`,
      status: criterion.status === "met" ? "pass" : "fail",
      reason:
        criterion.status === "met"
          ? `Acceptance criterion met: ${criterion.criterion}`
          : `Acceptance criterion not met: ${criterion.criterion}`,
      evidenceIds: criterion.evidence ? [criterion.evidence] : undefined,
    });
  }

  const rubric: RubricSpec = {
    id: "goal-completion",
    version: "1",
    title: "Goal completion rubric",
    profileId: "goal.completion",
    taskClass: "workflow",
    targetScore: 0.9,
    dimensions: [
      { id: "completion_gate", name: "验收完成度", weight: 0.45, minScore: 1 },
      { id: "evidence_traceability", name: "证据可追溯性", weight: 0.35, minScore: 1 },
      { id: "runtime_health", name: "运行健康度", weight: 0.2, minScore: 1 },
    ],
    criteria,
    importanceWeights: {
      essential: 1,
      important: 0.7,
      optional: 0.3,
      pitfall: 0.9,
    },
    exitPolicy: {
      maxIterations: 4,
      minDelta: 0.02,
      blockedRepeatLimit: 3,
      scoreCapWithoutEvidence: 0.65,
    },
    createdAt: Date.now(),
  };
  return { rubric, scores };
}

function repeatedBlockedTurns(turns: GoalTurn[]): number {
  let count = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].status !== "blocked") break;
    count += 1;
  }
  return count;
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
  lines.push(
    `Evaluation: ${result.evaluation.status}, score ${result.evaluation.totalScore.toFixed(
      2
    )} / ${result.evaluation.targetScore.toFixed(2)}, recommendation ${
      result.evaluation.recommendation
    }.`
  );
  return lines.join("\n");
}

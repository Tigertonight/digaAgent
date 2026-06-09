import "server-only";
import { listWorkflowRuns } from "../workflows/server-store";
import { buildBlockedState } from "./blocked-state";
import {
  getGoal,
  listGoalEvidence,
  listGoalTurns,
  patchGoal,
  setGoalStatus,
} from "./file-store";
import type { GoalUpdateInput, GoalUpdateResult } from "./types";
import { buildVerifierRejectionNote, verifyGoalCompletion } from "./verifier";

/**
 * Apply a goal status update with stop-time verification.
 *
 * - `blocked` is applied directly (the model is allowed to declare a blocker).
 * - `complete` is routed through the verifier. If the verifier rejects it, the
 *   goal stays ACTIVE and a rejection note is returned so the caller can feed it
 *   back to the model instead of falsely closing the goal.
 *
 * Shared by the goal_update tool (agent-registry) and the goal_update API route
 * so both paths enforce identical completion gating.
 */
export function applyGoalUpdate(
  agentId: string,
  input: GoalUpdateInput
): GoalUpdateResult {
  const current = getGoal(agentId);
  if (!current) {
    return { goal: null, accepted: false };
  }

  if (input.status === "blocked") {
    // Build/advance the structured blocked state. Repeating the same blocker
    // increments repeatedCount (and blockedStreak) so the runtime can later stop
    // auto-retrying a goal stuck on the same wall.
    const blockedState = buildBlockedState(
      input.blockedReason,
      current.blockedState
    );
    setGoalStatus(agentId, "blocked", {
      blockedReason: input.blockedReason,
    });
    const goal = patchGoal(agentId, {
      blockedState,
      blockedStreak: blockedState.repeatedCount,
    });
    return { goal, accepted: true };
  }

  // status === "complete": verify before accepting.
  const workflowRuns = listWorkflowRuns(agentId)
    .filter((run) => run.createdAt >= current.createdAt)
    .map((run) => ({
      id: run.id,
      objective: run.objective,
      status: run.status,
      createdAt: run.createdAt,
    }));
  const verification = verifyGoalCompletion({
    goal: {
      objective: current.objective,
      acceptanceCriteria: current.acceptanceCriteria,
    },
    evidence: listGoalEvidence(agentId),
    turns: listGoalTurns(agentId),
    workflowRuns,
  });

  if (verification.decision === "reject") {
    // Keep the goal active; do not mark complete.
    return {
      goal: current,
      accepted: false,
      rejectionNote: buildVerifierRejectionNote(verification),
    };
  }

  setGoalStatus(agentId, "complete");
  // Resolve any lingering blocked state so a future goal does not inherit a
  // stale blocker; reset the streak.
  const goal = patchGoal(agentId, {
    blockedStreak: 0,
    ...(current.blockedState && current.blockedState.resolvedAt === undefined
      ? {
          blockedState: {
            ...current.blockedState,
            resolvedAt: Date.now(),
          },
        }
      : {}),
  });
  return { goal, accepted: true };
}

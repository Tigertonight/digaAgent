import "server-only";
import type { AgentProgress, ProgressArtifact } from "../progress/types";
import type { GoalEvidence } from "./types";
import { addGoalEvidence, getGoal } from "./file-store";

/**
 * Map a progress artifact to a goal evidence record. The `kind` enums are kept
 * in sync between the two modules, so this is a near 1:1 projection. `other`
 * artifacts collapse to the evidence `other` kind.
 */
export function progressArtifactToEvidence(
  artifact: ProgressArtifact,
  turnNumber?: number
): GoalEvidence {
  return {
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    ...(artifact.href ? { href: artifact.href } : {}),
    ...(artifact.summary ? { summary: artifact.summary } : {}),
    createdAt: artifact.createdAt,
    ...(typeof turnNumber === "number" ? { turnNumber } : {}),
  };
}

/**
 * Bridge a progress snapshot's artifacts into goal evidence. Only writes when
 * the agent currently has an ACTIVE goal, so ordinary chat (and paused/complete
 * goals) never pollute the goal evidence store.
 *
 * `addGoalEvidence` de-duplicates by id, so re-emitting the same artifact across
 * progress updates is safe.
 *
 * @returns the number of evidence records written.
 */
export function bridgeProgressEvidence(
  agentId: string,
  progress: AgentProgress,
  turnNumber?: number
): number {
  const goal = getGoal(agentId);
  if (!goal || goal.status !== "active") return 0;
  let written = 0;
  for (const artifact of progress.artifacts) {
    addGoalEvidence(agentId, progressArtifactToEvidence(artifact, turnNumber));
    written += 1;
  }
  return written;
}

import "server-only";

/**
 * Goal server store facade.
 *
 * The actual storage now lives in {@link ./file-store}, which persists each
 * agent's goal (plus turn/evidence history) to `~/.diga-agent/goals/{agentId}.json`
 * so goals survive a restart. This module preserves the historical public API
 * 1:1 so existing callers (route.ts, agent-registry.ts) and tests need no
 * changes.
 */
export {
  normalizeObjective,
  getGoal,
  setGoal,
  patchGoal,
  setGoalStatus,
  clearGoal,
  noteGoalContinuation,
  addGoalTurn,
  startGoalTurn,
  finishGoalTurn,
  listGoalTurns,
  addGoalEvidence,
  listGoalEvidence,
  buildGoalRecap,
  __setGoalStoreRootForTest,
  __resetGoalStoreForTest,
} from "./file-store";

export type { GoalStoreEnvelope } from "./file-store";

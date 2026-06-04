import type { SubagentDefinition } from "./definition";
import type { SubagentTask } from "./types";

export type ResolvedIsolationMode = "none" | "worktree";

/**
 * Decide whether a subagent task should run in an isolated git worktree.
 *
 * Resolution order (Sprint 3):
 *  1. Definition pins isolation via `isolation.mode` or `permissionMode: "worktree"`.
 *  2. Task explicitly requests `isolation: "worktree"`.
 *  3. Otherwise "none" (legacy behavior, fully backward compatible).
 *
 * A definition can pin "none" to override a task request (definition is the
 * ceiling, consistent with permission resolution).
 */
export function resolveIsolationMode(
  definition: SubagentDefinition | null,
  task: SubagentTask
): ResolvedIsolationMode {
  // Definition explicitly pins isolation off.
  if (definition?.isolation?.mode === "none") return "none";

  // Definition opts into worktree (via isolation config or permission mode).
  if (
    definition?.isolation?.mode === "worktree" ||
    definition?.permissionMode === "worktree"
  ) {
    return "worktree";
  }

  // Task explicitly requests worktree.
  if (task.isolation === "worktree") return "worktree";

  return "none";
}

/** Base ref for the worktree, preferring the definition's configured ref. */
export function resolveIsolationBaseRef(
  definition: SubagentDefinition | null
): string | undefined {
  return definition?.isolation?.baseRef;
}

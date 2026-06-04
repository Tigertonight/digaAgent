import type { GoalBlockedCategory, GoalBlockedState } from "./types";

/** Number of repeated identical blockers after which auto-retry should stop. */
export const BLOCKED_RETRY_THRESHOLD = 3;

interface CategoryRule {
  category: GoalBlockedCategory;
  patterns: RegExp[];
  unblockAction: string;
}

// Order matters: the first matching rule wins.
const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "needs_approval",
    patterns: [/approval/i, /approve/i, /permission denied/i, /awaiting.*approv/i],
    unblockAction: "Approve or deny the pending request in the UI, then resume the goal.",
  },
  {
    category: "merge_conflict",
    patterns: [/merge conflict/i, /conflict/i, /worktree.*conflict/i, /cannot merge/i],
    unblockAction: "Resolve the merge conflict (review the diff/worktree), then resume the goal.",
  },
  {
    category: "needs_user",
    patterns: [
      /need.*(input|clarification|decision|confirm)/i,
      /waiting for (the )?user/i,
      /please (provide|specify|confirm)/i,
      /which .* should/i,
    ],
    unblockAction: "Provide the requested input or decision, then resume the goal.",
  },
  {
    category: "external_dependency",
    patterns: [
      /api key/i,
      /credential/i,
      /not (installed|available)/i,
      /missing dependency/i,
      /network/i,
      /timeout/i,
      /rate limit/i,
      /unreachable/i,
    ],
    unblockAction: "Resolve the external dependency (credentials, install, connectivity), then resume the goal.",
  },
  {
    category: "policy",
    patterns: [/policy/i, /not allowed/i, /forbidden/i, /denied by rule/i, /blocked by policy/i],
    unblockAction: "Adjust the policy/permission rules or grant access, then resume the goal.",
  },
  {
    category: "tool_error",
    patterns: [/tool .*(failed|error)/i, /command failed/i, /exit code/i, /exception/i, /stack trace/i],
    unblockAction: "Investigate the tool/command error, fix the underlying cause, then resume the goal.",
  },
];

/**
 * Infer a structured blocked category and a concrete unblock action from a free
 * text blocked reason. Falls back to `unknown` with a generic action.
 */
export function inferBlockedCategory(reason: string | undefined): {
  category: GoalBlockedCategory;
  unblockAction: string;
} {
  const text = (reason ?? "").trim();
  if (text) {
    for (const rule of CATEGORY_RULES) {
      if (rule.patterns.some((p) => p.test(text))) {
        return { category: rule.category, unblockAction: rule.unblockAction };
      }
    }
  }
  return {
    category: "unknown",
    unblockAction: "Review the blocked reason and take the needed action, then resume the goal.",
  };
}

/**
 * Build (or update) the structured blocked state for a goal.
 *
 * When the new reason matches the previous blocked state's reason, the same
 * blocker is considered to have repeated: `repeatedCount` is incremented and the
 * original `firstBlockedAt` is preserved. Otherwise a fresh state starts at
 * count 1.
 */
export function buildBlockedState(
  reason: string | undefined,
  previous: GoalBlockedState | undefined,
  nowMs: number = Date.now()
): GoalBlockedState {
  const normalizedReason = (reason ?? "").trim().slice(0, 500) || "Blocked.";
  const { category, unblockAction } = inferBlockedCategory(normalizedReason);

  const sameBlocker =
    previous !== undefined &&
    previous.resolvedAt === undefined &&
    previous.reason === normalizedReason;

  return {
    reason: normalizedReason,
    category,
    unblockAction,
    repeatedCount: sameBlocker ? previous.repeatedCount + 1 : 1,
    firstBlockedAt: sameBlocker ? previous.firstBlockedAt : nowMs,
    lastBlockedAt: nowMs,
  };
}

/**
 * Whether a blocked state has repeated enough times that the runtime should stop
 * auto-retrying and surface the unblock action to the user instead.
 */
export function shouldStopRetrying(
  state: GoalBlockedState | undefined
): boolean {
  if (!state) return false;
  return state.repeatedCount >= BLOCKED_RETRY_THRESHOLD;
}

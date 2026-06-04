export type GoalStatus = "active" | "paused" | "complete" | "blocked";

/**
 * One auto-continuation turn of a long-running goal.
 *
 * NOTE (M1): turn records are persisted at the top level of the goal store
 * envelope (alongside `goal`), NOT nested inside `AgentGoal`, to avoid double
 * writes and drift. M1 only defines the shape; turn writing lands in M2.
 */
export interface GoalTurn {
  /** 1-based turn sequence number. */
  turnNumber: number;
  startedAt: number;
  endedAt?: number;
  status: "running" | "completed" | "failed" | "blocked";
  /** Tokens consumed in this turn (populated in M2). */
  tokenUsed?: number;
  /** Evidence ids produced during this turn. */
  evidenceIds?: string[];
  /** Short turn summary (truncated by the store). */
  summary?: string;
  /** Set when status is "blocked". */
  blockedReason?: string;
}

/**
 * A key artifact produced while pursuing a goal.
 *
 * The `kind` set mirrors {@link import("../progress/types").ProgressArtifact}
 * so progress artifacts can be bridged into goal evidence in M2 without a
 * second, divergent concept. `id` may correspond to a ProgressArtifact id.
 */
export interface GoalEvidence {
  id: string;
  kind:
    | "file"
    | "url"
    | "screenshot"
    | "test"
    | "diff"
    | "log"
    | "browser"
    | "other";
  title: string;
  /** Optional file path or URL. */
  href?: string;
  summary?: string;
  createdAt: number;
  /** Which turn produced this evidence, if known. */
  turnNumber?: number;
}

export type GoalBlockedCategory =
  | "needs_user"
  | "needs_approval"
  | "tool_error"
  | "external_dependency"
  | "policy"
  | "merge_conflict"
  | "unknown";

/**
 * Structured blocked context (M4). Captures why a goal is blocked, what the user
 * should do to unblock it, and how many times the same blocker has repeated so
 * the runtime can stop auto-retrying a goal that is stuck on the same wall.
 */
export interface GoalBlockedState {
  reason: string;
  category: GoalBlockedCategory;
  /** Concrete action the user can take to unblock the goal. */
  unblockAction: string;
  /** How many consecutive times this same blocker has been hit. */
  repeatedCount: number;
  firstBlockedAt: number;
  lastBlockedAt: number;
  context?: string;
  resolvedAt?: number;
}

/**
 * A single acceptance criterion. Reserved for the verifier (M3).
 */
export interface GoalAcceptanceCriterion {
  id: string;
  criterion: string;
  status: "pending" | "met" | "failed";
  verifiedAt?: number;
  evidence?: string;
}

export interface AgentGoal {
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  turns: number;
  blockedStreak: number;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  completedAt?: number;
  blockedReason?: string;
  pauseReason?: string;

  // M1 additions (optional, backward compatible). turn/evidence history is NOT
  // nested here — it lives at the top level of the persisted envelope.
  blockedState?: GoalBlockedState;
  acceptanceCriteria?: GoalAcceptanceCriterion[];
}

export interface GoalUpdatedEvent {
  type: "goal_updated";
  goal: AgentGoal | null;
}

export interface GoalUpdateInput {
  status: "complete" | "blocked";
  blockedReason?: string;
}

/**
 * Outcome of an onGoalUpdate call. When the model requests `complete` but the
 * stop-time verifier rejects it, `accepted` is false, the goal stays active, and
 * `rejectionNote` explains what is still missing so the model can continue.
 */
export interface GoalUpdateResult {
  goal: AgentGoal | null;
  accepted: boolean;
  rejectionNote?: string;
}

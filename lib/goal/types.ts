export type GoalStatus = "active" | "paused" | "complete" | "blocked";

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
}

export interface GoalUpdatedEvent {
  type: "goal_updated";
  goal: AgentGoal | null;
}

export interface GoalUpdateInput {
  status: "complete" | "blocked";
  blockedReason?: string;
}

import "server-only";
import type { AgentGoal, GoalStatus } from "./types";

const MAX_OBJECTIVE_CHARS = 4000;

interface GoalStore {
  goals: Map<string, AgentGoal>;
}

const g = globalThis as unknown as { __miniPiGoals?: GoalStore };
if (!g.__miniPiGoals) {
  g.__miniPiGoals = { goals: new Map() };
}
const store = g.__miniPiGoals;

function now() {
  return Date.now();
}

export function normalizeObjective(objective: unknown): string {
  if (typeof objective !== "string") return "";
  return objective.trim().slice(0, MAX_OBJECTIVE_CHARS);
}

export function getGoal(agentId: string): AgentGoal | null {
  return store.goals.get(agentId) ?? null;
}

export function setGoal(
  agentId: string,
  objective: string,
  tokenBudget?: number
): AgentGoal {
  const t = now();
  const goal: AgentGoal = {
    objective: normalizeObjective(objective),
    status: "active",
    tokenBudget:
      typeof tokenBudget === "number" && Number.isFinite(tokenBudget) && tokenBudget > 0
        ? tokenBudget
        : undefined,
    turns: 0,
    blockedStreak: 0,
    createdAt: t,
    updatedAt: t,
  };
  if (!goal.objective) throw new Error("goal objective required");
  store.goals.set(agentId, goal);
  return goal;
}

export function patchGoal(
  agentId: string,
  patch: Partial<Omit<AgentGoal, "createdAt" | "objective">> & {
    objective?: string;
  }
): AgentGoal | null {
  const current = store.goals.get(agentId);
  if (!current) return null;
  const next: AgentGoal = {
    ...current,
    ...patch,
    objective:
      patch.objective !== undefined
        ? normalizeObjective(patch.objective)
        : current.objective,
    updatedAt: now(),
  };
  if (!next.objective) throw new Error("goal objective required");
  store.goals.set(agentId, next);
  return next;
}

export function setGoalStatus(
  agentId: string,
  status: GoalStatus,
  details?: { blockedReason?: string; pauseReason?: string }
): AgentGoal | null {
  const current = store.goals.get(agentId);
  if (!current) return null;
  const t = now();
  const next: AgentGoal = {
    ...current,
    status,
    updatedAt: t,
    ...(status === "complete" ? { completedAt: t } : {}),
    ...(details?.blockedReason
      ? { blockedReason: details.blockedReason.slice(0, 500) }
      : {}),
    ...(details?.pauseReason
      ? { pauseReason: details.pauseReason.slice(0, 200) }
      : {}),
  };
  store.goals.set(agentId, next);
  return next;
}

export function clearGoal(agentId: string): null {
  store.goals.delete(agentId);
  return null;
}

export function noteGoalContinuation(agentId: string): AgentGoal | null {
  const current = store.goals.get(agentId);
  if (!current) return null;
  const next: AgentGoal = {
    ...current,
    turns: current.turns + 1,
    lastRunAt: now(),
    updatedAt: now(),
  };
  store.goals.set(agentId, next);
  return next;
}

export function __resetGoalStoreForTest(): void {
  store.goals.clear();
}

/**
 * RFC-2 Phase A: 会话级 Budget 评估 + 持久化。
 *
 * 这里只放纯函数和 localStorage helper，不依赖 React。
 * React 适配（useBudget hook）在 app/hooks/useBudget.ts。
 */

import {
  BUDGET_OVERRIDE_KEY_PREFIX,
  BUDGET_STORAGE_KEY,
  DEFAULT_BUDGET,
  type BudgetDimension,
  type BudgetSpent,
  type BudgetStatus,
  type SessionBudget,
} from "./types";

export * from "./types";

/**
 * 判断 budget 某个维度是否启用。
 * undefined / 0 / 负数 / NaN 都视为未启用。
 */
function isEnabled(v: number | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * 核心评估函数：根据当前 budget + spent 算出 status。
 *
 * 纯函数：相同入参永远得到相同结果，方便单测和 React memo。
 *
 * 关于负 remaining：
 *   超出后 remaining 用 budget - spent，可能是负数。UI 显示时应 clamp 到 [0, budget]。
 *   triggered 列表与 remaining 是否为负是一一对应的（防止两边判断不一致）。
 */
export function evaluateBudget(
  budget: SessionBudget,
  spent: BudgetSpent
): BudgetStatus {
  const remaining: BudgetStatus["remaining"] = {};
  const triggered: BudgetDimension[] = [];

  if (isEnabled(budget.maxCostUsd)) {
    const r = budget.maxCostUsd - spent.costUsd;
    remaining.costUsd = r;
    if (r <= 0) triggered.push("cost");
  }
  if (isEnabled(budget.maxTurns)) {
    const r = budget.maxTurns - spent.turns;
    remaining.turns = r;
    if (r <= 0) triggered.push("turns");
  }
  if (isEnabled(budget.maxDurationSec)) {
    const r = budget.maxDurationSec - spent.durationSec;
    remaining.durationSec = r;
    if (r <= 0) triggered.push("duration");
  }

  return { budget, spent, remaining, triggered };
}

/**
 * 把任意外部输入归一化为合法 SessionBudget。
 *
 * - 不认识的字段忽略
 * - 数字字段必须是有限正数才保留，否则置 undefined
 * - action 不合法时回退 'pause'
 *
 * 用于：从 localStorage 解析、从 settings UI 收集，统一过这个函数。
 */
export function normalizeBudget(raw: unknown): SessionBudget {
  const o = (raw ?? {}) as Record<string, unknown>;
  const pickPositive = (v: unknown): number | undefined => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const action: SessionBudget["action"] =
    o.action === "stop" ? "stop" : "pause";
  return {
    maxCostUsd: pickPositive(o.maxCostUsd),
    maxTurns: pickPositive(o.maxTurns),
    maxDurationSec: pickPositive(o.maxDurationSec),
    action,
  };
}

/** SSR 安全的 localStorage 访问。 */
function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 读全局默认 budget。
 * 读不到 / 解析失败 / 字段不合法 → 回退 DEFAULT_BUDGET。
 */
export function loadGlobalBudget(): SessionBudget {
  const s = safeStorage();
  if (!s) return DEFAULT_BUDGET;
  const raw = s.getItem(BUDGET_STORAGE_KEY);
  if (!raw) return DEFAULT_BUDGET;
  try {
    return normalizeBudget(JSON.parse(raw));
  } catch {
    return DEFAULT_BUDGET;
  }
}

/** 写全局默认 budget。 */
export function saveGlobalBudget(budget: SessionBudget): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(BUDGET_STORAGE_KEY, JSON.stringify(normalizeBudget(budget)));
  } catch {
    /* quota / 隐私模式等场景，静默忽略 */
  }
}

/**
 * 读单 session 的 override；不存在则返回 null。
 *
 * 与 global 的关系：上层逻辑应该 `loadSessionOverride(id) ?? loadGlobalBudget()`，
 * 确保 override 优先。
 */
export function loadSessionOverride(agentId: string): SessionBudget | null {
  const s = safeStorage();
  if (!s) return null;
  const raw = s.getItem(BUDGET_OVERRIDE_KEY_PREFIX + agentId);
  if (!raw) return null;
  try {
    return normalizeBudget(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 写单 session override。 */
export function saveSessionOverride(
  agentId: string,
  budget: SessionBudget
): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(
      BUDGET_OVERRIDE_KEY_PREFIX + agentId,
      JSON.stringify(normalizeBudget(budget))
    );
  } catch {
    /* ignore */
  }
}

/** 清除单 session override（回退到全局默认）。 */
export function clearSessionOverride(agentId: string): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.removeItem(BUDGET_OVERRIDE_KEY_PREFIX + agentId);
  } catch {
    /* ignore */
  }
}

/**
 * 一站式：拿到某 session 当前应用的 budget。
 * 优先级：session override > global > DEFAULT_BUDGET（已被 loadGlobalBudget 处理）。
 */
export function resolveBudget(agentId: string | null): SessionBudget {
  if (agentId) {
    const override = loadSessionOverride(agentId);
    if (override) return override;
  }
  return loadGlobalBudget();
}

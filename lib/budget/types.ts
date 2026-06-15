/**
 * RFC-2 Phase A: 会话级 Budget 类型定义。
 *
 * 设计意图：
 *   - diga-agent 当前只能 abort 全停 / 没有软上限 / 没有费用预警。
 *   - 这套类型描述「单 session 的资源上限」，命中后由前端 abort 并按 action 决定后续。
 *   - cost / turns / duration 三维独立可启用；任一命中即触发。
 *   - 不引入新依赖，纯数据 + 纯函数 + localStorage 持久化。
 *
 * 与 SDK 的关系：
 *   - 完全前端实现，不需要 SDK 改造（Phase B 才需要 inline extension）。
 *   - cost 来自 runner.stats.cost（已存在）；turns 来自 chatState.messages；
 *     duration 来自新增的 runStartedAt（runner 首次 streaming=true 时记一次）。
 */

/** 触发上限时的动作 */
export type BudgetAction = "pause" | "stop";

/**
 * 会话级 Budget 设置。
 *
 * - 字段为 undefined / 0 / 负数 视为「未启用该维度」。
 * - action 永远生效，决定命中时是弹窗（pause）还是直接停（stop）。
 */
export interface SessionBudget {
  /** 单 session 内最大花费（美元）。undefined / <=0 视为不限。 */
  maxCostUsd?: number;
  /** 单 session 内最大 user turn 数。undefined / <=0 视为不限。 */
  maxTurns?: number;
  /** 单 session 内最长时长（秒，从首次 streaming 起算）。undefined / <=0 视为不限。 */
  maxDurationSec?: number;
  /** 命中上限时的动作 */
  action: BudgetAction;
}

/**
 * 当前消耗快照——由 runner 状态聚合而来，不直接持久化。
 */
export interface BudgetSpent {
  costUsd: number;
  turns: number;
  durationSec: number;
}

/**
 * Budget 实时状态快照。
 *
 * triggered 数组列出**当前已超**的维度（可能多个同时超）。
 * 调用方据此决定是否 abort / 弹窗。
 */
export interface BudgetStatus {
  /** 当前生效的 budget（可能是 session override 或 global default） */
  budget: SessionBudget;
  spent: BudgetSpent;
  /**
   * 各维度剩余量。
   * 字段为 undefined 表示该维度未启用。
   * 字段为负数表示已超（同时会出现在 triggered 里）。
   */
  remaining: {
    costUsd?: number;
    turns?: number;
    durationSec?: number;
  };
  /** 已触发的上限种类（按维度排序：cost > turns > duration） */
  triggered: BudgetDimension[];
}

export type BudgetDimension = "cost" | "turns" | "duration";

/**
 * 默认的全局 budget。
 *
 * 修正（B1）：默认不限流。历史原因这里写过 $5 / 30 turns / 600s，
 * 但项目没有服务端持久化，localStorage 丢失后会被重置为默认限流，
 * 用户看起来就是“不能设”。现在默认全 undefined，action 仅决定命中后是否
 * 弹窗；是否启用限流交由用户在 settings 里明确选择。
 */
export const DEFAULT_BUDGET: SessionBudget = {
  maxCostUsd: undefined,
  maxTurns: undefined,
  maxDurationSec: undefined,
  action: "pause",
};

/** localStorage key：全局默认 budget */
export const BUDGET_STORAGE_KEY = "pi-budget";

/** localStorage key 前缀：单 session 覆盖 */
export const BUDGET_OVERRIDE_KEY_PREFIX = "pi-budget-override-";

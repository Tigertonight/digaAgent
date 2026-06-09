"use client";

/**
 * useBudget —— 会话级 Budget MVP（RFC-2 Phase A2）
 *
 * 职责：
 *   - 实时从当前 active runner 读取 spent（cost / turns / duration）
 *   - 解析当前生效的 SessionBudget（session override > global > DEFAULT）
 *   - 输出 BudgetStatus（含 remaining / triggered）供 UI 展示
 *   - 暴露 setBudget / clearOverride 修改入口（Settings 区块 & 单 session override）
 *
 * 不在本 hook 内的职责：
 *   - 命中阈值后的 abort + Modal 弹出 → Phase A3 单独 hook/组件 处理
 *   - 写入 runStartedAt → 已由 useAgentEvents 在 agent_start/agent_end 处理
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RunnerState } from "@/lib/session-runner";
import {
  DEFAULT_BUDGET,
  evaluateBudget,
  loadSessionOverride,
  resolveBudget,
  saveGlobalBudget,
  saveSessionOverride,
  clearSessionOverride,
} from "@/lib/budget";
import type {
  BudgetSpent,
  BudgetStatus,
  SessionBudget,
} from "@/lib/budget/types";

export interface UseBudgetOptions {
  /** 当前活跃 runner 的快照（由 useRunners 提供） */
  activeSnapshot: RunnerState;
  /** 当前活跃 agentId（用于 override key）；草稿态可能为 null */
  agentId: string | null;
  /**
   * 每 N ms 重算 duration（默认 1000）。
   * cost/turns 跟 snapshot 变化天然刷新，但 duration 需要 wall-clock tick。
   */
  durationTickMs?: number;
}

export interface UseBudgetReturn {
  /** 当前生效的 budget（已经过 resolveBudget 解析三层优先级） */
  budget: SessionBudget;
  /** 是否启用了 session override（非 null 即启用） */
  hasOverride: boolean;
  /** 实时消耗 + remaining + triggered */
  status: BudgetStatus;
  /** 当前消耗（裸值，方便外部展示） */
  spent: BudgetSpent;

  /** 写全局默认（settings 区块用） */
  setGlobalBudget: (b: SessionBudget) => void;
  /** 写当前 session override（要求 agentId 非空） */
  setSessionOverride: (b: SessionBudget) => void;
  /** 清当前 session override，回退到全局 */
  clearCurrentOverride: () => void;
}

/**
 * 从 RunnerState 抽取 BudgetSpent。
 * - cost：runner.stats.cost ?? 0
 * - turns：chatState.messages 里 role === 'user' 的条数
 * - duration：streaming 中按 (now - runStartedAt) 计；非 streaming 视为 0（本轮结束）
 */
function computeSpent(snapshot: RunnerState, now: number): BudgetSpent {
  const costUsd = snapshot.stats?.cost ?? 0;
  const turns = snapshot.chatState.messages.filter(
    (m) => m.role === "user"
  ).length;
  const durationSec =
    snapshot.runStartedAt != null
      ? Math.max(0, Math.floor((now - snapshot.runStartedAt) / 1000))
      : 0;
  return { costUsd, turns, durationSec };
}

export function useBudget(opts: UseBudgetOptions): UseBudgetReturn {
  const { activeSnapshot, agentId, durationTickMs = 1000 } = opts;

  // budget 配置：mount + 每次 agentId 切换 重新解析；
  // setter 内手动 trigger 一次 reload 来推动 UI。
  const [budgetVersion, setBudgetVersion] = useState(0);
  const [budget, setBudgetState] = useState<SessionBudget>(DEFAULT_BUDGET);
  const [hasOverride, setHasOverride] = useState(false);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setBudgetState(resolveBudget(agentId));
      setHasOverride(agentId ? loadSessionOverride(agentId) != null : false);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, budgetVersion]);

  // duration tick：仅 streaming 中才订阅 setInterval，省 CPU。
  // 非 streaming 时 runStartedAt === null，computeSpent 直接返回 0，不依赖 tickNow，
  // 因此不需要在 streaming 切换时同步 setTickNow（避免 set-state-in-effect 警告）。
  const [tickNow, setTickNow] = useState<number>(() => Date.now());
  const isStreaming = activeSnapshot.streaming;
  useEffect(() => {
    if (!isStreaming) return;
    const t = setInterval(() => setTickNow(Date.now()), durationTickMs);
    return () => clearInterval(t);
  }, [isStreaming, durationTickMs]);

  const spent = useMemo<BudgetSpent>(
    () => computeSpent(activeSnapshot, tickNow),
    [activeSnapshot, tickNow]
  );

  const status = useMemo<BudgetStatus>(
    () => evaluateBudget(budget, spent),
    [budget, spent]
  );

  const setGlobalBudget = useCallback((b: SessionBudget) => {
    saveGlobalBudget(b);
    setBudgetVersion((v) => v + 1);
  }, []);

  const setSessionOverride = useCallback(
    (b: SessionBudget) => {
      if (!agentId) return;
      saveSessionOverride(agentId, b);
      setBudgetVersion((v) => v + 1);
    },
    [agentId]
  );

  const clearCurrentOverride = useCallback(() => {
    if (!agentId) return;
    clearSessionOverride(agentId);
    setBudgetVersion((v) => v + 1);
  }, [agentId]);

  return {
    budget,
    hasOverride,
    status,
    spent,
    setGlobalBudget,
    setSessionOverride,
    clearCurrentOverride,
  };
}

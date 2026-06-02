"use client";

/**
 * useBudgetEnforcer —— Budget 触发后执行 abort/pause（RFC-2 Phase A3）
 *
 * 职责：
 *   - 监听 BudgetStatus.triggered 从空 → 非空 的"跃迁"
 *   - 仅在 streaming 中触发（避免对已结束的会话回放出 modal）
 *   - action='stop' → 立即 onAbort()
 *   - action='pause' → 调 setPausedFor(reason) 让外部弹 Modal；同时 onAbort()
 *     （pause 语义也是"先停下，弹窗等用户决定是否继续"）
 *
 * 设计要点：
 *   - 每个 agentId 只触发一次：用 ref 记录"已为该 agent 触发过"
 *   - agentId 变化 / 重新开始 streaming（runStartedAt 变化）会重置触发记录
 *   - 不在 hook 内做"继续/终止"动作，全交给外部 Modal 处理
 */

import { useEffect, useRef } from "react";
import type { BudgetStatus, BudgetDimension, SessionBudget } from "@/lib/budget/types";

export interface BudgetTrigger {
  /** 哪个 agent 命中 */
  agentId: string;
  /** 命中的维度（cost/turns/duration，可能多个） */
  triggered: BudgetDimension[];
  /** 当时的 budget 快照（含 action） */
  budget: SessionBudget;
  /** 命中时间 */
  at: number;
}

export interface UseBudgetEnforcerOptions {
  agentId: string | null;
  streaming: boolean;
  /** 本轮起始时间戳，用于"新一轮 run"重置已触发标记 */
  runStartedAt: number | null;
  status: BudgetStatus;
  budget: SessionBudget;
  /** action=stop 或 pause 都会调；外部统一调 fetch abort */
  onAbort: () => void | Promise<void>;
  /** action=pause 时调，传入触发详情，外部据此弹 Modal */
  onPause: (trigger: BudgetTrigger) => void;
}

export function useBudgetEnforcer(opts: UseBudgetEnforcerOptions): void {
  const {
    agentId,
    streaming,
    runStartedAt,
    status,
    budget,
    onAbort,
    onPause,
  } = opts;

  // 已对哪个 (agentId, runStartedAt) 触发过；避免同一轮反复 abort
  const firedKeyRef = useRef<string | null>(null);

  // 用 ref 拿最新 callbacks，避免 effect 因身份变化误重跑
  const onAbortRef = useRef(onAbort);
  const onPauseRef = useRef(onPause);
  useEffect(() => {
    onAbortRef.current = onAbort;
  }, [onAbort]);
  useEffect(() => {
    onPauseRef.current = onPause;
  }, [onPause]);

  useEffect(() => {
    // 没在跑 / 没 agentId / 没触发 → 直接 noop
    if (!streaming) return;
    if (!agentId) return;
    if (status.triggered.length === 0) return;

    // 本轮 run 的唯一 key
    const runKey = `${agentId}::${runStartedAt ?? "no-run"}`;
    if (firedKeyRef.current === runKey) return;
    firedKeyRef.current = runKey;

    const trigger: BudgetTrigger = {
      agentId,
      triggered: [...status.triggered],
      budget,
      at: Date.now(),
    };

    // 不论 stop / pause，都先 abort 把当前 turn 停下
    void onAbortRef.current();

    if (budget.action === "pause") {
      onPauseRef.current(trigger);
    }
    // action='stop' 时不弹窗，仅记日志（可由调用方在 onAbort 内自己 toast）
  }, [streaming, agentId, runStartedAt, status.triggered, budget]);

  // 当本轮 run 结束（streaming false 或 runStartedAt 清空）时，清掉触发记录
  // 这样用户手动继续后下一轮 run 还能再次触发
  useEffect(() => {
    if (!streaming || runStartedAt == null) {
      firedKeyRef.current = null;
    }
  }, [streaming, runStartedAt]);
}

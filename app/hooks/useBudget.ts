"use client";

/**
 * useBudget —— 会话级 Budget MVP（RFC-2 Phase A2 / B2 持久化重构）
 *
 * 职责：
 *   - async 从 /api/budget-settings 加载当前生效的 global budget；写入也走 PATCH。
 *   - session override 仍走 localStorage（临时、会话级，不打扰服务端）。
 *   - 一次性 migration：如果 localStorage 里有旧 pi-budget 而服务端还没设置过 budget，
 *     把它 PATCH 上去再删本地（避免重启后回到 $5/30/600s）。
 *   - 实时从 active runner 读 spent；evaluateBudget 算 status。
 *
 * 不在本 hook 内：
 *   - 命中阈值的 abort + Modal → useBudgetEnforcer / BudgetExceededModal。
 *   - "提高上限并继续" 后的 resume 续发逻辑 → ChatApp。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunnerState } from "@/lib/session-runner";
import {
  DEFAULT_BUDGET,
  evaluateBudget,
  loadSessionOverride,
  normalizeBudget,
  saveSessionOverride,
  clearSessionOverride,
} from "@/lib/budget";
import {
  BUDGET_STORAGE_KEY,
} from "@/lib/budget/types";
import type {
  BudgetSpent,
  BudgetStatus,
  SessionBudget,
} from "@/lib/budget/types";

export interface UseBudgetOptions {
  activeSnapshot: RunnerState;
  agentId: string | null;
  durationTickMs?: number;
}

export interface UseBudgetReturn {
  budget: SessionBudget;
  hasOverride: boolean;
  status: BudgetStatus;
  spent: BudgetSpent;

  /**
   * 写全局默认（持久化到服务端 settings.json）。
   * async 完成后 hook 自身的 budget state 会被刷新。
   */
  setGlobalBudget: (b: SessionBudget) => Promise<void>;
  setSessionOverride: (b: SessionBudget) => void;
  clearCurrentOverride: () => void;
}

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

/**
 * 一次性把 localStorage 里的旧 pi-budget migrate 到服务端。
 * 只在第一次加载、且服务端 budget 还是 DEFAULT 时跑；跑完不管成败都清掉本地 key。
 */
async function migrateLegacyLocalBudget(
  serverBudget: SessionBudget
): Promise<SessionBudget> {
  if (typeof window === "undefined") return serverBudget;
  const raw = window.localStorage.getItem(BUDGET_STORAGE_KEY);
  if (!raw) return serverBudget;
  // 服务端已有非默认 budget → 不覆盖（信任服务端）。
  const serverIsDefault =
    serverBudget.maxCostUsd === undefined &&
    serverBudget.maxTurns === undefined &&
    serverBudget.maxDurationSec === undefined;
  try {
    if (serverIsDefault) {
      const legacy = normalizeBudget(JSON.parse(raw));
      const r = await fetch("/api/budget-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budget: legacy }),
      });
      if (r.ok) {
        const d = (await r.json()) as { budget?: SessionBudget };
        window.localStorage.removeItem(BUDGET_STORAGE_KEY);
        if (d.budget) return normalizeBudget(d.budget);
      }
    } else {
      // 服务端已有，把本地 legacy 删了避免下次再 migrate
      window.localStorage.removeItem(BUDGET_STORAGE_KEY);
    }
  } catch {
    // migration best-effort
  }
  return serverBudget;
}

export function useBudget(opts: UseBudgetOptions): UseBudgetReturn {
  const { activeSnapshot, agentId, durationTickMs = 1000 } = opts;

  const [globalBudget, setGlobalBudgetState] =
    useState<SessionBudget>(DEFAULT_BUDGET);
  const [override, setOverrideState] = useState<SessionBudget | null>(null);
  const [budgetVersion, setBudgetVersion] = useState(0);
  const migratedRef = useRef(false);

  // 加载持久化全局 budget（async）。每次 budgetVersion + agentId 变化重新拉。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/budget-settings", { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { budget?: SessionBudget };
        if (cancelled || !d.budget) return;
        let next = normalizeBudget(d.budget);
        if (!migratedRef.current) {
          migratedRef.current = true;
          next = await migrateLegacyLocalBudget(next);
          if (cancelled) return;
        }
        setGlobalBudgetState(next);
      } catch {
        // 服务端不可达时退回 DEFAULT_BUDGET（不限流）。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [budgetVersion]);

  // session override 仍走 localStorage，agent 切换或显式写入时刷新。
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setOverrideState(agentId ? loadSessionOverride(agentId) : null);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, budgetVersion]);

  const budget = useMemo<SessionBudget>(
    () => override ?? globalBudget,
    [override, globalBudget]
  );
  const hasOverride = override != null;

  // duration tick：仅 streaming 中订阅。
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

  const setGlobalBudget = useCallback(async (b: SessionBudget) => {
    try {
      const r = await fetch("/api/budget-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budget: b }),
      });
      if (r.ok) {
        const d = (await r.json()) as { budget?: SessionBudget };
        if (d.budget) setGlobalBudgetState(normalizeBudget(d.budget));
      }
    } catch {
      // 服务端不可达时不报错；下一次成功 PATCH 就会同步。
    }
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

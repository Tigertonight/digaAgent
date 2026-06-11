"use client";

/**
 * BudgetSettingsSectionInner —— Budget 设置区的纯 CSR 实现（RFC-2 Phase A4）
 *
 * 设计：
 *   - 仅通过 next/dynamic({ ssr: false }) 加载，因此 useState lazy init 时
 *     window/localStorage 一定可用 ——> 不再需要 useEffect 做 mount 后同步，
 *     从而避免 react-hooks/set-state-in-effect 警告（91 warnings 持平偏好）。
 *   - 三维度均可独立启用 / 禁用（开关 + 数值）；action 单选 pause/stop。
 *   - 没有 Save 按钮：每次合法变更立刻 saveGlobalBudget。
 */

import { useCallback, useState } from "react";
import {
  DEFAULT_BUDGET,
  loadGlobalBudget,
  saveGlobalBudget,
} from "@/lib/budget";
import type { SessionBudget } from "@/lib/budget/types";
import { FieldInput } from "@/app/components/DesignPrimitives";

interface DimState {
  enabled: boolean;
  value: string; // input 用 string 持有，便于校验
}

function toDimState(v: number | undefined, fallback: number): DimState {
  if (v == null || v <= 0 || Number.isNaN(v)) {
    return { enabled: false, value: String(fallback) };
  }
  return { enabled: true, value: String(v) };
}

function fromDimState(s: DimState): number | undefined {
  if (!s.enabled) return undefined;
  const n = Number(s.value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

export default function BudgetSettingsSectionInner() {
  // 这是纯 CSR 组件（ssr: false 包装），lazy init 时直接读 localStorage。
  const [cost, setCost] = useState<DimState>(() => {
    const b = loadGlobalBudget();
    return toDimState(b.maxCostUsd, DEFAULT_BUDGET.maxCostUsd ?? 5);
  });
  const [turns, setTurns] = useState<DimState>(() => {
    const b = loadGlobalBudget();
    return toDimState(b.maxTurns, DEFAULT_BUDGET.maxTurns ?? 30);
  });
  const [dur, setDur] = useState<DimState>(() => {
    const b = loadGlobalBudget();
    return toDimState(b.maxDurationSec, DEFAULT_BUDGET.maxDurationSec ?? 600);
  });
  const [action, setAction] = useState<"pause" | "stop">(() => {
    const b = loadGlobalBudget();
    return b.action ?? "pause";
  });

  const persist = useCallback(
    (next: Partial<{ c: DimState; t: DimState; d: DimState; a: "pause" | "stop" }>) => {
      const c = next.c ?? cost;
      const t = next.t ?? turns;
      const d = next.d ?? dur;
      const a = next.a ?? action;
      const budget: SessionBudget = {
        maxCostUsd: fromDimState(c),
        maxTurns: fromDimState(t),
        maxDurationSec: fromDimState(d),
        action: a,
      };
      saveGlobalBudget(budget);
    },
    [cost, turns, dur, action]
  );

  return (
    <section className="mb-6 rounded-token border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
      <h2 className="mb-1 text-token-body font-semibold">任务用量保护</h2>
      <p className="mb-4 text-token-sm text-[color:var(--text-muted)]">
        防止单次任务消耗过多时间或费用。达到任一启用上限后，会按你的选择暂停或停止。
      </p>

      <div className="flex flex-col gap-3 text-token-body">
        {/* Cost */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 w-32">
            <input
              type="checkbox"
              checked={cost.enabled}
              onChange={(e) => {
                const next = { ...cost, enabled: e.target.checked };
                setCost(next);
                persist({ c: next });
              }}
            />
            <span>最高费用</span>
          </label>
          <FieldInput
            type="number"
            min={0}
            step={0.1}
            value={cost.value}
            disabled={!cost.enabled}
            onChange={(e) => {
              const next = { ...cost, value: e.target.value };
              setCost(next);
              persist({ c: next });
            }}
            className="w-32 font-mono disabled:opacity-50"
          />
          <span className="text-token-sm text-[color:var(--text-muted)]">美元</span>
        </div>

        {/* Turns */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 w-32">
            <input
              type="checkbox"
              checked={turns.enabled}
              onChange={(e) => {
                const next = { ...turns, enabled: e.target.checked };
                setTurns(next);
                persist({ t: next });
              }}
            />
            <span>最多轮数</span>
          </label>
          <FieldInput
            type="number"
            min={0}
            step={1}
            value={turns.value}
            disabled={!turns.enabled}
            onChange={(e) => {
              const next = { ...turns, value: e.target.value };
              setTurns(next);
              persist({ t: next });
            }}
            className="w-32 font-mono disabled:opacity-50"
          />
          <span className="text-token-sm text-[color:var(--text-muted)]">轮</span>
        </div>

        {/* Duration */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 w-32">
            <input
              type="checkbox"
              checked={dur.enabled}
              onChange={(e) => {
                const next = { ...dur, enabled: e.target.checked };
                setDur(next);
                persist({ d: next });
              }}
            />
            <span>最长时间</span>
          </label>
          <FieldInput
            type="number"
            min={0}
            step={10}
            value={dur.value}
            disabled={!dur.enabled}
            onChange={(e) => {
              const next = { ...dur, value: e.target.value };
              setDur(next);
              persist({ d: next });
            }}
            className="w-32 font-mono disabled:opacity-50"
          />
          <span className="text-token-sm text-[color:var(--text-muted)]">秒</span>
        </div>

        {/* Action */}
        <div className="mt-2 flex items-center gap-3 border-t border-[color:var(--border-soft)] pt-2">
          <span className="w-32">达到上限后</span>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="budget-action"
              checked={action === "pause"}
              onChange={() => {
                setAction("pause");
                persist({ a: "pause" });
              }}
            />
            <span>暂停并询问我</span>
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="budget-action"
              checked={action === "stop"}
              onChange={() => {
                setAction("stop");
                persist({ a: "stop" });
              }}
            />
            <span>直接停止任务</span>
          </label>
        </div>
      </div>
    </section>
  );
}

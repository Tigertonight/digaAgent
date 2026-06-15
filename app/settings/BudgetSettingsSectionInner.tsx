"use client";

/**
 * BudgetSettingsSectionInner —— Budget 设置区的纯 CSR 实现（B2 持久化重构）
 *
 * 设计变更：不再读写 localStorage。改成 GET /api/budget-settings 加载、
 * PATCH 写入。重启 / 升级 / 切 origin / 清浏览器缓存都不会丢。
 *
 * 默认 DEFAULT_BUDGET 三维全 undefined（不限流），三个开关默认全关。
 */

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_BUDGET, normalizeBudget } from "@/lib/budget";
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

async function loadBudgetFromServer(): Promise<SessionBudget> {
  try {
    const r = await fetch("/api/budget-settings", { cache: "no-store" });
    if (!r.ok) return DEFAULT_BUDGET;
    const d = (await r.json()) as { budget?: SessionBudget };
    return d.budget ? normalizeBudget(d.budget) : DEFAULT_BUDGET;
  } catch {
    return DEFAULT_BUDGET;
  }
}

async function saveBudgetToServer(budget: SessionBudget): Promise<void> {
  try {
    await fetch("/api/budget-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budget }),
    });
  } catch {
    // best-effort；下一次成功就会同步
  }
}

export default function BudgetSettingsSectionInner() {
  // 默认三维都关（不限流）。展示时仍给 input 一个友好的 placeholder 数值。
  const [cost, setCost] = useState<DimState>({ enabled: false, value: "5" });
  const [turns, setTurns] = useState<DimState>({ enabled: false, value: "30" });
  const [dur, setDur] = useState<DimState>({ enabled: false, value: "600" });
  const [action, setAction] = useState<"pause" | "stop">("pause");

  // mount 时拉服务端值。空 deps：ssr:false 包装 + 单次加载。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const b = await loadBudgetFromServer();
      if (cancelled) return;
      setCost(toDimState(b.maxCostUsd, 5));
      setTurns(toDimState(b.maxTurns, 30));
      setDur(toDimState(b.maxDurationSec, 600));
      setAction(b.action ?? "pause");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      void saveBudgetToServer(budget);
    },
    [cost, turns, dur, action]
  );

  return (
    <section className="mb-6 rounded-token border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
      <h2 className="mb-1 text-token-body font-semibold">任务用量保护</h2>
      <p className="mb-4 text-token-sm text-[color:var(--text-muted)]">
        默认不限流；任意启用一项后，达到上限会按下方策略处理。设置存到本机
        {" "}<code>~/.diga-agent/settings.json</code>，重启不丢。
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
            <span>询问我是否提高上限</span>
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

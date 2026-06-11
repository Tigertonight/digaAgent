"use client";

/**
 * BudgetIndicator —— 顶栏 Budget HUD（RFC-2 Phase A2）
 *
 * 设计：
 *   - 紧凑形态：紧贴 HudMeter，仅显示"最紧绷维度"的进度条 + 百分比文字
 *   - hover tooltip：展开三维详情（cost / turns / duration）+ 是否启用 override
 *   - 三段染色：>=100% 红 / >=85% 黄 / 其它 accent
 *   - 未启用任何维度 → 不渲染，避免顶栏噪声
 */

import { useMemo, useState } from "react";
import type { BudgetSpent, BudgetStatus, SessionBudget } from "@/lib/budget/types";

interface Dim {
  key: "cost" | "turns" | "duration";
  label: string;
  /** 0~1+；可能 > 1 表示已超额 */
  ratio: number | null;
  /** "$3.20 / $5.00" 这类 human-readable */
  display: string;
  triggered: boolean;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

function formatCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function buildDims(budget: SessionBudget, spent: BudgetSpent, status: BudgetStatus): Dim[] {
  const out: Dim[] = [];

  if (budget.maxCostUsd && budget.maxCostUsd > 0) {
    out.push({
      key: "cost",
      label: "Cost",
      ratio: spent.costUsd / budget.maxCostUsd,
      display: `${formatCost(spent.costUsd)} / ${formatCost(budget.maxCostUsd)}`,
      triggered: status.triggered.includes("cost"),
    });
  }
  if (budget.maxTurns && budget.maxTurns > 0) {
    out.push({
      key: "turns",
      label: "Turns",
      ratio: spent.turns / budget.maxTurns,
      display: `${spent.turns} / ${budget.maxTurns}`,
      triggered: status.triggered.includes("turns"),
    });
  }
  if (budget.maxDurationSec && budget.maxDurationSec > 0) {
    out.push({
      key: "duration",
      label: "Duration",
      ratio: spent.durationSec / budget.maxDurationSec,
      display: `${formatDuration(spent.durationSec)} / ${formatDuration(budget.maxDurationSec)}`,
      triggered: status.triggered.includes("duration"),
    });
  }

  return out;
}

function ratioColor(ratio: number): string {
  if (ratio >= 1) return "var(--color-danger)";
  if (ratio >= 0.85) return "var(--color-warning)";
  return "var(--accent)";
}

export interface BudgetIndicatorProps {
  budget: SessionBudget;
  spent: BudgetSpent;
  status: BudgetStatus;
  hasOverride: boolean;
}

export function BudgetIndicator({
  budget,
  spent,
  status,
  hasOverride,
}: BudgetIndicatorProps) {
  const [open, setOpen] = useState(false);

  const dims = useMemo(
    () => buildDims(budget, spent, status),
    [budget, spent, status]
  );

  // 一个维度都没启用 → 不渲染
  if (dims.length === 0) return null;

  // 找最紧绷的维度（ratio 最大）作为紧凑形态展示锚
  const peak = dims.reduce((a, b) => {
    const ar = a.ratio ?? 0;
    const br = b.ratio ?? 0;
    return br > ar ? b : a;
  });
  const peakRatio = peak.ratio ?? 0;
  const peakColor = ratioColor(peakRatio);
  const peakPct = Math.min(999, Math.round(peakRatio * 100));

  return (
    <span
      className="relative inline-flex items-center gap-1.5 px-1 shrink-0"
      style={{ color: "var(--text-muted)" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      aria-label={`Budget ${peak.label} ${peakPct}%`}
    >
      <span className="text-token-xs">⏱</span>
      <span
        className="inline-block rounded-full overflow-hidden"
        style={{ width: 28, height: 3, background: "var(--bg-hover)" }}
        aria-hidden="true"
      >
        <span
          className="block h-full"
          style={{
            width: `${Math.min(100, peakRatio * 100).toFixed(1)}%`,
            background: peakColor,
          }}
        />
      </span>
      <span style={{ color: peakColor, fontVariantNumeric: "tabular-nums" }}>
        {peakPct}%
      </span>
      {hasOverride && (
        <span
          className="rounded-token-xs px-1 text-token-xs"
          style={{
            background: "var(--bg-hover)",
            color: "var(--text-muted)",
          }}
          title="本会话使用了独立 Budget"
        >
          ●
        </span>
      )}

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-1.5 whitespace-nowrap rounded-token shadow-popover text-token-xs"
          style={{
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            color: "var(--text)",
            padding: "8px 10px",
            minWidth: 220,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <div
            className="mb-1.5 font-medium"
            style={{ color: "var(--text-muted)" }}
          >
            Budget · action={budget.action}
            {hasOverride && (
              <span style={{ marginLeft: 6, color: "var(--accent)" }}>
                (override)
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-x-3 gap-y-1">
            {dims.map((d) => (
              <div key={d.key} className="col-span-3 grid grid-cols-3 gap-x-3">
                <span style={{ color: "var(--text-muted)" }}>{d.label}</span>
                <span className="col-span-2 text-right">
                  <span style={{ color: ratioColor(d.ratio ?? 0) }}>
                    {d.display}
                  </span>
                  {d.triggered && (
                    <span style={{ marginLeft: 6, color: "var(--color-danger)" }}>!</span>
                  )}
                </span>
              </div>
            ))}
          </div>
          {status.triggered.length > 0 && (
            <div
              className="mt-2 pt-1.5"
              style={{
                borderTop: "1px solid var(--border)",
                color: "var(--color-danger)",
              }}
            >
              已触发：{status.triggered.join(", ")}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

"use client";

/**
 * HudMeter —— 顶栏 token / cost / context HUD。
 * RFC-1 阶段 C4：从 ChatApp.tsx 抽出，纯展示组件。
 *
 * 设计要点：
 *   - hover 时显示完整数字 tooltip（fixed 浮层，避开原生 title 的 1s 延迟）
 *   - ctxPct 三段染色：>85% 红 / >70% 黄 / 其它 accent
 *   - useState 自管 open；父组件只传 stats
 */

import { useState } from "react";
import { formatTokens } from "@/lib/format";

export interface HudMeterStats {
  input: number;
  output: number;
  cacheRead: number;
  total: number;
  cost: number;
  ctxTokens: number | null;
  ctxPct: number | null;
  ctxWindow: number | null;
}

export function HudMeter({ stats }: { stats: HudMeterStats }) {
  const [open, setOpen] = useState(false);
  const ctxColor =
    stats.ctxPct == null
      ? "var(--accent)"
      : stats.ctxPct > 0.85
      ? "var(--color-danger)"
      : stats.ctxPct > 0.7
      ? "var(--color-warning)"
      : "var(--accent)";
  return (
    <span
      className="relative inline-flex items-center gap-2 px-1 shrink-0"
      style={{ color: "var(--text-muted)" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span>↑{formatTokens(stats.input)}</span>
      <span>↓{formatTokens(stats.output)}</span>
      {stats.cost > 0 && (
        <span>
          {stats.cost < 0.01 ? "<$0.01" : `$${stats.cost.toFixed(2)}`}
        </span>
      )}
      {stats.ctxPct != null && (
        <span
          className="inline-block rounded-full overflow-hidden"
          style={{ width: 28, height: 3, background: "var(--bg-hover)" }}
          aria-hidden="true"
        >
          <span
            className="block h-full"
            style={{
              width: `${Math.min(100, stats.ctxPct * 100).toFixed(1)}%`,
              background: ctxColor,
            }}
          />
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
            minWidth: 200,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span style={{ color: "var(--text-muted)" }}>Input</span>
            <span className="text-right">{stats.input.toLocaleString()}</span>
            <span style={{ color: "var(--text-muted)" }}>Output</span>
            <span className="text-right">{stats.output.toLocaleString()}</span>
            <span style={{ color: "var(--text-muted)" }}>Cache read</span>
            <span className="text-right">
              {stats.cacheRead.toLocaleString()}
            </span>
            <span style={{ color: "var(--text-muted)" }}>Total</span>
            <span className="text-right">{stats.total.toLocaleString()}</span>
            {stats.cost > 0 && (
              <>
                <span style={{ color: "var(--text-muted)" }}>Cost</span>
                <span className="text-right">
                  ${stats.cost.toFixed(4)}
                </span>
              </>
            )}
            {stats.ctxTokens != null && stats.ctxWindow != null && (
              <>
                <span
                  className="col-span-2 mt-1 pt-1"
                  style={{ borderTop: "1px solid var(--border-soft)" }}
                />
                <span style={{ color: "var(--text-muted)" }}>Context</span>
                <span className="text-right" style={{ color: ctxColor }}>
                  {stats.ctxPct != null
                    ? `${(stats.ctxPct * 100).toFixed(1)}%`
                    : "—"}
                </span>
                <span style={{ color: "var(--text-muted)" }}>Used</span>
                <span className="text-right">
                  {stats.ctxTokens.toLocaleString()}
                </span>
                <span style={{ color: "var(--text-muted)" }}>Window</span>
                <span className="text-right">
                  {stats.ctxWindow.toLocaleString()}
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

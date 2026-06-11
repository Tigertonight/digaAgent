"use client";

/**
 * BudgetExceededModal —— Budget 命中后的暂停弹窗（RFC-2 Phase A3）
 *
 * 设计：
 *   - 受控：父组件管 open 状态（通过传 null/非 null trigger 控制）
 *   - 内容：哪些维度命中 + 当前数值 + 两个操作
 *     · 关闭：单纯关闭弹窗（已 abort，会话已停）
 *     · 提高上限并继续：把当前 budget 各维度 × 2 写入 session override
 *       并把回调交给父级（父级负责重新发起 / 续传 —— 本 Modal 不涉及）
 *
 * 不在本组件内：
 *   - 实际 abort 已经由 useBudgetEnforcer 在弹出 Modal 之前做掉
 *   - "继续" 后的续发逻辑：本 Modal 只暴露 onRaiseAndContinue 回调
 */

import type { BudgetTrigger } from "@/app/hooks/useBudgetEnforcer";
import type { BudgetDimension } from "@/lib/budget/types";

function dimLabel(d: BudgetDimension): string {
  if (d === "cost") return "Cost";
  if (d === "turns") return "Turns";
  return "Duration";
}

export interface BudgetExceededModalProps {
  /** null = 关闭；非 null = 打开并展示该 trigger */
  trigger: BudgetTrigger | null;
  onClose: () => void;
  /**
   * 用户点"提高上限并继续"。父级负责：
   *   - 把当前 budget 各维度 × 2 写入 session override
   *   - 决定是否要重新触发一次 send（Phase A 暂不自动续发，仅放开上限）
   */
  onRaiseAndContinue: (trigger: BudgetTrigger) => void;
}

export function BudgetExceededModal({
  trigger,
  onClose,
  onRaiseAndContinue,
}: BudgetExceededModalProps) {
  if (!trigger) return null;
  const { triggered, budget } = trigger;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md w-full max-w-md flex flex-col"
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          color: "var(--fg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="px-4 py-2.5 border-b"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <h2 className="text-token-body font-semibold" style={{ color: "var(--color-danger)" }}>
            Budget 已触发，会话已暂停
          </h2>
        </div>

        <div className="px-4 py-3 text-token-ui leading-relaxed">
          <p style={{ color: "var(--text-muted)" }}>
            本会话命中了以下 Budget 维度，已自动 abort：
          </p>
          <ul className="mt-2 ml-3 list-disc">
            {triggered.map((d) => (
              <li key={d}>
                <strong>{dimLabel(d)}</strong>
                <span style={{ color: "var(--text-muted)" }}>
                  {d === "cost" &&
                    budget.maxCostUsd != null &&
                    ` ≥ $${budget.maxCostUsd}`}
                  {d === "turns" &&
                    budget.maxTurns != null &&
                    ` ≥ ${budget.maxTurns} 轮`}
                  {d === "duration" &&
                    budget.maxDurationSec != null &&
                    ` ≥ ${budget.maxDurationSec}s`}
                </span>
              </li>
            ))}
          </ul>
          <p
            className="mt-3 text-token-sm"
            style={{ color: "var(--text-muted)" }}
          >
            选择「提高上限并继续」会把当前 Budget 各维度 × 2 写入本会话的临时 override，
            再次发送时生效；选择「关闭」则保持暂停，可在右上角 ⏱ 处查看消耗。
          </p>
        </div>

        <div
          className="flex items-center justify-end gap-2 px-4 py-2.5 border-t"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border hover:opacity-80"
            style={{ borderColor: "var(--border)" }}
          >
            关闭
          </button>
          <button
            type="button"
            onClick={() => onRaiseAndContinue(trigger)}
            className="px-3 py-1.5 text-xs rounded hover:opacity-80"
            style={{
              background: "var(--accent)",
              color: "var(--bg-panel)",
              fontWeight: 500,
            }}
          >
            提高上限并继续
          </button>
        </div>
      </div>
    </div>
  );
}

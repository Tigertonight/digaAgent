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
   * B4：用户点“提高上限并恢复”。父级负责：
   *   - 把当前 budget 各维度 × 2 写入 session override
   *   - 主动 goal_resume 及发一条“请继续” prompt，避免“点了但卡住”体感。
   * 返回 Promise，modal 不需要等 — 只是选择接受 async handler。
   */
  onRaiseAndContinue: (trigger: BudgetTrigger) => void | Promise<void>;
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
            预算已触发，本轮任务已中止
          </h2>
        </div>

        <div className="px-4 py-3 text-token-ui leading-relaxed">
          <p style={{ color: "var(--text-muted)" }}>
            本会话命中了以下预算维度，上一轮任务已中止：
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
            点「提高上限并恢复」会把当前预算各维度 × 2 写入本会话临时 override，
            随后主动发一条「请继续」让 agent 真接上轮任务跑；点「停止」则保持中止，
            可在右上角 ⏱ 查看消耗。
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
            停止
          </button>
          <button
            type="button"
            onClick={() => void onRaiseAndContinue(trigger)}
            className="px-3 py-1.5 text-xs rounded hover:opacity-80"
            style={{
              background: "var(--accent)",
              color: "var(--bg-panel)",
              fontWeight: 500,
            }}
          >
            提高上限并恢复
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";

/**
 * ModeChip —— 结构化 Composer 第一版：mode tag。
 *
 * 当用户在空输入框输入 "/goal " 或 "/workflow "（或经 autocomplete 选择）后，
 * Composer 会把这个意图提到一个独立的 chip，textarea 只剩用户的正文。
 * 这样：
 *   - sidebar / chat bubble / session jsonl 显示用户原文（不含 /goal）
 *   - send 时按 mode 走 startGoal / startWorkflow / 普通 prompt
 *   - Backspace 在正文最前选中 chip，再次按删除（与现代 chat composer 一致）
 *
 * 视觉：参考用户给的规格（24px 高，6px 圆角，克制）。
 */

import { Flag, Workflow, X } from "lucide-react";

export type ComposerMode = "goal" | "workflow";

const MODE_META: Record<
  ComposerMode,
  {
    label: string;
    Icon: typeof Flag;
    /** chip 主色（border + 文字 hint），默认走中性，goal 偏 amber，workflow 偏 accent */
    accent: string;
  }
> = {
  goal: {
    label: "Goal",
    Icon: Flag,
    accent: "var(--color-warning)",
  },
  workflow: {
    label: "Workflow",
    Icon: Workflow,
    accent: "var(--accent)",
  },
};

export interface ModeChipProps {
  mode: ComposerMode;
  /** 是否处于"键盘选中"态（光标在正文最前按了一次 Backspace）。 */
  active?: boolean;
  onRemove: () => void;
}

export function ModeChip({ mode, active, onRemove }: ModeChipProps) {
  const meta = MODE_META[mode];
  const Icon = meta.Icon;
  return (
    <span
      data-testid={`mode-chip-${mode}`}
      data-active={active ? "true" : "false"}
      className="inline-flex items-center gap-1.5 select-none"
      style={{
        height: 24,
        borderRadius: 6,
        padding: "0 6px",
        fontSize: 12,
        lineHeight: "20px",
        fontFamily: "var(--font-mono)",
        border: `1px solid ${active ? meta.accent : "var(--border)"}`,
        background: active ? "var(--bg-panel-2)" : "var(--bg-panel)",
        color: meta.accent,
        outline: active ? `2px solid ${meta.accent}` : "none",
        outlineOffset: 1,
        transition: "outline-color 80ms, border-color 80ms",
      }}
      title={`${meta.label} \u6a21\u5f0f\uff1aBackspace \u9009\u4e2d / \u00d7 \u5220\u9664`}
    >
      <Icon size={12} aria-hidden />
      <span style={{ color: "var(--text)" }}>{meta.label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`\u53d6\u6d88 ${meta.label} \u6a21\u5f0f`}
        className="ml-0.5 hover:opacity-80"
        style={{
          color: "var(--text-muted)",
          width: 14,
          height: 14,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <X size={12} />
      </button>
    </span>
  );
}

// app/pet/PetBubble.tsx
"use client";

import type { PetAnimState, PetBubbleText } from "./use-pet-state";

/** state → 主色（光点/边框） */
const STATE_COLOR: Record<PetAnimState, string> = {
  idle: "var(--pet-state-idle)",
  complete: "var(--pet-state-complete)",
  approval: "var(--pet-state-approval)",
  clarification: "var(--pet-state-clarification)",
  budget_warning: "var(--pet-state-budget-warning)",
  budget_blocked: "var(--pet-state-budget-blocked)",
  thinking: "var(--pet-state-thinking)",
  running: "var(--pet-state-running)",
  attention: "var(--pet-state-thinking)",
  done: "var(--pet-state-complete)",
  error: "var(--pet-state-error)",
  offline: "var(--pet-state-offline)",
};

interface Props {
  animState: PetAnimState;
  bubbleText: PetBubbleText;
}

export default function PetBubble({ animState, bubbleText }: Props) {
  const color = STATE_COLOR[animState];
  const isHighPriority = bubbleText.priority === "high";
  const shouldPulse =
    animState === "thinking" ||
    animState === "running" ||
    animState === "approval" ||
    animState === "clarification" ||
    animState === "budget_warning" ||
    animState === "budget_blocked";

  return (
    <div
      style={{
        position: "relative",
        maxWidth: 240,
        background: "var(--pet-surface)",
        border: isHighPriority
          ? `1px solid ${color}`
          : "1px solid var(--pet-border)",
        borderRadius: "var(--radius-lg)",
        padding: "8px 12px",
        backdropFilter: "blur(14px)",
        boxShadow: isHighPriority
          ? `var(--pet-shadow), 0 0 0 3px color-mix(in srgb, ${color} 13%, transparent)`
          : "var(--pet-shadow)",
        fontSize: "var(--text-sm)",
        color: "var(--pet-text)",
        lineHeight: "var(--line-ui)",
      }}
    >
      {/* 主文案行：色点 + 文字 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
            boxShadow: `0 0 6px ${color}`,
            flexShrink: 0,
            animation: shouldPulse ? "pulse 1s ease-in-out infinite" : "none",
          }}
        />
        <span
          style={{
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {bubbleText.primary}
        </span>
      </div>

      {/* 副文案行（可选，过长可滚动） */}
      {bubbleText.secondary && (
        <div
          className="pet-bubble-scroll"
          style={{
            marginTop: 4,
            paddingLeft: 14, // 与色点对齐
            color: "var(--pet-text-muted)",
            fontSize: "var(--text-xs)",
            maxHeight: 80,
            overflowY: "auto",
            overflowX: "hidden",
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
          }}
        >
          {bubbleText.secondary}
        </div>
      )}

      {/* 气泡尾巴：指向 sprite（右下） */}
      <div
        style={{
          position: "absolute",
          bottom: -6,
          right: 24,
          width: 10,
          height: 6,
          background: "var(--pet-surface)",
          clipPath: "polygon(0 0, 100% 0, 50% 100%)",
        }}
      />
    </div>
  );
}

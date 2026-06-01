// app/pet/PetBubble.tsx
"use client";

import type { PetAnimState, PetBubbleText } from "./use-pet-state";

/** state → 主色（光点/边框） */
const STATE_COLOR: Record<PetAnimState, string> = {
  idle: "#6b7280", // gray-500
  thinking: "#6366f1", // indigo-500
  running: "#a855f7", // purple-500
  attention: "#ef4444", // red-500
  done: "#10b981", // emerald-500
  error: "#dc2626", // red-600
  offline: "#9ca3af", // gray-400
};

interface Props {
  animState: PetAnimState;
  bubbleText: PetBubbleText;
}

export default function PetBubble({ animState, bubbleText }: Props) {
  const color = STATE_COLOR[animState];
  const isHighPriority = bubbleText.priority === "high";

  return (
    <div
      style={{
        position: "relative",
        maxWidth: 240,
        background: "rgba(17,24,39,0.92)", // slate-900/92
        border: isHighPriority
          ? `1px solid ${color}`
          : "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
        padding: "8px 12px",
        backdropFilter: "blur(14px)",
        boxShadow: isHighPriority
          ? `0 4px 24px rgba(0,0,0,0.5), 0 0 0 3px ${color}22`
          : "0 4px 24px rgba(0,0,0,0.5)",
        fontSize: 12,
        color: "#f9fafb", // gray-50
        lineHeight: 1.4,
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
            animation:
              animState === "thinking" || animState === "running"
                ? "pulse 1s ease-in-out infinite"
                : "none",
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

      {/* 副文案行（可选） */}
      {bubbleText.secondary && (
        <div
          style={{
            marginTop: 4,
            paddingLeft: 14, // 与色点对齐
            color: "#9ca3af", // gray-400
            fontSize: 11,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            wordBreak: "break-all",
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
          background: "rgba(17,24,39,0.92)",
          clipPath: "polygon(0 0, 100% 0, 50% 100%)",
        }}
      />
    </div>
  );
}

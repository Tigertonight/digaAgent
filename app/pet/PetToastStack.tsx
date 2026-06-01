"use client";

import type { PetToast } from "./use-pet-toasts";

interface Props {
  toasts: PetToast[];
}

/**
 * Toast 堆叠层。
 *
 * 布局：在 sprite 上方从下往上堆，最新的在最下（最靠近 sprite，最显眼）。
 * 单条样式与 PetBubble 同风格但更紧凑（不带气泡尾巴，避免与常态气泡冲突）。
 *
 * 不接收鼠标事件（pointerEvents: none）—— toast 是被动通告，不可交互；
 * 让鼠标继续命中 sprite/气泡。
 */
export default function PetToastStack({ toasts }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        right: 0,
        bottom: 120 + 8 + 60, // sprite + gap + 留出气泡空间
        display: "flex",
        flexDirection: "column-reverse", // 新的在下方（视觉上更靠近 sprite）
        gap: 6,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: PetToast }) {
  return (
    <div
      role="status"
      style={{
        maxWidth: 240,
        background: "rgba(17,24,39,0.94)",
        border: `1px solid ${toast.color}`,
        borderLeft: `3px solid ${toast.color}`,
        borderRadius: 10,
        padding: "6px 10px",
        backdropFilter: "blur(14px)",
        boxShadow: `0 4px 16px rgba(0,0,0,0.45), 0 0 0 2px ${toast.color}22`,
        fontSize: 11,
        color: "#f9fafb",
        lineHeight: 1.4,
        // 入场动画
        animation: "pet-toast-in 220ms ease-out",
      }}
    >
      <div style={{ fontWeight: 600 }}>{toast.primary}</div>
      {toast.secondary && (
        <div
          style={{
            marginTop: 2,
            color: "#9ca3af",
            fontSize: 10,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={toast.secondary}
        >
          {toast.secondary}
        </div>
      )}
    </div>
  );
}

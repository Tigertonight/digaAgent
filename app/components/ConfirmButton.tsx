"use client";

/**
 * 两阶段确认按钮：第一次点击进入 "Confirm?" 状态（红色），
 * 再次点击执行 onConfirm；3 秒未操作或失焦自动复位。
 *
 * 用于替换原生 confirm()，跨 ModelsConfigPanel / SkillsPanel / AuthPanel 复用。
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

interface Props {
  onConfirm: () => void;
  /** 默认状态显示的内容（图标或文字） */
  children: ReactNode;
  /** 进入确认态时显示的文字，默认 "Confirm?" */
  confirmLabel?: string;
  className?: string;
  style?: CSSProperties;
  /** 默认状态的 title */
  title?: string;
  disabled?: boolean;
  /** 阻止冒泡（在 row click 容器里需要） */
  stopPropagation?: boolean;
}

export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "Confirm?",
  className,
  style,
  title,
  disabled,
  stopPropagation,
}: Props) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!armed) return;
    timerRef.current = setTimeout(() => setArmed(false), 3000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [armed]);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      onBlur={() => setArmed(false)}
      title={armed ? "再点一次确认" : title}
      className={className}
      style={
        armed
          ? {
              ...style,
              borderColor: "var(--color-danger)",
              background: "var(--color-danger-bg)",
              color: "var(--color-danger)",
            }
          : style
      }
    >
      {armed ? confirmLabel : children}
    </button>
  );
}

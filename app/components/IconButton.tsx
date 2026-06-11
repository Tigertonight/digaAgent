"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "ghost" | "primary" | "outline";
type Size = "sm" | "md";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label?: ReactNode;
  variant?: Variant;
  size?: Size;
  active?: boolean;
}

const sizeMap: Record<Size, string> = {
  sm: "h-[var(--control-sm)] px-1.5 text-token-sm gap-1",
  md: "h-[var(--control-md)] px-2 text-token-ui gap-1.5",
};

const iconSizeMap: Record<Size, number> = {
  sm: 14,
  md: 16,
};

export { iconSizeMap };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      icon,
      label,
      variant = "ghost",
      size = "sm",
      active = false,
      className = "",
      ...rest
    },
    ref,
  ) {
    const base =
      "inline-flex items-center justify-center rounded-[var(--button-radius)] border transition-colors disabled:cursor-not-allowed disabled:opacity-50";

    const variantStyle: Record<Variant, string> = {
      ghost: active
        ? "border-[color:var(--border)] bg-[color:var(--bg-selected)] text-[color:var(--text)]"
        : "border-[color:var(--border)] bg-transparent text-[color:var(--text)] hover:bg-[color:var(--bg-hover)]",
      outline:
        "border-[color:var(--border)] bg-[color:var(--bg-panel)] text-[color:var(--text)] hover:bg-[color:var(--bg-hover)]",
      primary:
        "border-transparent bg-[color:var(--accent)] text-white hover:bg-[color:var(--accent-hover)]",
    };

    return (
      <button
        ref={ref}
        type="button"
        className={`${base} ${sizeMap[size]} ${variantStyle[variant]} ${className}`}
        {...rest}
      >
        <span className="inline-flex items-center justify-center shrink-0">
          {icon}
        </span>
        {label != null && <span className="truncate">{label}</span>}
      </button>
    );
  },
);

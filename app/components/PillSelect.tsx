"use client";

import type { ReactNode, SelectHTMLAttributes } from "react";

interface PillSelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size" | "prefix"> {
  leading?: ReactNode;
  widthClassName?: string;
}

export function PillSelect({
  leading,
  widthClassName,
  className = "",
  children,
  disabled,
  ...rest
}: PillSelectProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${
        disabled ? "opacity-50" : "hover:bg-[color:var(--bg-hover)]"
      } ${className}`}
      style={{
        borderColor: "var(--border)",
        background: "var(--bg-panel)",
        color: "var(--text)",
      }}
    >
      {leading && (
        <span className="inline-flex items-center text-[color:var(--text-muted)]">
          {leading}
        </span>
      )}
      <select
        {...rest}
        disabled={disabled}
        className={`bg-transparent outline-none border-0 pr-1 cursor-pointer disabled:cursor-not-allowed ${widthClassName ?? ""}`}
        style={{ color: "inherit" }}
      >
        {children}
      </select>
    </span>
  );
}

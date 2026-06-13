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
      className={`inline-flex min-w-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${
        disabled ? "opacity-50" : "hover:bg-[color:var(--bg-hover)]"
      } ${className}`}
      style={{
        borderColor: "var(--border)",
        background: "var(--bg-panel)",
        color: "var(--text)",
      }}
    >
      {leading && (
        <span className="inline-flex shrink-0 items-center text-[color:var(--text-muted)]">
          {leading}
        </span>
      )}
      <select
        {...rest}
        disabled={disabled}
        className={`min-w-0 truncate bg-transparent pr-6 outline-none border-0 cursor-pointer disabled:cursor-not-allowed ${widthClassName ?? ""}`}
        style={{ color: "inherit", textOverflow: "ellipsis" }}
      >
        {children}
      </select>
    </span>
  );
}

"use client";

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

type Tone = "default" | "accent" | "success" | "warning" | "danger" | "info";
type ButtonVariant = "ghost" | "outline" | "solid" | "soft";
type ButtonSize = "xs" | "sm" | "md" | "mobile";

const toneText: Record<Tone, string> = {
  default: "text-[color:var(--color-text)]",
  accent: "text-[color:var(--color-accent)]",
  success: "text-[color:var(--color-success)]",
  warning: "text-[color:var(--color-warning)]",
  danger: "text-[color:var(--color-danger)]",
  info: "text-[color:var(--color-info)]",
};

const toneSoft: Record<Tone, string> = {
  default: "bg-[color:var(--color-surface-subtle)]",
  accent: "bg-[color:var(--color-accent-bg)]",
  success: "bg-[color:var(--color-success-bg)]",
  warning: "bg-[color:var(--color-warning-bg)]",
  danger: "bg-[color:var(--color-danger-bg)]",
  info: "bg-[color:var(--color-info-bg)]",
};

const buttonSize: Record<ButtonSize, string> = {
  xs: "h-[var(--control-xs)] px-2 text-token-xs",
  sm: "h-[var(--control-sm)] px-2.5 text-token-sm",
  md: "h-[var(--control-md)] px-3 text-token-ui",
  mobile: "h-[var(--control-mobile)] px-4 text-token-mobile",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  tone?: Tone;
  size?: ButtonSize;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "outline",
    tone = "default",
    size = "sm",
    leading,
    trailing,
    className = "",
    children,
    ...props
  },
  ref,
) {
  const solid =
    tone === "default"
      ? "border-transparent bg-[color:var(--color-text)] text-[color:var(--color-bg)] hover:opacity-90"
      : `border-transparent ${toneSoft[tone]} ${toneText[tone]} hover:opacity-90`;
  const variantClass: Record<ButtonVariant, string> = {
    ghost: `border-transparent bg-transparent ${toneText[tone]} hover:bg-[color:var(--color-surface-hover)]`,
    outline: `border-[color:var(--color-border)] bg-[color:var(--color-bg)] ${toneText[tone]} hover:bg-[color:var(--color-surface-hover)]`,
    soft: `border-transparent ${toneSoft[tone]} ${toneText[tone]} hover:opacity-90`,
    solid,
  };
  return (
    <button
      ref={ref}
      type="button"
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--button-radius)] border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${buttonSize[size]} ${variantClass[variant]} ${className}`}
      {...props}
    >
      {leading ? <span className="inline-flex shrink-0 items-center">{leading}</span> : null}
      {children}
      {trailing ? <span className="inline-flex shrink-0 items-center">{trailing}</span> : null}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  size?: ButtonSize;
  tone?: Tone;
  variant?: ButtonVariant;
}

export const TokenIconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function TokenIconButton(
    { icon, size = "sm", tone = "default", variant = "ghost", className = "", ...props },
    ref,
  ) {
    const square: Record<ButtonSize, string> = {
      xs: "h-[var(--control-xs)] w-[var(--control-xs)]",
      sm: "h-[var(--control-sm)] w-[var(--control-sm)]",
      md: "h-[var(--control-md)] w-[var(--control-md)]",
      mobile: "h-[var(--control-mobile)] w-[var(--control-mobile)]",
    };
    return (
      <Button
        ref={ref}
        size={size}
        tone={tone}
        variant={variant}
        className={`px-0 ${square[size]} ${className}`}
        {...props}
      >
        {icon}
      </Button>
    );
  },
);

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  variant?: "soft" | "outline";
}

export function Badge({
  tone = "default",
  variant = "soft",
  className = "",
  children,
  ...props
}: BadgeProps) {
  const variantClass =
    variant === "outline"
      ? `border border-[color:var(--color-border)] bg-transparent ${toneText[tone]}`
      : `border border-transparent ${toneSoft[tone]} ${toneText[tone]}`;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-[var(--badge-radius)] px-2 py-0.5 text-token-xs font-medium ${variantClass} ${className}`}
      {...props}
    >
      {children}
    </span>
  );
}

export function StatusPill({
  tone = "default",
  children,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Badge tone={tone} className={`rounded-[var(--radius-full)] ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${toneSoft[tone]}`} style={{ background: `var(--color-${tone === "default" ? "text-muted" : tone})` }} />
      {children}
    </Badge>
  );
}

interface MenuProps extends HTMLAttributes<HTMLDivElement> {
  width?: string;
}

export function Menu({ width = "var(--menu-width)", className = "", style, ...props }: MenuProps) {
  return (
    <div
      role="menu"
      className={`border bg-[color:var(--menu-bg)] text-[color:var(--color-text)] shadow-popover ${className}`}
      style={{
        width,
        borderColor: "var(--menu-border)",
        borderRadius: "var(--menu-radius)",
        padding: "var(--menu-padding)",
        boxShadow: "var(--menu-shadow)",
        ...style,
      }}
      {...props}
    />
  );
}

interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  tone?: Extract<Tone, "default" | "danger">;
}

export function MenuItem({
  icon,
  tone = "default",
  className = "",
  children,
  ...props
}: MenuItemProps) {
  const danger = tone === "danger";
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center rounded-[var(--menu-item-radius)] px-3 text-left font-medium leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        danger
          ? "text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger-bg)]"
          : "text-[color:var(--color-text)] hover:bg-[color:var(--color-surface-hover)]"
      } ${className}`}
      style={{
        minHeight: "var(--menu-item-height)",
        gap: "var(--menu-item-gap)",
        fontSize: "var(--menu-font-size)",
      }}
      {...props}
    >
      {icon ? (
        <span
          className="inline-flex shrink-0 items-center justify-center"
          style={{
            width: "var(--menu-icon-size)",
            height: "var(--menu-icon-size)",
          }}
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

type FieldInputProps = InputHTMLAttributes<HTMLInputElement>;

export const FieldInput = forwardRef<HTMLInputElement, FieldInputProps>(
  function FieldInput({ className = "", ...props }, ref) {
    return (
      <input
        ref={ref}
        className={`h-[var(--field-height)] rounded-[var(--field-radius)] border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 text-token-ui text-[color:var(--color-text)] outline-none placeholder:text-[color:var(--color-text-dim)] focus:border-[color:var(--color-accent)] ${className}`}
        {...props}
      />
    );
  },
);

interface BottomSheetProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
}

export function BottomSheet({ open, className = "", children, ...props }: BottomSheetProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-end bg-black/30 px-3 pb-3 pt-12">
      <div
        className={`w-full rounded-t-[var(--sheet-radius)] border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-4 shadow-modal ${className}`}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}

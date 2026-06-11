"use client";

export function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  password,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  password?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-token-xs" style={{ color: "var(--fg-faint)" }}>
        {label}
      </span>
      <input
        type={password ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded px-2 py-1 text-xs border outline-none font-mono"
        style={{
          background: "var(--bg-panel)",
          borderColor: "var(--border)",
          color: "var(--fg)",
        }}
      />
    </div>
  );
}

export function LabeledNumber({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: number;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-token-xs" style={{ color: "var(--fg-faint)" }}>
        {label}
      </span>
      <input
        type="number"
        step={step}
        value={value ?? ""}
        onChange={(e) => {
          const s = e.target.value;
          if (s === "") onChange(undefined);
          else {
            const n = Number(s);
            if (Number.isFinite(n)) onChange(n);
          }
        }}
        className="rounded px-2 py-1 text-xs border outline-none font-mono"
        style={{
          background: "var(--bg-panel)",
          borderColor: "var(--border)",
          color: "var(--fg)",
        }}
      />
    </div>
  );
}

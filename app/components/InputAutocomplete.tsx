"use client";

/**
 * 输入框自动补全弹层（@ 文件路径 / / 内置命令）。
 *
 * 由父组件维护：
 *   - mode: "@" | "/" | null
 *   - query: 触发字符之后的字符（不含 @ 或 /）
 *   - selectedIndex
 *   - items
 *
 * 父组件在 keydown 拦截 ↑/↓/Enter/Esc/Tab 调 onSelectIndex / onPick / onClose。
 */
import type { ReactNode } from "react";

export interface AutocompleteItem {
  /** 渲染主标题 */
  label: string;
  /** 副标题（如 cwd 相对路径、命令描述） */
  hint?: string;
  /** 替换到输入框的真实字符串（不含触发字符；@ 模式带前缀 @） */
  value: string;
  /** 左侧图标 slot */
  icon?: ReactNode;
}

interface Props {
  mode: "@" | "/";
  items: AutocompleteItem[];
  selectedIndex: number;
  onPick: (item: AutocompleteItem) => void;
  onHover: (idx: number) => void;
  emptyText?: string;
}

export function InputAutocomplete({
  mode,
  items,
  selectedIndex,
  onPick,
  onHover,
  emptyText,
}: Props) {
  return (
    <div
      className="absolute left-2 right-2 bottom-full mb-1.5 z-50 rounded-md shadow-lg overflow-hidden"
      style={{
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        maxHeight: 240,
      }}
      role="listbox"
    >
      <div
        className="px-2 py-1 text-token-xs uppercase tracking-wider"
        style={{
          color: "var(--text-muted)",
          background: "var(--bg-subtle)",
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        {mode === "@" ? "Files in cwd" : "Commands"}
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: 200 }}>
        {items.length === 0 ? (
          <div
            className="px-2.5 py-2 text-xs italic"
            style={{ color: "var(--text-muted)" }}
          >
            {emptyText ?? "No matches"}
          </div>
        ) : (
          items.map((it, i) => {
            const active = i === selectedIndex;
            return (
              <button
                key={`${it.value}:${i}`}
                type="button"
                role="option"
                aria-selected={active}
                onMouseDown={(e) => {
                  // mousedown 而非 click：避免 textarea blur 后丢上下文
                  e.preventDefault();
                  onPick(it);
                }}
                onMouseEnter={() => onHover(i)}
                className="w-full px-2.5 py-1.5 flex items-center gap-2 text-left text-xs"
                style={{
                  background: active ? "var(--bg-selected)" : "transparent",
                  color: "var(--text)",
                }}
              >
                {it.icon && (
                  <span
                    className="shrink-0 inline-flex items-center justify-center"
                    style={{ color: "var(--text-muted)", width: 14 }}
                  >
                    {it.icon}
                  </span>
                )}
                <span className="font-mono truncate">{it.label}</span>
                {it.hint && (
                  <span
                    className="ml-auto truncate text-token-xs"
                    style={{ color: "var(--text-muted)", maxWidth: "55%" }}
                  >
                    {it.hint}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

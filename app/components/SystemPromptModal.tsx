"use client";

/**
 * SystemPromptModal —— 展示当前会话「拼出来的 system prompt」全文。
 * RFC-1 阶段 C4：从 ChatApp.tsx 抽出，纯展示组件。
 *
 * 设计要点：
 *   - 受控：父组件管理 open + text 两个 state，自己只负责渲染
 *   - text 三态：null = Loading / "" = 提示先发消息 / 非空 = pre 渲染
 *   - 点击遮罩 / Close 按钮触发 onClose
 */

export interface SystemPromptModalProps {
  text: string | null;
  onClose: () => void;
}

export function SystemPromptModal({ text, onClose }: SystemPromptModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md w-full max-w-3xl max-h-[80vh] flex flex-col"
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          color: "var(--fg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-2 border-b"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <h2 className="text-sm font-semibold">System prompt</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (text) void navigator.clipboard.writeText(text);
              }}
              className="px-2 py-1 text-xs rounded border hover:opacity-80"
              style={{ borderColor: "var(--border)" }}
              disabled={!text}
            >
              Copy
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-2 py-1 text-xs rounded border hover:opacity-80"
              style={{ borderColor: "var(--border)" }}
            >
              Close
            </button>
          </div>
        </div>
        <div className="overflow-auto flex-1 p-3">
          {text == null ? (
            <div className="text-xs" style={{ color: "var(--fg-faint)" }}>
              Loading…
            </div>
          ) : text === "" ? (
            <div className="text-xs" style={{ color: "var(--fg-faint)" }}>
              Send a message to load the system prompt
            </div>
          ) : (
            <pre
              className="text-[12px] whitespace-pre-wrap font-mono leading-[1.45]"
              style={{ color: "var(--fg)" }}
            >
              {text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

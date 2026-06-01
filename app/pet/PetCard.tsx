"use client";

import { useCallback, useState } from "react";
import type { PetSessionInfo } from "@/lib/electron-bridge";

interface Props {
  session: PetSessionInfo | null;
  onClose: () => void;
  onFocusMain: () => void;
}

export default function PetCard({ session, onClose, onFocusMain }: Props) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAbort = useCallback(async () => {
    if (!session?.agentId) return;
    setAborting(true);
    setError(null);
    try {
      const r = await fetch(`/api/agent/${session.agentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "abort" }),
      });
      const d = await r.json();
      if (d.error) setError(d.error);
      else onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setAborting(false);
    }
  }, [session, onClose]);

  const handleSend = useCallback(async () => {
    if (!session?.agentId || !input.trim()) return;
    setSending(true);
    setError(null);
    try {
      const r = await fetch(`/api/agent/${session.agentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "prompt", text: input.trim() }),
      });
      const d = await r.json();
      if (d.error) setError(d.error);
      else {
        setInput("");
        onClose();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }, [session, input, onClose]);

  return (
    // 点击卡片外部关闭
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
      }}
      onClick={onClose}
    >
      <div
        style={{
          position: "absolute",
          bottom: "calc(100% + 8px)",
          left: "50%",
          transform: "translateX(-50%)",
          width: 280,
          background: "rgba(18,18,18,0.98)",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 14,
          padding: 14,
          backdropFilter: "blur(16px)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
          fontSize: 12,
          color: "#e0e0e0",
          zIndex: 9999,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：session 名 + 关闭 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: "#fff", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session?.name || "Diga Agent"}
          </span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {/* 消息摘要 */}
        {session?.lastMessage && (
          <div
            style={{
              background: "rgba(255,255,255,0.05)",
              borderRadius: 8,
              padding: "8px 10px",
              marginBottom: 10,
              fontSize: 11,
              color: "#a0a0a0",
              lineHeight: 1.5,
              maxHeight: 72,
              overflow: "hidden",
            }}
          >
            {session.lastMessage}
          </div>
        )}

        {/* 当前工具 */}
        {session?.currentTool && (
          <div style={{ fontSize: 10, color: "#f59e0b", marginBottom: 8 }}>
            🔧 正在执行：{session.currentTool}
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div style={{ fontSize: 10, color: "#f87171", marginBottom: 8 }}>
            {error}
          </div>
        )}

        {/* 快速回复输入框 */}
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="快速回复…"
            style={{
              flex: 1,
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              padding: "6px 10px",
              color: "#fff",
              fontSize: 11,
              outline: "none",
            }}
            disabled={sending}
            autoFocus
          />
          <button
            onClick={() => void handleSend()}
            disabled={sending || !input.trim()}
            style={{
              background: input.trim() ? "#7ee787" : "rgba(255,255,255,0.08)",
              border: "none",
              borderRadius: 8,
              padding: "6px 10px",
              color: input.trim() ? "#000" : "#555",
              fontSize: 11,
              cursor: input.trim() ? "pointer" : "default",
              fontWeight: 600,
              transition: "all 0.15s",
            }}
          >
            {sending ? "…" : "发送"}
          </button>
        </div>

        {/* 操作按钮行 */}
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={onFocusMain}
            style={{
              flex: 1,
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              padding: "6px 0",
              color: "#ccc",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            跳回主窗口
          </button>
          {session?.streaming && (
            <button
              onClick={() => void handleAbort()}
              disabled={aborting}
              style={{
                background: "rgba(248,113,113,0.12)",
                border: "1px solid rgba(248,113,113,0.3)",
                borderRadius: 8,
                padding: "6px 12px",
                color: "#f87171",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              {aborting ? "…" : "中止"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

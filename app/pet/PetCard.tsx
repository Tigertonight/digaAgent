"use client";

import { useCallback, useEffect, useState } from "react";
import type { PetSessionInfo } from "@/lib/electron-bridge";
import type { PetAnimState, PetBubbleText } from "./use-pet-state";
import { derivePetAnimState } from "./use-pet-state";

const STATE_COLOR: Record<PetAnimState, string> = {
  idle: "#6b7280",
  complete: "#10b981",
  thinking: "#6366f1",
  running: "#a855f7",
  attention: "#6366f1",
  done: "#10b981",
  error: "#dc2626",
  offline: "#9ca3af",
};

const STATE_LABEL: Record<PetAnimState, string> = {
  idle: "空闲",
  complete: "已完成",
  thinking: "思考中",
  running: "运行中",
  attention: "待回复",
  done: "已完成",
  error: "出错",
  offline: "离线",
};

interface Props {
  session: PetSessionInfo | null;
  animState: PetAnimState;
  bubbleText: PetBubbleText;
  allSessions: PetSessionInfo[];
  localFocusId: string | null;
  onClose: () => void;
  onFocusMain: () => void;
  /** 本地切换显示哪个 session（不推回主窗口） */
  onSwitchLocalSession: (id: string) => void;
  /** 请求重连当前 session 的 SSE（lost 态可用） */
  onReconnect: () => void;
}

export default function PetCard({
  session,
  animState,
  bubbleText,
  allSessions,
  localFocusId,
  onClose,
  onFocusMain,
  onSwitchLocalSession,
  onReconnect,
}: Props) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sessionsExpanded, setSessionsExpanded] = useState(false);

  const color = STATE_COLOR[animState];
  const otherSessions = allSessions.filter(
    (s) => s.agentId && s.id !== session?.id
  );

  // ESC 关卡片
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleAbort = useCallback(async () => {
    if (!session?.agentId) return;
    setAborting(true);
    setActionError(null);
    try {
      const r = await fetch(`/api/agent/${session.agentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "abort" }),
      });
      const d = await r.json();
      if (d.error) setActionError(d.error);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setAborting(false);
    }
  }, [session]);

  const handleSend = useCallback(async () => {
    if (!session?.agentId || !input.trim() || session.streaming) return;
    setSending(true);
    setActionError(null);
    try {
      const r = await fetch(`/api/agent/${session.agentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "prompt", text: input.trim() }),
      });
      const d = await r.json();
      if (d.error) setActionError(d.error);
      else {
        setInput("");
        onClose();
      }
    } catch (e) {
      setActionError(String(e));
    } finally {
      setSending(false);
    }
  }, [session, input, onClose]);

  const canSend = !!input.trim() && !sending && !session?.streaming;
  const canAbort = !!session?.streaming && !aborting;
  const isError = animState === "error";
  const isOffline = animState === "offline";

  return (
    <div
      style={{
        position: "relative",
        width: 280,
        background: "rgba(17,24,39,0.96)",
        border: isError || isOffline
          ? `1px solid ${color}`
          : "1px solid rgba(255,255,255,0.1)",
        borderRadius: 16,
        padding: 12,
        backdropFilter: "blur(16px)",
        boxShadow: isError || isOffline
          ? `0 8px 32px rgba(0,0,0,0.6), 0 0 0 4px ${color}22`
          : "0 8px 32px rgba(0,0,0,0.6)",
        fontSize: 12,
        color: "#f9fafb",
      }}
    >
      {/* ===== Header: 色点 + session 名 + 关闭 ===== */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 10,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: color,
            boxShadow: `0 0 8px ${color}`,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontWeight: 600,
            fontSize: 13,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={session?.name}
        >
          {session?.name || "Diga Agent"}
        </span>
        <span
          style={{
            fontSize: 10,
            color: "#9ca3af",
            background: "rgba(255,255,255,0.05)",
            padding: "2px 6px",
            borderRadius: 6,
          }}
        >
          {STATE_LABEL[animState]}
        </span>
        <button
          onClick={onClose}
          aria-label="关闭"
          style={{
            background: "none",
            border: "none",
            color: "#6b7280",
            cursor: "pointer",
            fontSize: 18,
            padding: 0,
            lineHeight: 1,
            width: 18,
            height: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ×
        </button>
      </div>

      {/* ===== 状态行（主文案 + 副文案） ===== */}
      <div style={{ marginBottom: 10 }}>
        <div
          style={{
            fontSize: 12,
            color: "#f9fafb",
            fontWeight: 500,
          }}
        >
          {bubbleText.primary}
        </div>
        {bubbleText.secondary && (
          <div
            style={{
              marginTop: 2,
              fontSize: 11,
              color: "#9ca3af",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={bubbleText.secondary}
          >
            {bubbleText.secondary}
          </div>
        )}
      </div>

      {/* ===== 最后一条 assistant 消息（可滚动，最多 ~7 行） ===== */}
      {session?.lastMessage && (
        <div
          className="pet-card-scroll"
          style={{
            background: "rgba(255,255,255,0.04)",
            borderRadius: 8,
            padding: "8px 10px",
            marginBottom: 10,
            fontSize: 11,
            color: "#d1d5db",
            lineHeight: 1.5,
            maxHeight: 140,
            overflowY: "auto",
            overflowX: "hidden",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {session.lastMessage}
        </div>
      )}

      {/* ===== action 错误提示 ===== */}
      {actionError && (
        <div
          style={{
            fontSize: 10,
            color: "#fca5a5",
            background: "rgba(220,38,38,0.12)",
            border: "1px solid rgba(220,38,38,0.25)",
            borderRadius: 6,
            padding: "6px 8px",
            marginBottom: 8,
          }}
        >
          {actionError}
        </div>
      )}

      {/* ===== 快速回复输入 ===== */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value.slice(0, 500))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={
            session?.streaming ? "Agent 运行中，无法发送…" : "快速回复…"
          }
          maxLength={500}
          style={{
            flex: 1,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            padding: "6px 10px",
            color: "#fff",
            fontSize: 11,
            outline: "none",
          }}
          disabled={sending || !!session?.streaming}
          autoFocus
        />
        <button
          onClick={() => void handleSend()}
          disabled={!canSend}
          style={{
            background: canSend ? "#6366f1" : "rgba(255,255,255,0.06)",
            border: "none",
            borderRadius: 8,
            padding: "6px 12px",
            color: canSend ? "#fff" : "#4b5563",
            fontSize: 11,
            cursor: canSend ? "pointer" : "default",
            fontWeight: 600,
            transition: "background 150ms",
          }}
        >
          {sending ? "…" : "发送"}
        </button>
      </div>

      {/* ===== 主操作行 ===== */}
      {/* lost 态下："暂停"换成"重连"按钮（暂停在 lost 时本就 disabled，
          换成更有意义的操作避免 dead button） */}
      <div style={{ display: "flex", gap: 6 }}>
        {isOffline ? (
          <button
            onClick={onReconnect}
            title="重新建立 SSE 连接"
            style={{
              flex: 1,
              background: "rgba(99,102,241,0.18)",
              border: "1px solid rgba(99,102,241,0.4)",
              borderRadius: 8,
              padding: "6px 0",
              color: "#a5b4fc",
              fontSize: 11,
              cursor: "pointer",
              fontWeight: 600,
              transition: "all 150ms",
            }}
          >
            ⟳ 重连
          </button>
        ) : (
          <button
            onClick={() => void handleAbort()}
            disabled={!canAbort}
            title={canAbort ? "中止当前任务" : "无运行中任务"}
            style={{
              flex: 1,
              background: canAbort
                ? "rgba(248,113,113,0.12)"
                : "rgba(255,255,255,0.04)",
              border: canAbort
                ? "1px solid rgba(248,113,113,0.3)"
                : "1px solid rgba(255,255,255,0.06)",
              borderRadius: 8,
              padding: "6px 0",
              color: canAbort ? "#f87171" : "#4b5563",
              fontSize: 11,
              cursor: canAbort ? "pointer" : "default",
              transition: "all 150ms",
            }}
          >
            {aborting ? "中止中…" : "⏸ 暂停"}
          </button>
        )}
        <button
          onClick={onFocusMain}
          style={{
            flex: 1,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8,
            padding: "6px 0",
            color: "#d1d5db",
            fontSize: 11,
            cursor: "pointer",
            transition: "background 150ms",
          }}
        >
          ↗ 跳回主窗口
        </button>
      </div>

      {/* ===== 其他会话折叠区 ===== */}
      {otherSessions.length > 0 && (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <button
            onClick={() => setSessionsExpanded((v) => !v)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "none",
              border: "none",
              color: "#9ca3af",
              fontSize: 11,
              padding: "2px 0",
              cursor: "pointer",
            }}
          >
            <span>其他会话 ({otherSessions.length})</span>
            <span style={{ fontSize: 10 }}>
              {sessionsExpanded ? "收起" : "展开"}
            </span>
          </button>
          {sessionsExpanded && (
            <div
              style={{
                marginTop: 6,
                display: "flex",
                flexDirection: "column",
                gap: 2,
                maxHeight: 140,
                overflowY: "auto",
              }}
            >
              {otherSessions.map((s) => {
                // 复用主状态机派生，保持与主视图同语义（避免散落 if/else）
                const sState = derivePetAnimState(s);
                const sColor = STATE_COLOR[sState];
                const sStatus = STATE_LABEL[sState];
                const isFocused = s.id === localFocusId;
                return (
                  <button
                    key={s.id}
                    onClick={() => onSwitchLocalSession(s.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: "1px solid",
                      borderColor: isFocused
                        ? "rgba(99,102,241,0.4)"
                        : "transparent",
                      background: isFocused
                        ? "rgba(99,102,241,0.1)"
                        : "transparent",
                      color: "#d1d5db",
                      fontSize: 11,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                    title={s.name}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: sColor,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.name}
                    </span>
                    <span
                      style={{
                        color: "#6b7280",
                        fontSize: 10,
                        flexShrink: 0,
                      }}
                    >
                      {sStatus}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

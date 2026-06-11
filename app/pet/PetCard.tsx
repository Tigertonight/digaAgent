"use client";

import { useCallback, useEffect, useState } from "react";
import type { PetSessionInfo } from "@/lib/electron-bridge";
import type { PetAnimState, PetBubbleText } from "./use-pet-state";
import { derivePetAnimState } from "./use-pet-state";
import { userFacingMessage } from "@/lib/user-facing-error";

const STATE_COLOR: Record<PetAnimState, string> = {
  idle: "var(--pet-state-idle)",
  complete: "var(--pet-state-complete)",
  approval: "var(--pet-state-approval)",
  clarification: "var(--pet-state-clarification)",
  budget_warning: "var(--pet-state-budget-warning)",
  budget_blocked: "var(--pet-state-budget-blocked)",
  thinking: "var(--pet-state-thinking)",
  running: "var(--pet-state-running)",
  attention: "var(--pet-state-thinking)",
  done: "var(--pet-state-complete)",
  error: "var(--pet-state-error)",
  offline: "var(--pet-state-offline)",
};

const STATE_LABEL: Record<PetAnimState, string> = {
  idle: "空闲",
  complete: "已完成",
  approval: "待授权",
  clarification: "待确认",
  budget_warning: "预算预警",
  budget_blocked: "预算暂停",
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
      if (d.error) setActionError(userFacingMessage(d.error));
    } catch (e) {
      setActionError(userFacingMessage(e));
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
      if (d.error) setActionError(userFacingMessage(d.error));
      else {
        setInput("");
        onClose();
      }
    } catch (e) {
      setActionError(userFacingMessage(e));
    } finally {
      setSending(false);
    }
  }, [session, input, onClose]);

  const canSend = !!input.trim() && !sending && !session?.streaming;
  const canAbort = !!session?.streaming && !aborting;
  const isError = animState === "error";
  const isOffline = animState === "offline";
  const isActionRequired =
    animState === "approval" ||
    animState === "clarification" ||
    animState === "budget_blocked";
  const isBudgetWarning = animState === "budget_warning";

  return (
    <div
      style={{
        position: "relative",
        width: 280,
        background: "var(--pet-surface-strong)",
        border: isError || isOffline || isActionRequired || isBudgetWarning
          ? `1px solid ${color}`
          : "1px solid var(--pet-border)",
        borderRadius: "var(--radius-lg)",
        padding: 12,
        backdropFilter: "blur(16px)",
        boxShadow: isError || isOffline || isActionRequired || isBudgetWarning
          ? `var(--pet-shadow-strong), 0 0 0 4px color-mix(in srgb, ${color} 13%, transparent)`
          : "var(--pet-shadow-strong)",
        fontSize: "var(--text-sm)",
        color: "var(--pet-text)",
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
            fontSize: "var(--text-xs)",
            color: "var(--pet-text-muted)",
            background: "var(--pet-surface-soft)",
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
            color: "var(--pet-text-dim)",
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

      {/* ===== offline 专用 banner：醒目提示 + 一键重连 ===== */}
      {isOffline && (
        <button
          onClick={onReconnect}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            background: "color-mix(in srgb, var(--pet-state-error) 15%, transparent)",
            border: "1px solid color-mix(in srgb, var(--pet-state-error) 40%, transparent)",
            borderRadius: "var(--radius-md)",
            padding: "6px 10px",
            marginBottom: 10,
            color: "var(--pet-state-error)",
            fontSize: "var(--text-xs)",
            cursor: "pointer",
            textAlign: "left",
            transition: "background 150ms",
          }}
          title="点击重新建立 SSE 连接"
        >
          <span style={{ fontSize: 13, lineHeight: 1 }}>⚠</span>
          <span style={{ flex: 1, fontWeight: 600 }}>连接已断开</span>
          <span style={{ fontSize: "var(--text-xs)", color: "var(--pet-state-error)" }}>点击重连</span>
        </button>
      )}

      {/* ===== action-required banner：审批 / Budget 阻断 ===== */}
      {isActionRequired && !isOffline && (
        <button
          onClick={onFocusMain}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            background: `color-mix(in srgb, ${color} 13%, transparent)`,
            border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
            borderRadius: "var(--radius-md)",
            padding: "6px 10px",
            marginBottom: 10,
            color: "var(--pet-text)",
            fontSize: "var(--text-xs)",
            cursor: "pointer",
            textAlign: "left",
          }}
          title="回到主窗口处理"
        >
          <span style={{ flex: 1, fontWeight: 600 }}>
            {animState === "approval"
              ? "需要授权"
              : animState === "clarification"
                ? "需要确认下一步"
                : "预算已暂停"}
          </span>
          <span style={{ fontSize: "var(--text-xs)", color }}>
            回主窗口处理
          </span>
        </button>
      )}

      {/* ===== 状态行（主文案 + 副文案） ===== */}
      <div style={{ marginBottom: 10 }}>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--pet-text)",
            fontWeight: 500,
          }}
        >
          {bubbleText.primary}
        </div>
        {bubbleText.secondary && (
          <div
            style={{
              marginTop: 2,
              fontSize: "var(--text-xs)",
              color: "var(--pet-text-muted)",
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
            background: "color-mix(in srgb, var(--pet-text) 4%, transparent)",
            borderRadius: "var(--radius-md)",
            padding: "8px 10px",
            marginBottom: 10,
            fontSize: "var(--text-xs)",
            color: "var(--pet-text)",
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
            fontSize: "var(--text-xs)",
            color: "var(--pet-state-error)",
            background: "color-mix(in srgb, var(--pet-state-error) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--pet-state-error) 25%, transparent)",
            borderRadius: "var(--radius-sm)",
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
            background: "var(--pet-surface-soft)",
            border: "1px solid var(--pet-border)",
            borderRadius: "var(--radius-md)",
            padding: "6px 10px",
            color: "var(--pet-text)",
            fontSize: "var(--text-xs)",
            outline: "none",
          }}
          disabled={sending || !!session?.streaming}
          autoFocus
        />
        <button
          onClick={() => void handleSend()}
          disabled={!canSend}
          style={{
            background: canSend
              ? "var(--pet-state-thinking)"
              : "var(--pet-surface-soft)",
            border: "none",
            borderRadius: "var(--radius-md)",
            padding: "6px 12px",
            color: canSend ? "var(--pet-text)" : "var(--pet-text-dim)",
            fontSize: "var(--text-xs)",
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
              background: "color-mix(in srgb, var(--pet-state-thinking) 18%, transparent)",
              border: "1px solid color-mix(in srgb, var(--pet-state-thinking) 40%, transparent)",
              borderRadius: "var(--radius-md)",
              padding: "6px 0",
              color: "var(--pet-state-thinking)",
              fontSize: "var(--text-xs)",
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
                ? "color-mix(in srgb, var(--pet-state-error) 12%, transparent)"
                : "color-mix(in srgb, var(--pet-text) 4%, transparent)",
              border: canAbort
                ? "1px solid color-mix(in srgb, var(--pet-state-error) 30%, transparent)"
                : "1px solid color-mix(in srgb, var(--pet-text) 6%, transparent)",
              borderRadius: "var(--radius-md)",
              padding: "6px 0",
              color: canAbort ? "var(--pet-state-error)" : "var(--pet-text-dim)",
              fontSize: "var(--text-xs)",
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
            background: "var(--pet-surface-soft)",
            border: "1px solid var(--pet-border)",
            borderRadius: "var(--radius-md)",
            padding: "6px 0",
            color: "var(--pet-text)",
            fontSize: "var(--text-xs)",
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
            borderTop: "1px solid color-mix(in srgb, var(--pet-text) 6%, transparent)",
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
              color: "var(--pet-text-muted)",
              fontSize: "var(--text-xs)",
              padding: "2px 0",
              cursor: "pointer",
            }}
          >
            <span>其他会话 ({otherSessions.length})</span>
              <span style={{ fontSize: "var(--text-xs)" }}>
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
                        ? "color-mix(in srgb, var(--pet-state-thinking) 40%, transparent)"
                        : "transparent",
                      background: isFocused
                        ? "color-mix(in srgb, var(--pet-state-thinking) 10%, transparent)"
                        : "transparent",
                      color: "var(--pet-text)",
                      fontSize: "var(--text-xs)",
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
                        color: "var(--pet-text-dim)",
                        fontSize: "var(--text-xs)",
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

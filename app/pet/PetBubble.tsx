// app/pet/PetBubble.tsx
"use client";

import type { PetSessionInfo } from "@/lib/electron-bridge";
import type { PetAnimState } from "./use-pet-state";

const STATE_LABELS: Record<PetAnimState, string> = {
  idle:      "空闲",
  thinking:  "思考中…",
  running:   "执行工具…",
  attention: "等待回复",
  done:      "完成 ✓",
};

interface Props {
  animState: PetAnimState;
  session: PetSessionInfo | null;
  allSessions: PetSessionInfo[];
  focusedId: string | null;
  onSwitchSession: (id: string) => void;
}

export default function PetBubble({
  animState,
  session,
  allSessions,
  focusedId,
  onSwitchSession,
}: Props) {
  const activeSessions = allSessions.filter((s) => s.agentId);

  return (
    <div
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        left: "50%",
        transform: "translateX(-50%)",
        width: 220,
        background: "rgba(20,20,20,0.95)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 12,
        padding: "10px 12px",
        backdropFilter: "blur(12px)",
        boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
        fontSize: 11,
        color: "#e0e0e0",
        zIndex: 9999,
        pointerEvents: "auto",
      }}
    >
      {/* 当前状态标签 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span
          style={{
            width: 6, height: 6, borderRadius: "50%",
            background:
              animState === "idle" ? "#555" :
              animState === "thinking" ? "#60a5fa" :
              animState === "running" ? "#f59e0b" :
              animState === "attention" ? "#f87171" :
              "#7ee787",
            flexShrink: 0,
          }}
        />
        <span style={{ fontWeight: 600, color: "#fff" }}>
          {STATE_LABELS[animState]}
        </span>
      </div>

      {/* 当前工具 or 消息摘要 */}
      {session?.currentTool && (
        <div style={{ color: "#f59e0b", marginBottom: 4, fontSize: 10 }}>
          🔧 {session.currentTool}
        </div>
      )}
      {session?.lastMessage && (
        <div
          style={{
            color: "#a0a0a0",
            fontSize: 10,
            lineHeight: 1.4,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {session.lastMessage}
        </div>
      )}
      {!session?.currentTool && !session?.lastMessage && (
        <div style={{ color: "#555", fontSize: 10 }}>暂无活跃会话</div>
      )}

      {/* 多 session 切换 pill */}
      {activeSessions.length > 1 && (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
          }}
        >
          {activeSessions.map((s) => (
            <button
              key={s.id}
              onClick={() => onSwitchSession(s.id)}
              style={{
                fontSize: 9,
                padding: "2px 6px",
                borderRadius: 4,
                border: "1px solid",
                borderColor: s.id === focusedId ? "#7ee787" : "rgba(255,255,255,0.15)",
                background: s.id === focusedId ? "rgba(126,231,135,0.15)" : "transparent",
                color: s.id === focusedId ? "#7ee787" : "#888",
                cursor: "pointer",
                maxWidth: 80,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={s.name}
            >
              {s.name || s.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}

      {/* 气泡尾巴 */}
      <div
        style={{
          position: "absolute",
          bottom: -6,
          left: "50%",
          transform: "translateX(-50%)",
          width: 10,
          height: 6,
          background: "rgba(20,20,20,0.95)",
          clipPath: "polygon(0 0, 100% 0, 50% 100%)",
        }}
      />
    </div>
  );
}

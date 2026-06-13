"use client";

/**
 * 非 Electron 环境（如 `next dev` 浏览器直接访问 /pet）下的开发辅助面板。
 *
 * 在 Electron 中宠物状态由主窗口通过 IPC pet:state 推送，浏览器里无 IPC，
 * 直接打开 /pet 会看到永远的 idle 状态。本组件提供：
 *  - 一组按钮直接注入 6 种典型 petState（idle/thinking/running/attention/complete/offline）
 *  - 持久化最后一次选择到 localStorage，刷新后恢复
 *  - 仅在 !window.digaAgent 时渲染，Electron 中不可见
 *
 * 面板固定在窗口左上（远离 sprite 在右下），半透明背景。
 */

import { useCallback, useEffect, useState } from "react";
import type { PetState, PetSessionInfo } from "@/lib/electron-bridge";

type MockKind =
  | "idle"
  | "thinking"
  | "running"
  | "attention"
  | "complete"
  | "offline"
  | "error"
  | "retry"
  | "compacting"
  | "approval"
  | "clarification"
  | "budget_warning"
  | "budget_blocked";

const STORAGE_KEY = "pet:mock:lastKind";

/** 构造一个 mock PetSessionInfo */
function buildMockSession(kind: MockKind): PetSessionInfo {
  const base: PetSessionInfo = {
    id: "mock-session-1",
    agentId: "mock-agent-1",
    name: "mock-project",
    streaming: false,
    agentPhase: null,
    lastMessage: "",
    currentTool: null,
    currentToolTarget: null,
    retry: null,
    compacting: false,
    pendingApproval: null,
    pendingClarification: null,
    budget: null,
    error: null,
    sseStatus: "active",
    streamingStartedAt: null,
    read: true,
  };

  switch (kind) {
    case "idle":
      return { ...base, agentId: null };
    case "thinking":
      return {
        ...base,
        streaming: true,
        agentPhase: { kind: "thinking" },
        streamingStartedAt: Date.now() - 3000,
      };
    case "running":
      return {
        ...base,
        streaming: true,
        agentPhase: {
          kind: "running_tools",
          tools: [{ id: "t1", name: "Read" }],
        },
        currentTool: "Read",
        currentToolTarget: "app/pet/PetApp.tsx",
        streamingStartedAt: Date.now() - 8000,
      };
    case "attention":
      return {
        ...base,
        lastMessage: "我已经完成了 PetMockPanel 的实现，新增了 9 种状态注入按钮。",
        read: false,
      };
    case "complete":
      return {
        ...base,
        lastMessage: "已完成，等待下一指令",
        read: true,
      };
    case "offline":
      return { ...base, sseStatus: "lost" };
    case "error":
      return {
        ...base,
        error: "Network timeout after 30s, model provider unreachable",
      };
    case "retry":
      return {
        ...base,
        streaming: true,
        agentPhase: { kind: "thinking" },
        retry: {
          attempt: 2,
          maxAttempts: 3,
          errorMessage: "rate_limit_exceeded",
        },
      };
    case "compacting":
      return {
        ...base,
        streaming: true,
        agentPhase: { kind: "thinking" },
        compacting: true,
      };
    case "approval":
      return {
        ...base,
        streaming: true,
        agentPhase: { kind: "thinking" },
        pendingApproval: {
          count: 1,
          toolName: "Bash",
          toolTarget: "rm -rf build",
          ruleId: "dangerous-bash-destructive",
          createdAt: Date.now(),
        },
      };
    case "clarification":
      return {
        ...base,
        streaming: true,
        agentPhase: { kind: "thinking" },
        pendingClarification: {
          count: 1,
          title: "需要你确认下一步",
          question: "先收口 MVP 还是完整重构？",
          recommendedLabel: "先收口 MVP",
          createdAt: Date.now(),
        },
      };
    case "budget_warning":
      return {
        ...base,
        streaming: true,
        agentPhase: { kind: "running_tools", tools: [{ id: "t1", name: "Edit" }] },
        currentTool: "Edit",
        currentToolTarget: "ChatApp.tsx",
        budget: {
          level: "warning",
          label: "接近预算上限",
          detail: "轮次 82%",
          triggered: [],
          peakRatio: 0.82,
        },
      };
    case "budget_blocked":
      return {
        ...base,
        lastMessage: "当前任务已因 Budget 命中而暂停。",
        budget: {
          level: "blocked",
          label: "已暂停：预算到达上限",
          detail: "费用 / 时长",
          triggered: ["cost", "duration"],
          peakRatio: 1,
        },
      };
  }
}

function buildMockState(kind: MockKind): PetState {
  return {
    sessions: [buildMockSession(kind)],
    focusedSessionId: "mock-session-1",
    petVisible: true,
    petAlwaysShow: false,
  };
}

interface Props {
  onInject: (state: PetState) => void;
}

const KINDS: { kind: MockKind; label: string; color: string }[] = [
  { kind: "idle", label: "Idle", color: "var(--pet-state-offline)" },
  { kind: "thinking", label: "Thinking", color: "var(--pet-state-thinking)" },
  { kind: "running", label: "Running", color: "var(--pet-state-running)" },
  { kind: "attention", label: "Attention", color: "var(--color-info)" },
  { kind: "complete", label: "Complete", color: "var(--pet-state-complete)" },
  { kind: "offline", label: "Offline", color: "var(--pet-state-error)" },
  { kind: "error", label: "Error", color: "var(--pet-state-error)" },
  { kind: "retry", label: "Retry", color: "var(--pet-state-approval)" },
  { kind: "compacting", label: "Compacting", color: "var(--pet-state-budget-warning)" },
  { kind: "approval", label: "Approval", color: "var(--pet-state-approval)" },
  { kind: "clarification", label: "Clarify", color: "var(--pet-state-clarification)" },
  { kind: "budget_warning", label: "Budget Warn", color: "var(--pet-state-budget-warning)" },
  { kind: "budget_blocked", label: "Budget Stop", color: "var(--pet-state-budget-blocked)" },
];

export default function PetMockPanel({ onInject }: Props) {
  const [active, setActive] = useState<MockKind>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as MockKind | null;
      if (saved && KINDS.some((k) => k.kind === saved)) return saved;
    } catch {}
    return "idle";
  });
  const [collapsed, setCollapsed] = useState(false);

  // 挂载时恢复上次选择 + 立即注入，避免初始为空
  useEffect(() => {
    onInject(buildMockState(active));
    // 仅 mount 一次
  }, [active, onInject]);

  const handlePick = useCallback(
    (kind: MockKind) => {
      setActive(kind);
      try {
        localStorage.setItem(STORAGE_KEY, kind);
      } catch {}
      onInject(buildMockState(kind));
    },
    [onInject]
  );

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        style={{
          position: "fixed",
          top: 8,
          left: 8,
          zIndex: 9999,
          background: "var(--pet-surface)",
          border: "1px solid color-mix(in srgb, var(--pet-state-thinking) 40%, transparent)",
          borderRadius: "var(--radius-sm)",
          padding: "4px 8px",
          color: "var(--pet-state-thinking)",
          fontSize: "var(--text-xs)",
          cursor: "pointer",
          pointerEvents: "auto",
        }}
        title="展开 mock 面板"
      >
        🛠 mock
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 8,
        left: 8,
        zIndex: 9999,
        width: 180,
        background: "var(--pet-surface)",
        border: "1px solid color-mix(in srgb, var(--pet-state-thinking) 40%, transparent)",
        borderRadius: "var(--radius-md)",
        padding: 8,
        color: "var(--pet-text)",
        fontSize: "var(--text-xs)",
        fontFamily: "var(--font-sans)",
        boxShadow: "var(--pet-shadow)",
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <div style={{ fontWeight: 600, color: "var(--pet-state-thinking)" }}>
          🛠 Pet Mock (dev)
        </div>
        <button
          onClick={() => setCollapsed(true)}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--pet-text-muted)",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
            lineHeight: 1,
            padding: 2,
          }}
          title="收起"
        >
          ×
        </button>
      </div>
      <div
        style={{
          color: "var(--pet-text-muted)",
          marginBottom: 8,
          lineHeight: 1.4,
        }}
      >
        非 Electron 环境无 IPC，
        <br />
        点击按钮注入 mock state
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 4,
        }}
      >
        {KINDS.map(({ kind, label, color }) => {
          const isActive = active === kind;
          return (
            <button
              key={kind}
              onClick={() => handlePick(kind)}
              style={{
                background: isActive ? color : "var(--pet-surface-soft)",
                border: `1px solid ${isActive ? color : "var(--pet-border)"}`,
                borderRadius: "var(--radius-xs)",
                padding: "4px 0",
                color: isActive ? "var(--pet-contrast)" : color,
                fontSize: "var(--text-xs)",
                fontWeight: isActive ? 700 : 500,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

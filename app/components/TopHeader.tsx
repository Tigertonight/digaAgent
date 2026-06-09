"use client";

import { useEffect, useState } from "react";
import {
  PanelLeft,
  Wrench,
  PanelRight,
  RefreshCw,
} from "lucide-react";
import { IconButton, iconSizeMap } from "./IconButton";
import { HudMeter } from "./HudMeter";
import { BudgetIndicator } from "./BudgetIndicator";
import type { SseStatus, StatsSnapshot } from "@/lib/session-runner";
import type { ElectronApi } from "@/lib/electron-bridge";
import type {
  BudgetSpent,
  BudgetStatus,
  SessionBudget,
} from "@/lib/budget/types";

interface TopHeaderProps {
  sidebarOpen: boolean;
  theme: "light" | "dark";
  agentId: string | null;
  stats: StatsSnapshot | null;
  sseStatus: SseStatus;
  electronApi: ElectronApi | null;
  currentSessionFile: string | null;
  showTools: boolean;
  showWorkbench: boolean;
  updateStatus?: "idle" | "checking" | "available" | "not-available" | "skipped" | "error";
  updateLatestVersion?: string | null;
  openCommandMenuRequest?: number;
  /** RFC-2 Phase A：Budget 当前生效配置 + 实时状态（来自 useBudget） */
  budget: SessionBudget;
  budgetSpent: BudgetSpent;
  budgetStatus: BudgetStatus;
  budgetHasOverride: boolean;
  hasAuthedProviders: boolean;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
  onOpenBranches: () => void;
  onOpenSystemPrompt: () => void;
  onOpenWorkflows: () => void;
  onRevealInFinder: () => void;
  onOpenProviderSetup: () => void;
  onOpenAuth: () => void;
  onOpenSettings: () => void;
  onReconnectSession: () => void;
  onToggleTools: () => void;
  onToggleWorkbench: () => void;
  onCheckForUpdates?: () => void;
  onDownloadUpdate?: () => void;
  onSkipUpdateVersion?: () => void;
}

// 历史上 TopHeader 是动作菜单入口；P1 重构后全部收敛到左侧 Sidebar header 的
// “…” 菜单了。这里仍然保留原有 Props 类型契约，避免上游 ChatApp 调用点
// 全部变动；函数体内只使用真正还在用的字段。
export function TopHeader({
  sidebarOpen,
  agentId,
  stats,
  sseStatus,
  showTools,
  showWorkbench,
  budget,
  budgetSpent,
  budgetStatus,
  budgetHasOverride,
  onToggleSidebar,
  onReconnectSession,
  onToggleTools,
  onToggleWorkbench,
}: TopHeaderProps) {
  const [hydrated, setHydrated] = useState(false);
  const hydratedAgentId = hydrated ? agentId : null;
  const sseLabel =
    sseStatus === "active"
      ? "Live"
      : sseStatus === "lost"
        ? "Disconnected"
        : null;

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);


  return (
    <header
      className="border-b grid items-center text-xs"
      style={{
        height: 36,
        borderColor: "var(--border)",
        color: "var(--text-muted)",
        paddingLeft: 8,
        paddingRight: 8,
        // 三列:左/中/右,各占自己的 grid track,绝不互相挤压。
        // 右列 minmax(0,auto) 让 token meter 长起来时不撑爆中列。
        gridTemplateColumns: "auto 1fr auto",
        columnGap: 8,
      }}
    >
      {/* 左：layout toggle。动作菜单已收敛到 Sidebar header，避免重复入口。 */}
      <span className="flex items-center gap-1 shrink-0 min-w-0">
        {!sidebarOpen ? (
          <IconButton
            onClick={onToggleSidebar}
            title="展开侧栏"
            aria-label="展开侧栏"
            icon={<PanelLeft size={iconSizeMap.sm} />}
          />
        ) : null}
      </span>

      {/* 中：reserved calm space for current conversation context */}
      <span className="min-w-0" />

      {/* 右：token meter + 辅助操作 + panel toggle */}
      <span className="flex items-center gap-2 justify-end min-w-0">
        {stats && stats.total > 0 && <HudMeter stats={stats} />}
        <BudgetIndicator
          budget={budget}
          spent={budgetSpent}
          status={budgetStatus}
          hasOverride={budgetHasOverride}
        />
        {sseLabel && (
          <span
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 shrink-0"
            style={{
              borderColor:
                sseStatus === "active"
                  ? "rgba(34,197,94,0.45)"
                  : "rgba(239,68,68,0.45)",
              color: sseStatus === "active" ? "#86efac" : "#fca5a5",
              background:
                sseStatus === "active"
                  ? "rgba(34,197,94,0.10)"
                  : "rgba(239,68,68,0.10)",
            }}
            title={
              sseStatus === "active"
                ? "Live sync active"
                : "Connection lost. Session may still be running in background."
            }
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                background: sseStatus === "active" ? "#22c55e" : "#ef4444",
              }}
            />
            <span>{sseLabel}</span>
          </span>
        )}
        {hydrated && sseStatus === "lost" && (
          <IconButton
            onClick={onReconnectSession}
            disabled={!hydratedAgentId}
            title="重连当前 session 的事件流"
            aria-label="重连当前 session"
            icon={<RefreshCw size={iconSizeMap.sm} />}
          />
        )}
        {hydrated && (
          <>
            <IconButton
              onClick={onToggleTools}
              disabled={!hydratedAgentId}
              title={
                !hydratedAgentId
                  ? "需先发送一条消息以建立 session"
                  : showTools
                    ? "关闭 Tools 面板"
                    : "打开 Tools 面板"
              }
              aria-label="Tools 面板"
              active={showTools}
              icon={<Wrench size={iconSizeMap.sm} />}
            />
            <IconButton
              onClick={onToggleWorkbench}
              title={showWorkbench ? "关闭 Workbench" : "打开 Workbench"}
              aria-label="Workbench 面板"
              active={showWorkbench}
              icon={<PanelRight size={iconSizeMap.sm} />}
            />
          </>
        )}
      </span>
    </header>
  );
}

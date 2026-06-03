"use client";

import {
  PanelLeft,
  Sun,
  Moon,
  GitBranch,
  FileText,
  FolderOpen,
  KeyRound,
  Sparkles,
  Wrench,
  PanelRight,
  RefreshCw,
  Globe,
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
  showFiles: boolean;
  showBrowser: boolean;
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
  onRevealInFinder: () => void;
  onOpenProviderSetup: () => void;
  onOpenAuth: () => void;
  onReconnectSession: () => void;
  onToggleTools: () => void;
  onToggleFiles: () => void;
  onToggleBrowser: () => void;
}

export function TopHeader({
  sidebarOpen,
  theme,
  agentId,
  stats,
  sseStatus,
  electronApi,
  currentSessionFile,
  showTools,
  showFiles,
  showBrowser,
  budget,
  budgetSpent,
  budgetStatus,
  budgetHasOverride,
  hasAuthedProviders,
  onToggleSidebar,
  onToggleTheme,
  onOpenBranches,
  onOpenSystemPrompt,
  onRevealInFinder,
  onOpenProviderSetup,
  onOpenAuth,
  onReconnectSession,
  onToggleTools,
  onToggleFiles,
  onToggleBrowser,
}: TopHeaderProps) {
  const sseLabel =
    sseStatus === "active"
      ? "Live"
      : sseStatus === "lost"
        ? "Disconnected"
        : null;

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
      {/* 左：sidebar toggle + theme toggle */}
      <span className="flex items-center gap-1 shrink-0 min-w-0">
        <IconButton
          onClick={onToggleSidebar}
          title={sidebarOpen ? "收起侧栏" : "展开侧栏"}
          aria-label="侧栏开关"
          icon={<PanelLeft size={iconSizeMap.sm} />}
        />
        <IconButton
          onClick={onToggleTheme}
          title={theme === "dark" ? "切到浅色" : "切到深色"}
          aria-label="主题切换"
          icon={
            theme === "dark" ? (
              <Sun size={iconSizeMap.sm} />
            ) : (
              <Moon size={iconSizeMap.sm} />
            )
          }
        />
      </span>

      {/* 中：居中 Branches / System tabs */}
      <span className="flex items-stretch h-full justify-center min-w-0">
        <button
          type="button"
          disabled={!agentId}
          onClick={() => agentId && onOpenBranches()}
          className="inline-flex items-center gap-1.5 h-full px-3 text-[12px] hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
          style={{ color: "var(--text)" }}
          title={agentId ? "查看 / 切换分支" : "需先发送一条消息"}
        >
          <GitBranch size={13} />
          Branches
        </button>
        <button
          type="button"
          disabled={!agentId}
          onClick={onOpenSystemPrompt}
          className="inline-flex items-center gap-1.5 h-full px-3 text-[12px] hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
          style={{ color: "var(--text)" }}
          title={agentId ? "查看 system prompt" : "需先发送一条消息"}
        >
          <FileText size={13} />
          System
        </button>
      </span>

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
        {sseStatus === "lost" && (
          <IconButton
            onClick={onReconnectSession}
            disabled={!agentId}
            title="重连当前 session 的事件流"
            aria-label="重连当前 session"
            icon={<RefreshCw size={iconSizeMap.sm} />}
          />
        )}
        {electronApi && currentSessionFile && (
          <IconButton
            onClick={onRevealInFinder}
            title={`在 Finder 中显示: ${currentSessionFile}`}
            aria-label="在 Finder 中显示"
            icon={<FolderOpen size={iconSizeMap.sm} />}
          />
        )}
        <IconButton
          onClick={onOpenProviderSetup}
          title={
            hasAuthedProviders
              ? "配置 Provider / 模型"
              : "首次配置 Provider"
          }
          aria-label="Provider setup"
          active={!hasAuthedProviders}
          icon={<Sparkles size={iconSizeMap.sm} />}
        />
        <IconButton
          onClick={onOpenAuth}
          title="管理 Provider 凭证"
          aria-label="管理凭证"
          icon={<KeyRound size={iconSizeMap.sm} />}
        />
        <IconButton
          onClick={onToggleTools}
          disabled={!agentId}
          title={
            !agentId
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
          onClick={onToggleBrowser}
          disabled={!agentId}
          title={
            !agentId
              ? "需先发送一条消息以建立 session"
              : showBrowser
                ? "关闭 Browser 面板"
                : "打开 Browser 面板"
          }
          aria-label="Browser 面板"
          active={showBrowser}
          icon={<Globe size={iconSizeMap.sm} />}
        />
        <IconButton
          onClick={onToggleFiles}
          title={showFiles ? "关闭右侧面板" : "打开文件浏览器"}
          aria-label="右侧面板"
          active={showFiles}
          icon={<PanelRight size={iconSizeMap.sm} />}
        />
      </span>
    </header>
  );
}

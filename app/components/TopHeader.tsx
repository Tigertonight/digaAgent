"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  PanelLeft,
  Sun,
  Moon,
  GitBranch,
  FileText,
  History,
  FolderOpen,
  KeyRound,
  Sparkles,
  Wrench,
  PanelRight,
  RefreshCw,
  Plus,
  ChevronRight,
  Download,
  X,
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
  onReconnectSession: () => void;
  onToggleTools: () => void;
  onToggleWorkbench: () => void;
  onCheckForUpdates?: () => void;
  onDownloadUpdate?: () => void;
  onSkipUpdateVersion?: () => void;
}

interface CommandMenuItemProps {
  icon: ReactNode;
  label: string;
  description?: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}

function CommandMenuItem({
  icon,
  label,
  description,
  shortcut,
  disabled,
  onClick,
}: CommandMenuItemProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded px-2.5 py-2 text-left transition-colors hover:bg-[color:var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
    >
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[color:var(--border)] bg-[color:var(--bg-subtle)] text-[color:var(--text-muted)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-[color:var(--text)]">
          {label}
        </span>
        {description ? (
          <span className="block truncate text-[11px] text-[color:var(--text-muted)]">
            {description}
          </span>
        ) : null}
      </span>
      {shortcut ? (
        <span className="shrink-0 rounded bg-[color:var(--bg-selected)] px-1.5 py-0.5 text-[11px] text-[color:var(--text-muted)]">
          {shortcut}
        </span>
      ) : (
        <ChevronRight
          size={13}
          className="shrink-0 text-[color:var(--text-dim)] opacity-0 transition-opacity group-hover:opacity-100"
        />
      )}
    </button>
  );
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
  showWorkbench,
  updateStatus,
  updateLatestVersion,
  openCommandMenuRequest,
  budget,
  budgetSpent,
  budgetStatus,
  budgetHasOverride,
  hasAuthedProviders,
  onToggleSidebar,
  onToggleTheme,
  onOpenBranches,
  onOpenSystemPrompt,
  onOpenWorkflows,
  onRevealInFinder,
  onOpenProviderSetup,
  onOpenAuth,
  onReconnectSession,
  onToggleTools,
  onToggleWorkbench,
  onCheckForUpdates,
  onDownloadUpdate,
  onSkipUpdateVersion,
}: TopHeaderProps) {
  const [commandOpen, setCommandOpen] = useState(false);
  const commandRef = useRef<HTMLDivElement | null>(null);
  const hasUpdate = updateStatus === "available";
  const sseLabel =
    sseStatus === "active"
      ? "Live"
      : sseStatus === "lost"
        ? "Disconnected"
        : null;

  useEffect(() => {
    if (!commandOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (commandRef.current?.contains(target)) return;
      setCommandOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCommandOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [commandOpen]);

  useEffect(() => {
    if (!openCommandMenuRequest) return;
    queueMicrotask(() => setCommandOpen(true));
  }, [openCommandMenuRequest]);

  const runCommand = (fn: () => void) => {
    setCommandOpen(false);
    fn();
  };

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
      {/* 左：layout + command menu */}
      <span className="flex items-center gap-1 shrink-0 min-w-0">
        <IconButton
          onClick={onToggleSidebar}
          title={sidebarOpen ? "收起侧栏" : "展开侧栏"}
          aria-label="侧栏开关"
          icon={<PanelLeft size={iconSizeMap.sm} />}
        />
        <span ref={commandRef} className="relative inline-flex">
          <IconButton
            onClick={() => setCommandOpen((v) => !v)}
            title="打开动作菜单"
            aria-label="动作菜单"
            active={commandOpen || !hasAuthedProviders || hasUpdate}
            icon={<Plus size={iconSizeMap.sm} />}
          />
          {hasUpdate ? (
            <span
              className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-[color:var(--bg-app)]"
              style={{ background: "#3b82f6" }}
              aria-hidden
            />
          ) : null}
          {commandOpen ? (
            <div
              className="absolute left-0 top-[calc(100%+8px)] z-50 w-[320px] rounded-lg border bg-[color:var(--bg-panel)] p-2 shadow-xl"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="px-2 pb-1.5 pt-0.5 text-[11px] font-medium uppercase text-[color:var(--text-dim)]">
                Session
              </div>
              <CommandMenuItem
                icon={<GitBranch size={15} />}
                label="Branches"
                description="查看 / 切换分支"
                disabled={!agentId}
                onClick={() => runCommand(onOpenBranches)}
              />
              <CommandMenuItem
                icon={<FileText size={15} />}
                label="System prompt"
                description="查看当前会话系统提示"
                disabled={!agentId}
                onClick={() => runCommand(onOpenSystemPrompt)}
              />
              <CommandMenuItem
                icon={<History size={15} />}
                label="Workflow history"
                description="从 checkpoint / artifact 续跑"
                disabled={!agentId}
                onClick={() => runCommand(onOpenWorkflows)}
              />
              {electronApi && currentSessionFile ? (
                <CommandMenuItem
                  icon={<FolderOpen size={15} />}
                  label="Reveal session file"
                  description={currentSessionFile}
                  onClick={() => runCommand(onRevealInFinder)}
                />
              ) : null}

              <div className="my-1 h-px bg-[color:var(--border)]" />
              <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase text-[color:var(--text-dim)]">
                Workspace
              </div>
              <CommandMenuItem
                icon={<Sparkles size={15} />}
                label="Provider / Models"
                description={
                  hasAuthedProviders ? "配置模型供应商" : "首次配置模型供应商"
                }
                onClick={() => runCommand(onOpenProviderSetup)}
              />
              <CommandMenuItem
                icon={<KeyRound size={15} />}
                label="Credentials"
                description="管理 Provider 凭证"
                onClick={() => runCommand(onOpenAuth)}
              />
              {electronApi && onCheckForUpdates ? (
                <CommandMenuItem
                  icon={<Download size={15} />}
                  label={
                    updateStatus === "checking"
                      ? "Checking updates"
                      : updateStatus === "available"
                        ? "Update available"
                        : "Check updates"
                  }
                  description={
                    updateStatus === "available" && updateLatestVersion
                      ? `Diga Agent ${updateLatestVersion} 可安装`
                      : "检查 Diga Agent 新版本"
                  }
                  shortcut={
                    updateStatus === "available" && updateLatestVersion
                      ? updateLatestVersion
                      : undefined
                  }
                  disabled={updateStatus === "checking"}
                  onClick={() => runCommand(onCheckForUpdates)}
                />
              ) : null}
              {electronApi && hasUpdate && onDownloadUpdate ? (
                <CommandMenuItem
                  icon={<Download size={15} />}
                  label="Download DMG"
                  description="打开新版本下载页"
                  onClick={() => runCommand(onDownloadUpdate)}
                />
              ) : null}
              {electronApi && hasUpdate && onSkipUpdateVersion ? (
                <CommandMenuItem
                  icon={<X size={15} />}
                  label="Ignore this version"
                  description="这个版本不再提醒"
                  onClick={() => runCommand(onSkipUpdateVersion)}
                />
              ) : null}
              <CommandMenuItem
                icon={
                  theme === "dark" ? <Sun size={15} /> : <Moon size={15} />
                }
                label={theme === "dark" ? "Light theme" : "Dark theme"}
                description="切换界面主题"
                onClick={() => runCommand(onToggleTheme)}
              />
            </div>
          ) : null}
        </span>
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
        {sseStatus === "lost" && (
          <IconButton
            onClick={onReconnectSession}
            disabled={!agentId}
            title="重连当前 session 的事件流"
            aria-label="重连当前 session"
            icon={<RefreshCw size={iconSizeMap.sm} />}
          />
        )}
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
          onClick={onToggleWorkbench}
          title={showWorkbench ? "关闭 Workbench" : "打开 Workbench"}
          aria-label="Workbench 面板"
          active={showWorkbench}
          icon={<PanelRight size={iconSizeMap.sm} />}
        />
      </span>
    </header>
  );
}

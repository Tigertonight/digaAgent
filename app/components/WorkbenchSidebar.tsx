"use client";

import type {
  CSSProperties,
  Dispatch,
  MouseEventHandler,
  ReactNode,
  SetStateAction,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  FolderOpen,
  Globe,
  LayoutDashboard,
  MessageSquare,
  Network,
  Plus,
  ShieldCheck,
  Terminal,
  X,
  Users,
} from "lucide-react";
import type { BrowserAnnotation, BrowserSnapshot } from "@/lib/browser/types";
import type { BudgetStatus } from "@/lib/budget/types";
import type { RuntimeIdentity } from "@/lib/runtime/identity";
import type { StatsSnapshot } from "@/lib/session-runner";
import type { AgentProgress, ProgressArtifact, ProgressGroup } from "@/lib/progress/types";
import type { AgentTeamRun } from "@/lib/agent-team/types";
import FileBrowser from "./FileBrowser";
import { BrowserPanel } from "./BrowserPanel";
import { ProgressPopover } from "./ProgressPopover";
import type { FilesLayout } from "./RightPanelContainer";

export type WorkbenchView =
  | { type: "overview" }
  | { type: "progress" }
  | { type: "outputs" }
  | { type: "files"; path?: string }
  | { type: "context" }
  | { type: "browser"; url?: string }
  | { type: "team"; teamId?: string };

export type WorkbenchTabKind =
  | "home"
  | "progress"
  | "outputs"
  | "files"
  | "context"
  | "browser"
  | "team"
  | "terminal"
  | "sidechat";

export interface WorkbenchTab {
  id: string;
  kind: WorkbenchTabKind;
  title: string;
  subtitle?: string;
  closable: boolean;
  url?: string;
  path?: string;
  teamId?: string;
}

type WorkbenchRecommendationKind = "url" | "file" | "output";

interface WorkbenchRecommendation {
  id: string;
  kind: WorkbenchRecommendationKind;
  title: string;
  subtitle: string;
  href?: string;
}

const OVERVIEW_SECTION_IDS = [
  "progress",
  "outputs",
  "files",
  "context",
  "browser",
] as const;
type OverviewSectionId = (typeof OVERVIEW_SECTION_IDS)[number];
type OverviewExpandedOverrides = Partial<Record<OverviewSectionId, boolean>>;
interface OverviewExpandedPrefs {
  storageKey: string;
  overrides: OverviewExpandedOverrides;
  loaded: boolean;
}

export interface WorkbenchSidebarProps {
  open: boolean;
  view: WorkbenchView;
  width: number;
  isResizing?: boolean;
  cwd: string;
  agentId: string | null;
  runtimeIdentity: RuntimeIdentity;
  progress: AgentProgress | null;
  browserSnapshot: BrowserSnapshot;
  browserOpenRequest?: { id: number; url: string } | null;
  stats: StatsSnapshot | null;
  budgetStatus: BudgetStatus;
  providerLabel: string;
  modelLabel: string;
  thinkingLabel: string;
  toolsCount: number;
  pendingFileCount: number;
  pendingImageCount: number;
  filesLayout: FilesLayout;
  onSplitterMouseDown: MouseEventHandler<HTMLDivElement>;
  onOpenView: (view: WorkbenchView) => void;
  onPickPath: (absPath: string) => void;
  onFilesLayoutChange: Dispatch<SetStateAction<FilesLayout>>;
  onOpenProgressUrl?: (url: string) => void;
  onAnnotate: (annotations: BrowserAnnotation[]) => void;
  agentTeamRuns?: AgentTeamRun[];
  onOpenAgentTeamMember?: (sessionFile: string) => void;
  onAgentTeamCommand?: (
    teamId: string,
    command:
      | { type: "claim_task"; taskId: string; memberId: string; writePaths?: string[] }
      | { type: "complete_task"; taskId: string; memberId: string; findingClaim?: string }
      | { type: "submit_result"; taskId: string; memberId: string; rawText: string; dispatchMode?: "single" | "batch" | "until_idle" }
      | { type: "accept_finding"; findingId: string; actorAgentId?: string }
      | { type: "reject_finding"; findingId: string; actorAgentId?: string; reason?: string }
      | { type: "create_challenge"; findingId: string; actorAgentId?: string; reason?: string; severity?: "low" | "medium" | "high"; requiredEvidenceRefs?: string[] }
      | { type: "resolve_challenge"; challengeId: string; actorAgentId?: string; resolution?: string; resolutionFindingIds?: string[] }
      | { type: "dismiss_challenge"; challengeId: string; actorAgentId?: string; reason?: string }
      | { type: "record_decision"; title?: string; rationale?: string; madeByAgentId?: string; acceptedFindingIds: string[]; rejectedFindingIds?: string[]; challengeIds?: string[]; evidenceRefs?: string[]; sourceResultIds?: string[]; confidence?: "low" | "medium" | "high" }
      | { type: "submit_plan"; taskId: string; actorAgentId?: string; body: string; criteria?: string[] }
      | { type: "approve_plan"; planId: string; actorAgentId?: string }
      | { type: "reject_plan"; planId: string; actorAgentId?: string; reason?: string }
      | { type: "send_message"; fromAgentId: string; toAgentId?: string; body: string }
      | { type: "follow_up_member"; fromAgentId: string; memberId: string; body: string }
      | { type: "promote_member"; memberId: string }
      | { type: "configure_hook"; hookId: string; enabled?: boolean; severity?: "info" | "warning" | "blocking" }
      | { type: "retry_task"; taskId: string }
      | { type: "replace_member"; memberId: string }
      | { type: "run_next" }
      | { type: "run_batch"; maxDispatches?: number }
      | { type: "run_until_idle"; maxDispatches?: number; maxRounds?: number }
  ) => Promise<void> | void;
}

export function WorkbenchSidebar({
  open,
  view,
  width,
  isResizing = false,
  cwd,
  agentId,
  runtimeIdentity,
  progress,
  browserSnapshot,
  browserOpenRequest,
  stats,
  budgetStatus,
  providerLabel,
  modelLabel,
  thinkingLabel,
  toolsCount,
  pendingFileCount,
  pendingImageCount,
  filesLayout,
  onSplitterMouseDown,
  onOpenView,
  onPickPath,
  onFilesLayoutChange,
  onOpenProgressUrl,
  onAnnotate,
  agentTeamRuns = [],
  onOpenAgentTeamMember,
  onAgentTeamCommand,
}: WorkbenchSidebarProps) {
  const storageKey = useMemo(
    () =>
      `pi-workbench-tabs-v1:${
        runtimeIdentity.sessionId ?? agentId ?? cwd ?? "standalone"
      }`,
    [agentId, cwd, runtimeIdentity.sessionId]
  );
  const [tabs, setTabs] = useState<WorkbenchTab[]>(() => [homeTab()]);
  const [activeTabId, setActiveTabId] = useState("home");
  const [loadedStorageKey, setLoadedStorageKey] = useState(storageKey);
  const overviewExpandedStorageKey = `${storageKey}:overview-expanded-v1`;
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const viewRequestKey = `${view.type}:${"url" in view ? view.url ?? "" : ""}:${
    "path" in view ? view.path ?? "" : ""
  }:${"teamId" in view ? view.teamId ?? "" : ""}`;
  const lastViewRequestRef = useRef(viewRequestKey);
  const recommendations = useMemo(
    () =>
      buildWorkbenchRecommendations({
        cwd,
        artifacts: progress?.artifacts ?? [],
        browserSnapshot,
      }),
    [browserSnapshot, cwd, progress?.artifacts]
  );

  useEffect(() => {
    const stored = loadStoredWorkbenchTabs(storageKey);
    queueMicrotask(() => {
      setTabs(stored.tabs);
      setActiveTabId(stored.activeTabId);
      setLoadedStorageKey(storageKey);
    });
  }, [storageKey]);

  useEffect(() => {
    if (loadedStorageKey !== storageKey) return;
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ tabs, activeTabId })
      );
    } catch {
      /* noop */
    }
  }, [activeTabId, loadedStorageKey, storageKey, tabs]);

  const openWorkbenchTab = useCallback(
    (nextView: WorkbenchView) => {
      const nextTab = tabFromView(nextView);
      setTabs((currentTabs) => upsertWorkbenchTab(currentTabs, nextTab));
      setActiveTabId(nextTab.id);
      setCreateMenuOpen(false);
      onOpenView(nextView);
    },
    [onOpenView]
  );

  const openLocalTab = useCallback((nextTab: WorkbenchTab) => {
    setTabs((currentTabs) => upsertWorkbenchTab(currentTabs, nextTab));
    setActiveTabId(nextTab.id);
    setCreateMenuOpen(false);
  }, []);

  useEffect(() => {
    if (lastViewRequestRef.current === viewRequestKey) return;
    lastViewRequestRef.current = viewRequestKey;
    const nextTab = tabFromView(view);
    queueMicrotask(() => {
      setTabs((currentTabs) => upsertWorkbenchTab(currentTabs, nextTab));
      setActiveTabId(nextTab.id);
    });
  }, [view, viewRequestKey]);

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((currentTabs) => {
        const targetIndex = currentTabs.findIndex((tab) => tab.id === tabId);
        if (targetIndex < 0) return currentTabs;
        const target = currentTabs[targetIndex];
        if (!target.closable) return currentTabs;
        const nextTabs = currentTabs.filter((tab) => tab.id !== tabId);
        if (activeTabId === tabId) {
          const fallback =
            nextTabs[Math.max(0, targetIndex - 1)] ?? nextTabs[0] ?? homeTab();
          queueMicrotask(() => {
            setActiveTabId(fallback.id);
            if (fallback.kind !== "terminal" && fallback.kind !== "sidechat") {
              onOpenView(viewFromTab(fallback));
            }
          });
        }
        return nextTabs.length > 0 ? nextTabs : [homeTab()];
      });
    },
    [activeTabId, onOpenView]
  );

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? homeTab();
  const minWidth =
    activeTab.kind === "files" && filesLayout.viewerHidden && filesLayout.treeCollapsed
      ? 56
      : 320;

  const panelWidth = open ? width : 0;
  const panelTransition =
    "width 240ms cubic-bezier(0.22, 1, 0.36, 1), flex-basis 240ms cubic-bezier(0.22, 1, 0.36, 1), min-width 240ms cubic-bezier(0.22, 1, 0.36, 1), max-width 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 160ms ease, border-color 160ms ease";

  return (
    <>
      <div
        onMouseDown={open ? onSplitterMouseDown : undefined}
        title={open ? "拖动调整宽度" : undefined}
        style={{
          width: open ? 4 : 0,
          cursor: open ? "ew-resize" : "default",
          background: "var(--border-soft)",
          flexShrink: 0,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: isResizing
            ? "background 120ms ease"
            : "width 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease, background 120ms ease",
        }}
        onMouseEnter={(e) => {
          if (open) e.currentTarget.style.background = "var(--accent)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--border-soft)";
        }}
      />
      <aside
        className="flex h-full min-h-0 flex-col border-l"
        style={{
          flex: `0 0 ${panelWidth}px`,
          width: panelWidth,
          minWidth: open ? minWidth : 0,
          maxWidth: panelWidth,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          overflow: "hidden",
          contain: "layout paint",
          willChange: "width, flex-basis, opacity",
          background: "var(--bg-panel)",
          borderColor: open ? "var(--border)" : "transparent",
          color: "var(--text)",
          transition: isResizing ? "none" : panelTransition,
        }}
        data-testid="workbench-sidebar"
      >
        <header
          className="relative flex h-10 shrink-0 items-center gap-1 border-b px-2"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <WorkbenchTabButton
                key={tab.id}
                tab={tab}
                active={tab.id === activeTab.id}
                onSelect={() => {
                  setActiveTabId(tab.id);
                  if (tab.kind !== "terminal" && tab.kind !== "sidechat") {
                    onOpenView(viewFromTab(tab));
                  }
                }}
                onClose={() => closeTab(tab.id)}
              />
            ))}
          </div>
          <button
            type="button"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-[color:var(--bg-hover)]"
            style={{ color: "var(--text-muted)" }}
            aria-label="新建 Workbench tab"
            title="新建 Workbench tab"
            data-testid="workbench-create-tab"
            onClick={() => setCreateMenuOpen((value) => !value)}
          >
            <Plus size={15} />
          </button>
          {createMenuOpen ? (
            <WorkbenchCreateMenu
              recommendations={recommendations}
              onOpenView={openWorkbenchTab}
              onOpenTerminal={() => openLocalTab(terminalTab())}
              onOpenSidechat={() => openLocalTab(sidechatTab())}
            />
          ) : null}
        </header>

        <div className="min-h-0 w-full max-w-full flex-1 overflow-auto">
          {activeTab.kind === "home" && (
            <OverviewPanel
              expandedStorageKey={overviewExpandedStorageKey}
              progress={progress}
              browserSnapshot={browserSnapshot}
              cwd={cwd}
              stats={stats}
              budgetStatus={budgetStatus}
              providerLabel={providerLabel}
              modelLabel={modelLabel}
              thinkingLabel={thinkingLabel}
              toolsCount={toolsCount}
              pendingFileCount={pendingFileCount}
              pendingImageCount={pendingImageCount}
              recommendations={recommendations}
              onOpenView={openWorkbenchTab}
              onOpenTerminal={() => openLocalTab(terminalTab())}
            />
          )}
          {activeTab.kind === "progress" && (
            <ProgressDetail progress={progress} onOpenUrl={onOpenProgressUrl} />
          )}
          {activeTab.kind === "outputs" && (
            <OutputsDetail
              artifacts={progress?.artifacts ?? []}
              onOpenView={openWorkbenchTab}
            />
          )}
          {activeTab.kind === "files" && (
            <div className="h-full min-h-0">
              <FileBrowser
                initialPath={cwd || "/"}
                initialFile={activeTab.path}
                onClose={() => closeTab(activeTab.id)}
                onPickPath={onPickPath}
                onLayoutChange={onFilesLayoutChange}
              />
            </div>
          )}
          {activeTab.kind === "context" && (
            <ContextDetail
              cwd={cwd}
              agentId={agentId}
              runtimeIdentity={runtimeIdentity}
              stats={stats}
              budgetStatus={budgetStatus}
              providerLabel={providerLabel}
              modelLabel={modelLabel}
              thinkingLabel={thinkingLabel}
              toolsCount={toolsCount}
              pendingFileCount={pendingFileCount}
              pendingImageCount={pendingImageCount}
            />
          )}
          {activeTab.kind === "browser" && !activeTab.url && (
            <BrowserLauncherPanel
              recommendations={recommendations}
              browserSnapshot={browserSnapshot}
              onOpenView={openWorkbenchTab}
            />
          )}
          {activeTab.kind === "browser" && activeTab.url && (
            <BrowserPanel
              agentId={agentId}
              runtimeIdentity={runtimeIdentity}
              snapshot={browserSnapshot}
              width={width}
              openRequest={browserOpenRequest}
              onClose={() => closeTab(activeTab.id)}
              onAnnotate={onAnnotate}
            />
          )}
          {activeTab.kind === "terminal" && <TerminalLauncherPanel cwd={cwd} />}
          {activeTab.kind === "sidechat" && <SidechatPlaceholder />}
          {activeTab.kind === "team" && (
            <AgentTeamWorkspace
              runs={agentTeamRuns}
              teamId={activeTab.teamId}
              onOpenMember={onOpenAgentTeamMember}
              onCommand={onAgentTeamCommand}
            />
          )}
        </div>
      </aside>
    </>
  );
}

function WorkbenchTabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: WorkbenchTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const Icon = tabIcon(tab.kind);
  return (
    <div
      className="group inline-flex h-7 max-w-[150px] shrink-0 items-center rounded border"
      style={{
        borderColor: active ? "var(--border)" : "transparent",
        background: active ? "var(--bg-selected)" : "transparent",
        color: active ? "var(--text)" : "var(--text-muted)",
      }}
      data-testid={`workbench-tab-${tab.kind}`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-token-xs"
        title={tab.subtitle ? `${tab.title}\n${tab.subtitle}` : tab.title}
      >
        <Icon size={13} className="shrink-0" />
        <span className="truncate">{tab.title}</span>
      </button>
      {tab.closable ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="mr-1 inline-flex h-5 w-5 items-center justify-center rounded opacity-0 hover:bg-[color:var(--bg-hover)] group-hover:opacity-100"
          aria-label={`关闭 ${tab.title}`}
          title={`关闭 ${tab.title}`}
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

function WorkbenchCreateMenu({
  recommendations,
  onOpenView,
  onOpenTerminal,
  onOpenSidechat,
}: {
  recommendations: WorkbenchRecommendation[];
  onOpenView: (view: WorkbenchView) => void;
  onOpenTerminal: () => void;
  onOpenSidechat: () => void;
}) {
  return (
    <div
      className="absolute right-2 top-9 z-20 w-[280px] rounded border p-2 shadow-xl"
      style={{
        borderColor: "var(--border)",
        background: "var(--bg-panel)",
        color: "var(--text)",
      }}
      data-testid="workbench-create-menu"
    >
      <div className="space-y-1">
        <CreateMenuButton
          icon={<FolderOpen size={14} />}
          label="文件"
          shortcut="⌘P"
          onClick={() => onOpenView({ type: "files" })}
        />
        <CreateMenuButton
          icon={<Globe size={14} />}
          label="浏览器"
          shortcut="⌘T"
          onClick={() => onOpenView({ type: "browser" })}
        />
        <CreateMenuButton
          icon={<Terminal size={14} />}
          label="终端"
          shortcut="⌃`"
          onClick={onOpenTerminal}
        />
        <CreateMenuButton
          icon={<LayoutDashboard size={14} />}
          label="概览"
          onClick={() => onOpenView({ type: "overview" })}
        />
        <CreateMenuButton
          icon={<MessageSquare size={14} />}
          label="侧边聊天"
          onClick={onOpenSidechat}
        />
        <CreateMenuButton
          icon={<Network size={14} />}
          label="Team"
          onClick={() => onOpenView({ type: "team" })}
        />
      </div>
      <div className="my-2 h-px" style={{ background: "var(--border-soft)" }} />
      <div className="px-1 pb-1 text-token-xs font-medium" style={{ color: "var(--text-muted)" }}>
        推荐
      </div>
      <div className="max-h-56 space-y-1 overflow-auto">
        {recommendations.slice(0, 6).map((item) => (
          <RecommendationButton
            key={item.id}
            item={item}
            compact
            onOpenView={onOpenView}
          />
        ))}
      </div>
    </div>
  );
}

function CreateMenuButton({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-[color:var(--bg-hover)]"
      data-testid={`workbench-create-${label}`}
    >
      <span className="inline-flex h-6 w-6 items-center justify-center rounded" style={{ background: "var(--bg-selected)", color: "var(--accent)" }}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? (
        <span className="text-token-xs" style={{ color: "var(--text-muted)" }}>
          {shortcut}
        </span>
      ) : null}
    </button>
  );
}

function WorkbenchHomeLauncher({
  recommendations,
  onOpenView,
  onOpenTerminal,
}: {
  recommendations: WorkbenchRecommendation[];
  onOpenView: (view: WorkbenchView) => void;
  onOpenTerminal: () => void;
}) {
  // 响应式网格：跟随 workbench 面板自身宽度（容器查询）
  //   默认 (窄):  1 列，动作名 + body 能完整显示
  //   ≥ 360px:    2 列
  //   ≥ 540px:    4 列一排
  // auto-fit + minmax 会自动填满剩余列，不会出现“三个卡片全隶属一行”的丑状。
  const gridStyle: CSSProperties = {
    display: "grid",
    gap: 8,
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  };
  return (
    <section className="w-full min-w-0 max-w-full space-y-2" data-testid="workbench-home-launcher">
      <div className="w-full min-w-0 max-w-full" style={gridStyle}>
        <LauncherTile
          id="files"
          icon={<FolderOpen size={18} />}
          title="文件"
          body="浏览项目文件"
          onClick={() => onOpenView({ type: "files" })}
        />
        <LauncherTile
          id="browser"
          icon={<Globe size={18} />}
          title="浏览器"
          body="打开本地项目"
          onClick={() => onOpenView({ type: "browser" })}
        />
        <LauncherTile
          id="terminal"
          icon={<Terminal size={18} />}
          title="终端"
          body="启动任务命令"
          onClick={onOpenTerminal}
        />
        <LauncherTile
          id="overview"
          icon={<LayoutDashboard size={18} />}
          title="概览"
          body="查看 session 摘要"
          onClick={() => onOpenView({ type: "overview" })}
        />
      </div>
      <div className="space-y-1">
        <div className="px-1 text-token-xs font-medium" style={{ color: "var(--text-muted)" }}>
          推荐
        </div>
        {recommendations.length > 0 ? (
          recommendations.slice(0, 5).map((item) => (
            <RecommendationButton
              key={item.id}
              item={item}
              onOpenView={onOpenView}
            />
          ))
        ) : (
          <div
            className="rounded border px-2 py-2 text-xs"
            style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
          >
            暂无可推荐的文件或本地网页
          </div>
        )}
      </div>
    </section>
  );
}

function LauncherTile({
  id,
  icon,
  title,
  body,
  onClick,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  body: string;
  onClick: () => void;
}) {
  // 原来固定 p-3 + 垂直堆叠，窄于 160px 时中文 body 只能剩两个字。
  // 现在用 padding 稍紧 + 允许 body 换行到两行，使窄宽下可读。
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 max-w-full flex-col items-start gap-1 overflow-hidden rounded border p-2.5 text-left hover:bg-[color:var(--bg-hover)]"
      style={{ borderColor: "var(--border-soft)", background: "var(--bg-panel-2)" }}
      data-testid={`workbench-launch-${id}`}
    >
      <span
        className="inline-flex h-7 w-7 items-center justify-center rounded"
        style={{ background: "var(--bg-selected)", color: "var(--accent)" }}
      >
        {icon}
      </span>
      <span className="block w-full truncate text-xs font-medium">{title}</span>
      <span
        className="block w-full text-token-xs leading-snug"
        style={{
          color: "var(--text-muted)",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {body}
      </span>
    </button>
  );
}

function RecommendationButton({
  item,
  compact,
  onOpenView,
}: {
  item: WorkbenchRecommendation;
  compact?: boolean;
  onOpenView: (view: WorkbenchView) => void;
}) {
  const Icon = item.kind === "url" ? Globe : item.kind === "file" ? FileText : Boxes;
  return (
    <button
      type="button"
      onClick={() => {
        if (item.kind === "url" && item.href) {
          onOpenView({ type: "browser", url: item.href });
        } else {
          onOpenView({ type: "files", path: item.href });
        }
      }}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[color:var(--bg-hover)]"
      title={item.href ?? item.subtitle}
      data-testid={`workbench-recommendation-${item.kind}`}
    >
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded" style={{ background: "var(--bg-selected)", color: "var(--text-muted)" }}>
        <Icon size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{item.title}</span>
        {!compact ? (
          <span className="block truncate text-token-xs" style={{ color: "var(--text-muted)" }}>
            {item.subtitle}
          </span>
        ) : null}
      </span>
      {item.kind === "url" ? (
        <ExternalLink size={12} className="shrink-0" style={{ color: "var(--text-muted)" }} />
      ) : null}
    </button>
  );
}

function BrowserLauncherPanel({
  recommendations,
  browserSnapshot,
  onOpenView,
}: {
  recommendations: WorkbenchRecommendation[];
  browserSnapshot: BrowserSnapshot;
  onOpenView: (view: WorkbenchView) => void;
}) {
  const browserRecommendations = recommendations.filter((item) => item.kind === "url");
  return (
    <div className="space-y-3 p-2.5" data-testid="workbench-browser-launcher">
      <EmptyDetail
        title="选择要打开的浏览器目标"
        body="这里优先展示当前 session 已知的本地项目 URL，避免默认嵌套打开 Diga 自身页面。"
      />
      <button
        type="button"
        onClick={() => onOpenView({ type: "browser", url: "about:blank" })}
        className="flex w-full items-center gap-2 rounded border px-2 py-2 text-left hover:bg-[color:var(--bg-hover)]"
        style={{ borderColor: "var(--border-soft)", background: "var(--bg-panel-2)" }}
        data-testid="workbench-open-blank-browser"
      >
        <span className="inline-flex h-7 w-7 items-center justify-center rounded" style={{ background: "var(--bg-selected)", color: "var(--accent)" }}>
          <Globe size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium">打开空白页</span>
          <span className="block text-token-xs" style={{ color: "var(--text-muted)" }}>
            进入可接管的 in-app browser
          </span>
        </span>
      </button>
      {browserSnapshot.url && isCurrentAppRootUrl(browserSnapshot.url) ? (
        <div
          className="rounded border px-2 py-1.5 text-xs"
          style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
        >
          当前浏览器 URL 是 Diga 应用自身，已从默认推荐里过滤。
        </div>
      ) : null}
      {browserRecommendations.length > 0 ? (
        <div className="space-y-1">
          {browserRecommendations.map((item) => (
            <RecommendationButton key={item.id} item={item} onOpenView={onOpenView} />
          ))}
        </div>
      ) : (
        <div
          className="rounded border px-3 py-4 text-xs"
          style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
        >
          暂无本地网页推荐。让 agent 打开一个页面，或从产物里生成 URL 后会出现在这里。
        </div>
      )}
    </div>
  );
}

function TerminalLauncherPanel({ cwd }: { cwd: string }) {
  const commands = ["npm run dev", "npm run test", "npx tsc --noEmit", "npx eslint ."];
  return (
    <div className="space-y-3 p-2.5" data-testid="workbench-terminal-detail">
      <EmptyDetail
        title="终端启动器"
        body="v1 先作为常用命令和任务入口，不创建独立 PTY。需要执行时，把命令发给 agent 处理。"
      />
      <div className="space-y-1">
        <div className="px-1 text-token-xs" style={{ color: "var(--text-muted)" }}>
          cwd: {cwd || "n/a"}
        </div>
        {commands.map((command) => (
          <div
            key={command}
            className="rounded border px-2 py-1.5 font-mono text-xs"
            style={{ borderColor: "var(--border-soft)", background: "var(--bg-panel-2)" }}
          >
            {command}
          </div>
        ))}
      </div>
    </div>
  );
}

function SidechatPlaceholder() {
  return (
    <div className="p-2.5" data-testid="workbench-sidechat-detail">
      <EmptyDetail
        title="侧边聊天即将支持"
        body="后续会围绕当前文件或网页提供局部对话。v1 暂不做半成品输入流。"
      />
    </div>
  );
}

function AgentTeamWorkspace({
  runs,
  teamId,
  onOpenMember,
  onCommand,
}: {
  runs: AgentTeamRun[];
  teamId?: string;
  onOpenMember?: (sessionFile: string) => void;
  onCommand?: WorkbenchSidebarProps["onAgentTeamCommand"];
}) {
  const [teamMessage, setTeamMessage] = useState("");
  const [memberFollowUps, setMemberFollowUps] = useState<Record<string, string>>({});
  const [resultDrafts, setResultDrafts] = useState<Record<string, string>>({});
  const [planDrafts, setPlanDrafts] = useState<Record<string, string>>({});
  const run =
    runs.find((item) => item.id === teamId) ?? runs[0] ?? null;
  if (!run) {
    return (
      <div className="p-2.5" data-testid="agent-team-workspace-empty">
        <EmptyDetail
          title="暂无 Agent Team"
          body="使用 /team 启动一个共享白板协作室后，任务、发现、挑战和决策会在这里汇总。"
        />
      </div>
    );
  }

  const openChallenges = run.board.challenges.filter(
    (challenge) =>
      challenge.status === "open" || challenge.status === "needs_evidence"
  );
  const acceptedFindings = run.board.findings.filter(
    (finding) => finding.status === "accepted"
  );
  const resolvedChallenges = run.board.challenges.filter(
    (challenge) => challenge.status === "resolved" || challenge.status === "dismissed"
  );
  const activeFileLocks = (run.board.fileLocks ?? []).filter(
    (lock) => lock.status === "active"
  );
  const lead = run.members.find((member) => member.id === run.leadAgentId) ?? run.members[0];

  return (
    <div className="space-y-3 p-2.5" data-testid="agent-team-workspace">
      <section className="rounded border p-3" style={{ borderColor: "var(--border-soft)", background: "var(--bg-panel-2)" }}>
        <div className="flex min-w-0 items-start gap-2">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded" style={{ background: "var(--bg-selected)", color: "var(--color-info)" }}>
            <Network size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold">Team Workspace</span>
              <span className="rounded border px-1.5 py-0.5 text-token-xs" style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}>
                {agentTeamStatusText(run.status)}
              </span>
            </div>
            <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
              {run.objective}
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-2">
          <TeamMiniStat label="成员" value={run.members.length} />
          <TeamMiniStat label="采纳" value={acceptedFindings.length} />
          <TeamMiniStat label="挑战" value={openChallenges.length} tone={openChallenges.length > 0 ? "warn" : "muted"} />
          <TeamMiniStat label="锁" value={activeFileLocks.length} tone={activeFileLocks.length > 0 ? "warn" : "muted"} />
        </div>
        {onCommand && run.status === "running" ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => onCommand(run.id, { type: "run_next" })}
              className="inline-flex h-7 items-center gap-1.5 rounded border px-2 text-token-xs font-medium hover:bg-[color:var(--bg-hover)]"
              style={{ borderColor: "var(--border-soft)", color: "var(--text)" }}
            >
              <Network size={13} />
              Run next
            </button>
            <button
              type="button"
              onClick={() => onCommand(run.id, { type: "run_batch", maxDispatches: 4 })}
              className="inline-flex h-7 items-center gap-1.5 rounded border px-2 text-token-xs font-medium hover:bg-[color:var(--bg-hover)]"
              style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
            >
              <Network size={13} />
              Run batch
            </button>
            <button
              type="button"
              onClick={() => onCommand(run.id, { type: "run_until_idle", maxDispatches: 4, maxRounds: 6 })}
              className="inline-flex h-7 items-center gap-1.5 rounded border px-2 text-token-xs font-medium hover:bg-[color:var(--bg-hover)]"
              style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
            >
              <Network size={13} />
              Auto run
            </button>
          </div>
        ) : null}
      </section>

      <TeamWorkspaceSection
        title="Board"
        summary={run.board.summary}
        icon={<LayoutDashboard size={13} />}
      >
        <div className="space-y-1.5">
          {run.board.tasks.map((task) => {
            const owner = task.ownerAgentId
              ? run.members.find((member) => member.id === task.ownerAgentId)
              : null;
            return (
              <div
                key={task.id}
                className="rounded border px-2 py-2"
                style={{
                  borderColor: task.status === "blocked" ? "var(--color-warning)" : "var(--border-soft)",
                  background: "var(--bg-subtle)",
                }}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{task.title}</span>
                  <TeamStatusBadge label={teamTaskStatusText(task.status)} tone={task.status === "completed" ? "done" : task.status === "blocked" ? "warn" : "muted"} />
                </div>
                <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
                  {task.description}
                </div>
                <div className="mt-1 flex flex-wrap gap-1 text-token-xs" style={{ color: "var(--fg-faint)" }}>
                  <span>{task.required ? "required" : "optional"}</span>
                  <span>priority {task.priority}</span>
                  {owner ? <span>owner {owner.name}</span> : <span>unclaimed</span>}
                </div>
                {lead && onCommand ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(task.status === "pending" || task.status === "blocked") && (
                      <button
                        type="button"
                        onClick={() =>
                          onCommand(run.id, {
                            type: "claim_task",
                            taskId: task.id,
                            memberId: lead.id,
                          })
                        }
                        className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                        style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                      >
                        claim
                      </button>
                    )}
                    {task.status === "blocked" && (
                      <button
                        type="button"
                        onClick={() =>
                          onCommand(run.id, {
                            type: "retry_task",
                            taskId: task.id,
                          })
                        }
                        className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                        style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                      >
                        retry
                      </button>
                    )}
                    {(task.status === "claimed" || task.status === "running") && (
                      <button
                        type="button"
                        onClick={() =>
                          onCommand(run.id, {
                            type: "complete_task",
                            taskId: task.id,
                            memberId: task.ownerAgentId ?? lead.id,
                            findingClaim: `${task.title} completed.`,
                          })
                        }
                        className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                        style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                      >
                        complete
                      </button>
                    )}
                  </div>
                ) : null}
                {onCommand && (task.status === "claimed" || task.status === "running" || task.status === "blocked") ? (
                  <div className="mt-2 space-y-1.5">
                    <textarea
                      value={resultDrafts[task.id] ?? ""}
                      onChange={(event) =>
                        setResultDrafts((current) => ({
                          ...current,
                          [task.id]: event.target.value,
                        }))
                      }
                      placeholder="Paste TEAM_RESULT_JSON"
                      rows={3}
                      className="w-full resize-none rounded border px-2 py-1 text-token-xs outline-none"
                      style={{
                        borderColor: "var(--border-soft)",
                        background: "var(--bg-panel)",
                        color: "var(--text)",
                      }}
                    />
                    <button
                      type="button"
                      disabled={!(resultDrafts[task.id] ?? "").trim()}
                      onClick={async () => {
                        const rawText = (resultDrafts[task.id] ?? "").trim();
                        if (!rawText) return;
                        setResultDrafts((current) => ({ ...current, [task.id]: "" }));
                        await onCommand(run.id, {
                          type: "submit_result",
                          taskId: task.id,
                          memberId: task.ownerAgentId ?? lead?.id ?? run.leadAgentId,
                          rawText,
                        });
                      }}
                      className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
                      style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                    >
                      submit result
                    </button>
                  </div>
                ) : null}
                {onCommand && run.settings.requirePlanApproval && task.status === "needs_plan" ? (
                  <div className="mt-2 space-y-1.5">
                    <textarea
                      value={planDrafts[task.id] ?? ""}
                      onChange={(event) =>
                        setPlanDrafts((current) => ({
                          ...current,
                          [task.id]: event.target.value,
                        }))
                      }
                      placeholder="Plan for lead approval"
                      rows={2}
                      className="w-full resize-none rounded border px-2 py-1 text-token-xs outline-none"
                      style={{
                        borderColor: "var(--border-soft)",
                        background: "var(--bg-panel)",
                        color: "var(--text)",
                      }}
                    />
                    <button
                      type="button"
                      disabled={!(planDrafts[task.id] ?? "").trim()}
                      onClick={async () => {
                        const body = (planDrafts[task.id] ?? "").trim();
                        if (!body) return;
                        setPlanDrafts((current) => ({ ...current, [task.id]: "" }));
                        await onCommand(run.id, {
                          type: "submit_plan",
                          taskId: task.id,
                          actorAgentId: task.ownerAgentId ?? lead?.id ?? run.leadAgentId,
                          body,
                          criteria: task.acceptanceCriteria,
                        });
                      }}
                      className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
                      style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                    >
                      submit plan
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </TeamWorkspaceSection>

      <TeamWorkspaceSection
        title="Members"
        summary="成员 transcript 默认留在协作室里，不进入主聊天。"
        icon={<Users size={13} />}
      >
        <div className="grid gap-1.5">
          {run.members.map((member) => (
            <div
              key={member.id}
              className="rounded border px-2 py-2"
              style={{ borderColor: "var(--border-soft)", background: "var(--bg-subtle)" }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs font-medium">{member.name}</span>
                <TeamStatusBadge label={teamMemberStatusText(member.status)} tone={member.status === "working" ? "running" : member.status === "blocked" ? "warn" : member.status === "done" ? "done" : "muted"} />
                {member.sessionFile && onOpenMember ? (
                  <button
                    type="button"
                    onClick={() => onOpenMember(member.sessionFile!)}
                    className="ml-auto inline-flex h-6 items-center gap-1 rounded px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    <ExternalLink size={11} />
                    transcript
                  </button>
                ) : null}
              </div>
              <div className="mt-1 text-token-xs" style={{ color: "var(--text-muted)" }}>
                {member.role}
              </div>
              {member.latestOutput ? (
                <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--fg-faint)" }}>
                  {member.latestOutput}
                </div>
              ) : null}
              {onCommand && member.id !== run.leadAgentId ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={async () => {
                      await onCommand(run.id, {
                        type: "promote_member",
                        memberId: member.id,
                      });
                      if (member.sessionFile && onOpenMember) onOpenMember(member.sessionFile);
                    }}
                    className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
                    style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                    disabled={!member.agentId && !member.sessionFile}
                    title="Promote teammate to sidebar"
                  >
                    {member.sidebarVisible ? "promoted" : "promote"}
                  </button>
                  {member.status === "blocked" ? (
                    <button
                      type="button"
                      onClick={() =>
                        onCommand(run.id, {
                          type: "replace_member",
                          memberId: member.id,
                        })
                      }
                      className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                      style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                    >
                      replace
                    </button>
                  ) : null}
                </div>
              ) : null}
              {lead && onCommand && member.id !== run.leadAgentId ? (
                <div className="mt-2 flex gap-1.5">
                  <input
                    value={memberFollowUps[member.id] ?? ""}
                    onChange={(event) =>
                      setMemberFollowUps((current) => ({
                        ...current,
                        [member.id]: event.target.value,
                      }))
                    }
                    placeholder={`Ask ${member.name}`}
                    className="min-w-0 flex-1 rounded border px-2 text-token-xs outline-none"
                    style={{
                      borderColor: "var(--border-soft)",
                      background: "var(--bg-panel)",
                      color: "var(--text)",
                    }}
                  />
                  <button
                    type="button"
                    disabled={!(memberFollowUps[member.id] ?? "").trim()}
                    onClick={async () => {
                      const body = (memberFollowUps[member.id] ?? "").trim();
                      if (!body) return;
                      setMemberFollowUps((current) => ({ ...current, [member.id]: "" }));
                      await onCommand(run.id, {
                        type: "follow_up_member",
                        fromAgentId: lead.id,
                        memberId: member.id,
                        body,
                      });
                    }}
                    className="inline-flex h-7 w-7 items-center justify-center rounded border hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
                    style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                    title="Send follow-up"
                    aria-label="Send follow-up"
                  >
                    <MessageSquare size={13} />
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {lead && onCommand ? (
          <div className="mt-2 flex gap-1.5">
            <input
              value={teamMessage}
              onChange={(event) => setTeamMessage(event.target.value)}
              placeholder="Broadcast to team"
              className="min-w-0 flex-1 rounded border px-2 text-token-xs outline-none"
              style={{
                borderColor: "var(--border-soft)",
                background: "var(--bg-panel)",
                color: "var(--text)",
              }}
            />
            <button
              type="button"
              disabled={!teamMessage.trim()}
              onClick={async () => {
                const body = teamMessage.trim();
                if (!body) return;
                setTeamMessage("");
                await onCommand(run.id, {
                  type: "send_message",
                  fromAgentId: lead.id,
                  body,
                });
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded border hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
              style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
              title="Broadcast"
              aria-label="Broadcast"
            >
              <MessageSquare size={13} />
            </button>
          </div>
        ) : null}
      </TeamWorkspaceSection>

      {activeFileLocks.length > 0 ? (
        <TeamWorkspaceSection
          title="File Locks"
          summary="成员写入同一路径前会先经过 board 锁，避免并发覆盖。"
          icon={<FileText size={13} />}
        >
          <div className="space-y-1.5">
            {activeFileLocks.map((lock) => {
              const owner = run.members.find((member) => member.id === lock.ownerAgentId);
              return (
                <div
                  key={lock.id}
                  className="rounded border px-2 py-2"
                  style={{ borderColor: "var(--color-warning)", background: "var(--bg-subtle)" }}
                >
                  <div className="truncate text-xs font-medium">{lock.path}</div>
                  <div className="mt-1 text-token-xs" style={{ color: "var(--text-muted)" }}>
                    {owner?.name ?? lock.ownerAgentId} · {lock.taskId}
                  </div>
                </div>
              );
            })}
          </div>
        </TeamWorkspaceSection>
      ) : null}

      <TeamWorkspaceSection
        title="Results"
        summary={`${(run.board.results ?? []).length} structured teammate results`}
        icon={<FileText size={13} />}
      >
        <div className="space-y-1.5">
          {(run.board.results ?? []).length === 0 ? (
            <div className="text-token-xs" style={{ color: "var(--text-muted)" }}>
              No submitted teammate results yet.
            </div>
          ) : (
            (run.board.results ?? []).map((result) => {
              const author = run.members.find((member) => member.id === result.authorAgentId);
              return (
                <div
                  key={result.id}
                  className="rounded border px-2 py-2"
                  style={{
                    borderColor: result.status === "needs_review" ? "var(--color-warning)" : "var(--border-soft)",
                    background: "var(--bg-subtle)",
                  }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{result.summary}</span>
                    <TeamStatusBadge label={result.status} tone={result.status === "parsed" ? "done" : "warn"} />
                  </div>
                  <div className="mt-1 text-token-xs" style={{ color: "var(--text-muted)" }}>
                    {author?.name ?? result.authorAgentId} · findings {result.findingIds.length}
                  </div>
                  {result.parseWarnings.length > 0 ? (
                    <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--color-warning)" }}>
                      {result.parseWarnings.join("；")}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </TeamWorkspaceSection>

      <TeamWorkspaceSection
        title="Plans"
        summary={`${(run.board.plans ?? []).length} submitted plans`}
        icon={<LayoutDashboard size={13} />}
      >
        <div className="space-y-1.5">
          {(run.board.plans ?? []).length === 0 ? (
            <div className="text-token-xs" style={{ color: "var(--text-muted)" }}>
              No plans submitted for approval.
            </div>
          ) : (
            (run.board.plans ?? []).map((plan) => {
              const author = run.members.find((member) => member.id === plan.authorAgentId);
              return (
                <div
                  key={plan.id}
                  className="rounded border px-2 py-2"
                  style={{
                    borderColor:
                      plan.status === "approved"
                        ? "var(--color-success)"
                        : plan.status === "rejected"
                          ? "var(--color-danger)"
                          : "var(--border-soft)",
                    background: "var(--bg-subtle)",
                  }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {run.board.tasks.find((task) => task.id === plan.taskId)?.title ?? plan.taskId}
                    </span>
                    <TeamStatusBadge
                      label={plan.status}
                      tone={plan.status === "approved" ? "done" : plan.status === "rejected" ? "danger" : "muted"}
                    />
                  </div>
                  <div className="mt-1 text-token-xs" style={{ color: "var(--text-muted)" }}>
                    {author?.name ?? plan.authorAgentId}
                  </div>
                  <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--fg-faint)" }}>
                    {plan.body}
                  </div>
                  {onCommand && plan.status === "submitted" ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          onCommand(run.id, {
                            type: "approve_plan",
                            planId: plan.id,
                            actorAgentId: lead?.id ?? run.leadAgentId,
                          })
                        }
                        className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                        style={{ borderColor: "var(--border-soft)", color: "var(--color-success)" }}
                      >
                        approve
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onCommand(run.id, {
                            type: "reject_plan",
                            planId: plan.id,
                            actorAgentId: lead?.id ?? run.leadAgentId,
                          })
                        }
                        className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                        style={{ borderColor: "var(--border-soft)", color: "var(--color-danger)" }}
                      >
                        reject
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </TeamWorkspaceSection>

      <TeamWorkspaceSection
        title="Quality Gates"
        summary="结束前必须通过的验收条件。"
        icon={<ShieldCheck size={13} />}
      >
        <div className="space-y-1.5">
          {run.board.qualityGates.map((gate) => (
            <div
              key={gate.id}
              className="rounded border px-2 py-2"
              style={{
                borderColor:
                  gate.status === "failed"
                    ? "var(--color-danger)"
                    : gate.status === "passed"
                      ? "var(--color-success)"
                      : "var(--border-soft)",
                background: "var(--bg-subtle)",
              }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {gate.title}
                </span>
                <TeamStatusBadge
                  label={gate.status}
                  tone={
                    gate.status === "passed"
                      ? "done"
                      : gate.status === "failed"
                        ? "danger"
                        : "muted"
                  }
                />
              </div>
              <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
                {gate.message}
              </div>
            </div>
          ))}
        </div>
      </TeamWorkspaceSection>

      <TeamWorkspaceSection
        title="Hooks"
        summary="运行中阻止或提示低质量状态迁移的规则。"
        icon={<ShieldCheck size={13} />}
      >
        <div className="space-y-1.5">
          {(run.board.hooks ?? []).map((hook) => (
            <div
              key={hook.id}
              className="rounded border px-2 py-2"
              style={{
                borderColor:
                  hook.status === "failed"
                    ? hook.severity === "blocking"
                      ? "var(--color-danger)"
                      : "var(--color-warning)"
                    : hook.status === "passed"
                      ? "var(--color-success)"
                      : "var(--border-soft)",
                background: "var(--bg-subtle)",
              }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{hook.title}</span>
                {onCommand ? (
                  <button
                    type="button"
                    onClick={() =>
                      onCommand(run.id, {
                        type: "configure_hook",
                        hookId: hook.id,
                        enabled: !hook.enabled,
                      })
                    }
                    className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                    style={{ borderColor: "var(--border-soft)", color: hook.enabled ? "var(--text-muted)" : "var(--fg-faint)" }}
                  >
                    {hook.enabled ? "on" : "off"}
                  </button>
                ) : null}
                <TeamStatusBadge
                  label={hook.status}
                  tone={
                    hook.status === "passed"
                      ? "done"
                      : hook.status === "failed"
                        ? hook.severity === "blocking"
                          ? "danger"
                          : "warn"
                        : "muted"
                  }
                />
              </div>
              <div className="mt-1 text-token-xs" style={{ color: "var(--text-muted)" }}>
                {hook.trigger} · {hook.severity}
              </div>
              <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--fg-faint)" }}>
                {hook.lastFailure ?? hook.message}
              </div>
            </div>
          ))}
        </div>
      </TeamWorkspaceSection>

      <TeamWorkspaceSection
        title="Claude Parity"
        summary="持续对照 Claude Agent Teams 能力。"
        icon={<CheckDecisionIcon />}
      >
        <div className="space-y-1.5">
          {run.board.capabilityAudit.map((item) => (
            <div
              key={item.id}
              className="rounded border px-2 py-2"
              style={{ borderColor: "var(--border-soft)", background: "var(--bg-subtle)" }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {item.title}
                </span>
                <TeamStatusBadge
                  label={item.digaStatus}
                  tone={
                    item.digaStatus === "implemented"
                      ? "done"
                      : item.digaStatus === "partial"
                        ? "warn"
                        : item.digaStatus === "blocked"
                          ? "danger"
                          : "muted"
                  }
                />
              </div>
              <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
                {item.gap ?? item.claudeCapability}
              </div>
              {item.nextStep ? (
                <div className="mt-1 text-token-xs" style={{ color: "var(--fg-faint)" }}>
                  next: {item.nextStep}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </TeamWorkspaceSection>

      <TeamWorkspaceSection
        title="Findings & Challenges"
        summary={`${run.board.findings.length} findings · ${run.board.challenges.length} challenges`}
        icon={<ShieldCheck size={13} />}
      >
        <div className="space-y-1.5">
          {run.board.findings.map((finding) => {
            const author = run.members.find((member) => member.id === finding.authorAgentId);
            return (
              <div key={finding.id} className="rounded border px-2 py-2" style={{ borderColor: finding.status === "challenged" ? "var(--color-warning)" : "var(--border-soft)", background: "var(--bg-subtle)" }}>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-xs font-medium">{finding.claim}</span>
                  <TeamStatusBadge label={finding.status} tone={finding.status === "accepted" ? "done" : finding.status === "challenged" ? "warn" : finding.status === "rejected" ? "danger" : "muted"} />
                </div>
                <div className="mt-1 text-token-xs" style={{ color: "var(--text-muted)" }}>
                  {author?.name ?? finding.authorAgentId} · confidence {finding.confidence}
                </div>
                {finding.evidenceRefs.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {finding.evidenceRefs.map((ref) => (
                      <span key={ref} className="rounded border px-1.5 py-0.5 text-[10px]" style={{ borderColor: "var(--border-soft)", color: "var(--fg-faint)" }}>
                        {ref}
                      </span>
                    ))}
                  </div>
                ) : null}
                {onCommand ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {finding.status !== "accepted" ? (
                      <button
                        type="button"
                        onClick={() =>
                          onCommand(run.id, {
                            type: "accept_finding",
                            findingId: finding.id,
                            actorAgentId: lead?.id ?? run.leadAgentId,
                          })
                        }
                        className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                        style={{ borderColor: "var(--border-soft)", color: "var(--color-success)" }}
                      >
                        accept
                      </button>
                    ) : null}
                    {finding.status !== "rejected" ? (
                      <button
                        type="button"
                        onClick={() =>
                          onCommand(run.id, {
                            type: "reject_finding",
                            findingId: finding.id,
                            actorAgentId: lead?.id ?? run.leadAgentId,
                          })
                        }
                        className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                        style={{ borderColor: "var(--border-soft)", color: "var(--color-danger)" }}
                      >
                        reject
                      </button>
                    ) : null}
                    {run.settings.allowChallenges ? (
                      <button
                        type="button"
                        onClick={() =>
                          onCommand(run.id, {
                            type: "create_challenge",
                            findingId: finding.id,
                            actorAgentId: lead?.id ?? run.leadAgentId,
                          })
                        }
                        className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                        style={{ borderColor: "var(--border-soft)", color: "var(--color-warning)" }}
                      >
                        challenge
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {run.board.challenges.map((challenge) => {
            const target = run.board.findings.find((finding) => finding.id === challenge.targetFindingId);
            return (
              <div key={challenge.id} className="rounded border px-2 py-2" style={{ borderColor: "var(--color-warning)", background: "var(--bg-subtle)" }}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{challenge.reason}</span>
                  <TeamStatusBadge label={challenge.status} tone={challenge.status === "resolved" || challenge.status === "dismissed" ? "done" : "warn"} />
                </div>
                <div className="mt-1 text-token-xs" style={{ color: "var(--text-muted)" }}>
                  target: {target?.claim ?? challenge.targetFindingId}
                </div>
                {onCommand && (challenge.status === "open" || challenge.status === "needs_evidence") ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        onCommand(run.id, {
                          type: "resolve_challenge",
                          challengeId: challenge.id,
                          actorAgentId: lead?.id ?? run.leadAgentId,
                          resolutionFindingIds: target ? [target.id] : [],
                        })
                      }
                      className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                      style={{ borderColor: "var(--border-soft)", color: "var(--color-success)" }}
                    >
                      resolve
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onCommand(run.id, {
                          type: "dismiss_challenge",
                          challengeId: challenge.id,
                          actorAgentId: lead?.id ?? run.leadAgentId,
                        })
                      }
                      className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                      style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                    >
                      dismiss
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </TeamWorkspaceSection>

      <TeamWorkspaceSection
        title="Decisions"
        summary="Lead 的裁决会把最终结论绑定到发现与挑战。"
        icon={<CheckDecisionIcon />}
      >
        {onCommand && acceptedFindings.length > 0 ? (
          <button
            type="button"
            onClick={() =>
              onCommand(run.id, {
                type: "record_decision",
                title: "Lead synthesis decision",
                rationale: "Accepted findings and resolved challenges support this synthesis.",
                madeByAgentId: lead?.id ?? run.leadAgentId,
                acceptedFindingIds: acceptedFindings.map((finding) => finding.id),
                rejectedFindingIds: run.board.findings
                  .filter((finding) => finding.status === "rejected")
                  .map((finding) => finding.id),
                challengeIds: resolvedChallenges.map((challenge) => challenge.id),
                evidenceRefs: Array.from(
                  new Set(acceptedFindings.flatMap((finding) => finding.evidenceRefs))
                ),
                sourceResultIds: Array.from(
                  new Set(
                    acceptedFindings
                      .map((finding) => finding.sourceResultId)
                      .filter((item): item is string => Boolean(item))
                  )
                ),
              })
            }
            className="mb-2 h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
            style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
          >
            record lead decision
          </button>
        ) : null}
        <div className="space-y-1.5">
          {run.board.decisions.map((decision) => (
            <div key={decision.id} className="rounded border px-2 py-2" style={{ borderColor: "var(--border-soft)", background: "var(--bg-subtle)" }}>
              <div className="text-xs font-medium">{decision.title}</div>
              <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
                {decision.rationale}
              </div>
              <div className="mt-1 text-token-xs" style={{ color: "var(--fg-faint)" }}>
                accepted {decision.acceptedFindingIds.length} · rejected {decision.rejectedFindingIds.length}
              </div>
            </div>
          ))}
        </div>
      </TeamWorkspaceSection>
    </div>
  );
}

function TeamWorkspaceSection({
  title,
  summary,
  icon,
  children,
}: {
  title: string;
  summary: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 rounded border p-2.5" style={{ borderColor: "var(--border-soft)" }}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center" style={{ color: "var(--accent)" }}>
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold">{title}</span>
          <span className="block text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
            {summary}
          </span>
        </span>
      </div>
      {children}
    </section>
  );
}

function TeamMiniStat({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: number;
  tone?: "muted" | "warn";
}) {
  return (
    <div className="rounded border px-2 py-1.5" style={{ borderColor: "var(--border-soft)", background: "var(--bg-subtle)" }}>
      <div className="text-token-xs" style={{ color: tone === "warn" ? "var(--color-warning)" : "var(--text-muted)" }}>
        {label}
      </div>
      <div className="text-token-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function TeamStatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: "muted" | "running" | "done" | "warn" | "danger";
}) {
  const color =
    tone === "running"
      ? "var(--accent)"
      : tone === "done"
        ? "var(--color-success)"
        : tone === "warn"
          ? "var(--color-warning)"
          : tone === "danger"
            ? "var(--color-danger)"
            : "var(--text-muted)";
  return (
    <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px]" style={{ borderColor: "var(--border-soft)", color }}>
      {label}
    </span>
  );
}

function agentTeamStatusText(status: string): string {
  if (status === "running") return "协作中";
  if (status === "paused") return "已暂停";
  if (status === "finalizing") return "综合中";
  if (status === "completed") return "已完成";
  if (status === "aborted") return "已中止";
  if (status === "failed") return "失败";
  return "待确认";
}

function teamTaskStatusText(status: string): string {
  if (status === "pending") return "待认领";
  if (status === "needs_plan") return "待计划审批";
  if (status === "claimed") return "已认领";
  if (status === "running") return "进行中";
  if (status === "blocked") return "阻塞";
  if (status === "completed") return "完成";
  return status;
}

function teamMemberStatusText(status: string): string {
  if (status === "idle") return "空闲";
  if (status === "working") return "工作中";
  if (status === "blocked") return "阻塞";
  if (status === "done") return "完成";
  return status;
}

function CheckDecisionIcon() {
  return <ShieldCheck size={13} />;
}

function OverviewPanel({
  expandedStorageKey,
  progress,
  browserSnapshot,
  cwd,
  stats,
  budgetStatus,
  providerLabel,
  modelLabel,
  thinkingLabel,
  toolsCount,
  pendingFileCount,
  pendingImageCount,
  recommendations,
  onOpenView,
  onOpenTerminal,
}: {
  expandedStorageKey: string;
  progress: AgentProgress | null;
  browserSnapshot: BrowserSnapshot;
  cwd: string;
  stats: StatsSnapshot | null;
  budgetStatus: BudgetStatus;
  providerLabel: string;
  modelLabel: string;
  thinkingLabel: string;
  toolsCount: number;
  pendingFileCount: number;
  pendingImageCount: number;
  recommendations: WorkbenchRecommendation[];
  onOpenView: (view: WorkbenchView) => void;
  onOpenTerminal: () => void;
}) {
  const progressSummary = summarizeProgress(progress);
  const artifacts = progress?.artifacts ?? [];
  const artifactSummary = summarizeArtifacts(artifacts);
  const contextPct =
    stats?.ctxPct != null ? `${(stats.ctxPct * 100).toFixed(1)}%` : "n/a";
  const budgetTriggered = budgetStatus.triggered.length > 0;
  const browserAnnotations = browserSnapshot.annotations ?? [];
  const progressGroups = normalizedGroups(progress);
  const progressSteps = progressGroups.flatMap((group) => group.steps);
  const browserStatus = describeBrowserStatus(browserSnapshot);
  const hasContent: Record<OverviewSectionId, boolean> = {
    progress: progressSteps.length > 0,
    outputs: artifacts.length > 0,
    files: pendingFileCount + pendingImageCount > 0,
    context: toolsCount > 0 || stats?.ctxPct != null || budgetTriggered,
    browser:
      Boolean(browserSnapshot.url) ||
      browserAnnotations.length > 0 ||
      browserSnapshot.status === "busy" ||
      browserSnapshot.status === "error",
  };
  const [expandedPrefs, setExpandedPrefs] = useState<OverviewExpandedPrefs>({
    storageKey: expandedStorageKey,
    overrides: {},
    loaded: false,
  });
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setExpandedPrefs({
          storageKey: expandedStorageKey,
          overrides: loadOverviewExpandedOverrides(expandedStorageKey),
          loaded: true,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [expandedStorageKey]);
  useEffect(() => {
    if (!expandedPrefs.loaded || expandedPrefs.storageKey !== expandedStorageKey) return;
    saveOverviewExpandedOverrides(expandedStorageKey, expandedPrefs.overrides);
  }, [expandedPrefs, expandedStorageKey]);
  const expandedOverrides =
    expandedPrefs.storageKey === expandedStorageKey ? expandedPrefs.overrides : {};
  const expanded: Record<OverviewSectionId, boolean> = {
    progress: expandedOverrides.progress ?? hasContent.progress,
    outputs: expandedOverrides.outputs ?? hasContent.outputs,
    files: expandedOverrides.files ?? hasContent.files,
    context: expandedOverrides.context ?? hasContent.context,
    browser: expandedOverrides.browser ?? hasContent.browser,
  };
  const toggle = (id: OverviewSectionId) => {
    setExpandedPrefs((prev) => ({
      storageKey: expandedStorageKey,
      loaded: prev.storageKey === expandedStorageKey ? prev.loaded : true,
      overrides: {
        ...(prev.storageKey === expandedStorageKey ? prev.overrides : {}),
        [id]: !expanded[id],
      },
    }));
  };

  return (
    // 概览面板根容器 —— 开启 CSS Container Queries，让里面的子组件能
    // 按 workbench 面板自身的宽度响应，而不是跟 viewport。
    // 这里用 inline-style 设 container-type/name，避免给 Tailwind 加插件。
    <div
      className="w-full min-w-0 max-w-full space-y-2 overflow-hidden px-2 py-2"
      style={{
        containerType: "inline-size",
        containerName: "workbench-overview",
      }}
      data-testid="workbench-overview"
    >
      <WorkbenchHomeLauncher
        recommendations={recommendations}
        onOpenView={onOpenView}
        onOpenTerminal={onOpenTerminal}
      />

      <OverviewSection
        id="progress"
        icon={<Clock size={13} />}
        title="进度"
        summary={progressSummary.badge ?? "idle"}
        open={expanded.progress}
        onToggle={() => toggle("progress")}
        actionLabel="详情"
        onAction={() => onOpenView({ type: "progress" })}
      >
        <OverviewLine
          primary={progressSummary.primary}
          secondary={progressSummary.secondary}
          tone={progressSummary.tone}
        />
        {progressSteps.length > 0 ? (
          <div className="divide-y" style={{ borderColor: "var(--border-soft)" }}>
            {progressSteps.slice(0, 4).map((step) => (
              <div
                key={step.id}
                className="py-1.5 first:pt-0 last:pb-0"
                style={{ borderColor: "var(--border-soft)" }}
              >
                <OverviewLine
                  primary={step.title}
                  checked={step.status === "completed"}
                  struck={step.status === "completed"}
                  tone={step.status === "running" ? "running" : step.status === "failed" || step.status === "blocked" ? "error" : undefined}
                />
              </div>
            ))}
          </div>
        ) : null}
      </OverviewSection>

      <OverviewSection
        id="outputs"
        icon={<Boxes size={13} />}
        title="输出"
        summary={artifacts.length > 0 ? String(artifacts.length) : "0"}
        open={expanded.outputs}
        onToggle={() => toggle("outputs")}
        actionLabel="详情"
        onAction={() => onOpenView({ type: "outputs" })}
      >
        <OverviewLine
          primary={`${artifacts.length} 个产物`}
          secondary={artifactSummary || "暂无产物"}
        />
        {artifacts.slice(0, 5).map((artifact) => (
          <OverviewArtifactButton
            key={artifact.id}
            artifact={artifact}
            onOpenView={onOpenView}
          />
        ))}
      </OverviewSection>

      <OverviewSection
        id="files"
        icon={<FolderOpen size={13} />}
        title="文件"
        summary={`${pendingFileCount + pendingImageCount}`}
        open={expanded.files}
        onToggle={() => toggle("files")}
        actionLabel="打开"
        onAction={() => onOpenView({ type: "files" })}
      >
        <OverviewLine
          primary={cwd.split("/").pop() || cwd || "Workspace"}
          secondary={`附件 ${pendingFileCount} · 图片 ${pendingImageCount}`}
        />
      </OverviewSection>

      <OverviewSection
        id="context"
        icon={<FileText size={13} />}
        title="上下文"
        summary={contextPct}
        open={expanded.context}
        onToggle={() => toggle("context")}
        actionLabel="详情"
        onAction={() => onOpenView({ type: "context" })}
      >
        <OverviewLine
          primary={`${modelLabel || providerLabel || "Model"} · ${thinkingLabel}`}
          secondary={`Context ${contextPct} · Tools ${toolsCount}${
            budgetTriggered ? " · Budget hit" : ""
          }`}
          tone={budgetTriggered ? "error" : undefined}
        />
      </OverviewSection>

      <OverviewSection
        id="browser"
        icon={<Globe size={13} />}
        title="浏览器"
        summary={browserStatus.short}
        open={expanded.browser}
        onToggle={() => toggle("browser")}
        actionLabel="打开"
        onAction={() => onOpenView({ type: "browser" })}
      >
        <OverviewLine
          primary={browserSnapshot.title ?? browserStatus.title}
          secondary={
            browserSnapshot.url ??
            `${browserStatus.detail} · ${browserAnnotations.length} annotations`
          }
          tone={browserSnapshot.status === "error" ? "error" : browserSnapshot.status === "busy" ? "running" : undefined}
        />
      </OverviewSection>
    </div>
  );
}

function OverviewSection({
  icon,
  title,
  id,
  summary,
  open,
  actionLabel,
  children,
  onToggle,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  id: OverviewSectionId;
  summary?: string;
  open: boolean;
  actionLabel?: string;
  children: ReactNode;
  onToggle: () => void;
  onAction?: () => void;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section
      className="border-b pb-1.5 last:border-b-0"
      style={{ borderColor: "var(--border-soft)" }}
      data-testid={`workbench-section-${id}`}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-token-xs font-medium hover:bg-[color:var(--bg-hover)]"
          style={{ color: "var(--text-muted)" }}
          aria-expanded={open}
          data-testid={`workbench-section-${id}-toggle`}
        >
          <Chevron size={12} className="shrink-0" />
          <span
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
            style={{ color: "var(--accent)" }}
          >
            {icon}
          </span>
          {/* 标题必须能被压缩，flex-1 使它占位，min-w-0 才能生效 truncate */}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {summary ? (
            // 讯讷：徽章有最大宽限制，极窄时自身也 truncate，不再跳出表格。
            <span
              className="max-w-[40%] shrink truncate rounded px-1.5 py-0.5 text-token-xs"
              style={{ background: "var(--bg-selected)", color: "var(--text-muted)" }}
              title={summary}
            >
              {summary}
            </span>
          ) : null}
        </button>
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="shrink-0 rounded px-1.5 py-0.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
            style={{ color: "var(--text-muted)" }}
            data-testid={`workbench-section-${id}-action`}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
      {/* 窄态下取消 pl-7 缩进，避免内容区被压到 < 200px。
          宽态（workbench 面板 ≥ 380px）保留缩进以对齐标题。 */}
      {open ? (
        <div
          className="mt-1 space-y-1 pl-1 [@container_workbench-overview_(min-width:380px)]:pl-7"
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

function OverviewLine({
  primary,
  secondary,
  checked,
  struck,
  tone,
}: {
  primary: string;
  secondary?: string;
  checked?: boolean;
  struck?: boolean;
  tone?: "running" | "done" | "error";
}) {
  const color =
    tone === "error"
      ? "var(--color-danger)"
      : tone === "running"
        ? "var(--color-warning)"
        : tone === "done"
          ? "var(--color-success)"
          : "var(--text-muted)";
  const checkColor = checked ? "var(--color-success)" : "var(--border-soft)";
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-xs">
      {checked != null ? (
        <span
          className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: checkColor }}
        />
      ) : null}
      <span className="min-w-0 flex-1">
        <span
          className="block truncate"
          title={primary}
          style={{
            color: struck ? "var(--text-muted)" : "var(--text)",
            textDecoration: struck ? "line-through" : undefined,
            textDecorationColor: "var(--text-muted)",
          }}
        >
          {primary}
        </span>
        {secondary ? (
          <span className="block truncate text-token-xs" title={secondary} style={{ color }}>
            {secondary}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function OverviewArtifactButton({
  artifact,
  onOpenView,
}: {
  artifact: ProgressArtifact;
  onOpenView: (view: WorkbenchView) => void;
}) {
  const target = artifactTarget(artifact);
  const label = artifact.title || artifact.href || artifact.summary || "未命名产物";
  if (!target) {
    return (
      <span
        className="block w-full truncate rounded px-1 py-0.5 text-left text-xs"
        style={{ color: "var(--text-muted)" }}
        title={artifact.summary ?? "这个产物没有可打开的 URL 或文件路径"}
      >
        ▣ {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        if (target.type === "browser") onOpenView({ type: "browser", url: target.url });
        else onOpenView({ type: "files", path: target.path });
      }}
      className="block w-full truncate rounded px-1 py-0.5 text-left text-xs hover:bg-[color:var(--bg-hover)]"
      style={{ color: "var(--text)" }}
      title={target.type === "browser" ? target.url : target.path}
    >
      {target.type === "browser" ? "◎" : "▣"} {label}
    </button>
  );
}

function ProgressDetail({
  progress,
  onOpenUrl,
}: {
  progress: AgentProgress | null;
  onOpenUrl?: (url: string) => void;
}) {
  const groups = progress?.groups ?? [];
  const steps = progress?.steps ?? [];
  const artifacts = progress?.artifacts ?? [];
  return (
    <div className="p-2.5" data-testid="workbench-progress-detail">
      <ProgressPopover progress={progress} onOpenUrl={onOpenUrl} />
      {!progress || (groups.length === 0 && steps.length === 0 && artifacts.length === 0) ? (
        <EmptyDetail title="暂无进度" body="agent 调用 update_progress 后，当前任务进度会显示在这里。" />
      ) : null}
    </div>
  );
}

function OutputsDetail({
  artifacts,
  onOpenView,
}: {
  artifacts: ProgressArtifact[];
  onOpenView: (view: WorkbenchView) => void;
}) {
  if (artifacts.length === 0) {
    return (
      <div className="p-2.5" data-testid="workbench-outputs-detail">
        <EmptyDetail title="暂无产物" body="文件、URL、截图、测试和日志产物会汇总到这里。" />
      </div>
    );
  }
  const grouped = artifacts.reduce<Record<string, ProgressArtifact[]>>(
    (acc, artifact) => {
      acc[artifact.kind] = acc[artifact.kind] ?? [];
      acc[artifact.kind].push(artifact);
      return acc;
    },
    {}
  );
  return (
    <div className="space-y-3 p-2.5" data-testid="workbench-outputs-detail">
      {Object.entries(grouped).map(([kind, items]) => (
        <section key={kind} className="space-y-1.5">
          <div
            className="flex items-center gap-2 text-token-xs font-medium"
            style={{ color: "var(--text-muted)" }}
          >
            <span>{artifactKindLabel(kind)}</span>
            <span className="h-px flex-1" style={{ background: "var(--border-soft)" }} />
            <span>{items.length}</span>
          </div>
          {items.map((artifact) => {
            const target = artifactTarget(artifact);
            const canOpen = Boolean(target);
            return (
              <button
                key={artifact.id}
                type="button"
                disabled={!canOpen}
                onClick={() => {
                  if (!target) return;
                  if (target.type === "browser")
                    onOpenView({ type: "browser", url: target.url });
                  else onOpenView({ type: "files", path: target.path });
                }}
                className="block w-full rounded border px-2 py-1.5 text-left hover:bg-[color:var(--bg-hover)] disabled:cursor-default disabled:opacity-65 disabled:hover:bg-transparent"
                style={{ borderColor: "var(--border-soft)", background: "var(--bg-panel-2)" }}
                title={artifact.href ?? artifact.summary ?? "这个产物没有可打开的 URL 或文件路径"}
              >
                <span className="flex items-center gap-2">
                  <FileText size={13} className="shrink-0" style={{ color: "var(--text-muted)" }} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {artifact.title}
                  </span>
                  <span className="shrink-0 text-token-xs" style={{ color: "var(--text-muted)" }}>
                    {target?.type === "browser"
                      ? "打开 Browser"
                      : target?.type === "files"
                        ? "打开 Files"
                        : "无可预览路径"}
                  </span>
                </span>
                {(artifact.href || artifact.summary) && (
                  <span className="mt-0.5 block truncate pl-5 text-token-xs" style={{ color: "var(--text-muted)" }}>
                    {artifact.href ?? artifact.summary}
                  </span>
                )}
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function ContextDetail({
  cwd,
  agentId,
  runtimeIdentity,
  stats,
  budgetStatus,
  providerLabel,
  modelLabel,
  thinkingLabel,
  toolsCount,
  pendingFileCount,
  pendingImageCount,
}: {
  cwd: string;
  agentId: string | null;
  runtimeIdentity: RuntimeIdentity;
  stats: StatsSnapshot | null;
  budgetStatus: BudgetStatus;
  providerLabel: string;
  modelLabel: string;
  thinkingLabel: string;
  toolsCount: number;
  pendingFileCount: number;
  pendingImageCount: number;
}) {
  const rows = [
    ["cwd", cwd || "n/a"],
    ["mode", runtimeIdentity.mode],
    ["sessionId", runtimeIdentity.sessionId ?? "n/a"],
    ["agentId", agentId ?? "n/a"],
    ["browserId", runtimeIdentity.browserId],
    ["provider", providerLabel || "n/a"],
    ["model", modelLabel || "n/a"],
    ["thinking", thinkingLabel],
    ["context", stats?.ctxPct != null ? `${(stats.ctxPct * 100).toFixed(1)}%` : "n/a"],
    ["budget", budgetStatus.triggered.length > 0 ? budgetStatus.triggered.join(", ") : "ok"],
    ["tools", String(toolsCount)],
    ["attachments", `${pendingFileCount} files · ${pendingImageCount} images`],
  ];
  return (
    <div className="space-y-1 p-2.5" data-testid="workbench-context-detail">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="grid grid-cols-[88px_1fr] gap-2 rounded border px-2 py-1.5 text-xs"
          style={{ borderColor: "var(--border-soft)", background: "var(--bg-panel-2)" }}
        >
          <span style={{ color: "var(--text-muted)" }}>{label}</span>
          <span className="min-w-0 truncate" title={value}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyDetail({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="rounded border px-3 py-4 text-xs"
      style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
    >
      <div className="font-medium" style={{ color: "var(--text)" }}>{title}</div>
      <div className="mt-1">{body}</div>
    </div>
  );
}

function loadOverviewExpandedOverrides(
  storageKey: string
): OverviewExpandedOverrides {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: OverviewExpandedOverrides = {};
    for (const id of OVERVIEW_SECTION_IDS) {
      if (typeof parsed[id] === "boolean") out[id] = parsed[id];
    }
    return out;
  } catch {
    return {};
  }
}

function saveOverviewExpandedOverrides(
  storageKey: string,
  value: OverviewExpandedOverrides
) {
  if (typeof window === "undefined") return;
  try {
    const clean: OverviewExpandedOverrides = {};
    for (const id of OVERVIEW_SECTION_IDS) {
      if (typeof value[id] === "boolean") clean[id] = value[id];
    }
    localStorage.setItem(storageKey, JSON.stringify(clean));
  } catch {
    /* noop */
  }
}

export function summarizeProgress(progress: AgentProgress | null) {
  const groups = normalizedGroups(progress);
  const allSteps = groups.flatMap((group) => group.steps);
  const currentGroup = groups.at(-1);
  const currentSteps = currentGroup?.steps ?? [];
  const completed = allSteps.filter((step) => step.status === "completed").length;
  const running = allSteps.find((step) => step.status === "running");
  const failed = allSteps.filter((step) => step.status === "failed").length;
  const blocked = allSteps.filter((step) => step.status === "blocked").length;
  if (allSteps.length === 0) {
    return {
      primary: "暂无进行中的任务",
      secondary: "等待 agent 更新进度",
      badge: undefined,
      tone: undefined,
    };
  }
  const currentCompleted = currentSteps.filter(
    (step) => step.status === "completed"
  ).length;
  return {
    primary: running?.title ?? `${completed}/${allSteps.length} 已完成`,
    secondary: `全部 ${completed}/${allSteps.length} · 当前组 ${
      currentGroup?.index ?? groups.length
    } ${currentCompleted}/${currentSteps.length || 0}${
      failed || blocked ? ` · ${failed + blocked} 个需处理` : ""
    }`,
    badge: `${completed}/${allSteps.length}`,
    tone: failed || blocked ? "error" : running ? "running" : "done",
  } as const;
}

export function normalizedGroups(progress: AgentProgress | null): ProgressGroup[] {
  if (!progress) return [];
  const groups = progress.groups ?? [];
  const steps = progress.steps ?? [];
  if (groups.length > 0) return groups;
  if (steps.length === 0) return [];
  return [
    {
      id: "legacy",
      index: 1,
      steps,
      startedAt: progress.updatedAt,
    },
  ];
}

export function summarizeArtifacts(artifacts: ProgressArtifact[]): string {
  if (artifacts.length === 0) return "";
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    counts.set(artifact.kind, (counts.get(artifact.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => `${kind} ${count}`)
    .join(" · ");
}

function artifactKindLabel(kind: string): string {
  if (kind === "url") return "URLs";
  if (kind === "file") return "Files";
  if (kind === "screenshot") return "Screenshots";
  if (kind === "test") return "Tests";
  if (kind === "diff") return "Diffs";
  if (kind === "log") return "Logs";
  if (kind === "browser") return "Browser";
  return "Other";
}

export function describeBrowserStatus(snapshot: BrowserSnapshot): {
  short: string;
  title: string;
  detail: string;
} {
  if (snapshot.error || snapshot.status === "error") {
    return {
      short: "error",
      title: "浏览器出错",
      detail: snapshot.error ?? "最近一次浏览器操作失败",
    };
  }
  if (snapshot.task?.status === "running" || snapshot.status === "busy") {
    return {
      short: "busy",
      title: "agent 操作中",
      detail: snapshot.task?.intent ?? "agent 正在使用浏览器",
    };
  }
  if (snapshot.status === "ready") {
    return {
      short: "ready",
      title: "浏览器已就绪",
      detail: "可查看页面、验收证据或接管操作",
    };
  }
  if (snapshot.status === "launching") {
    return {
      short: "starting",
      title: "浏览器启动中",
      detail: "正在连接浏览器 workspace",
    };
  }
  if (snapshot.status === "closed") {
    return {
      short: "closed",
      title: "浏览器已关闭",
      detail: "打开 Browser 后可重新连接",
    };
  }
  return {
    short: "idle",
    title: "浏览器空闲",
    detail: "等待 agent 或用户打开页面",
  };
}

function viewTitle(type: WorkbenchView["type"]) {
  if (type === "overview") return "Overview";
  if (type === "progress") return "Progress";
  if (type === "outputs") return "Outputs";
  if (type === "files") return "Files";
  if (type === "context") return "Context";
  if (type === "team") return "Team";
  return "Browser";
}

function homeTab(): WorkbenchTab {
  return {
    id: "home",
    kind: "home",
    title: "概览",
    subtitle: "Overview",
    closable: false,
  };
}

function terminalTab(): WorkbenchTab {
  return {
    id: "terminal",
    kind: "terminal",
    title: "终端",
    subtitle: "任务启动器",
    closable: true,
  };
}

function sidechatTab(): WorkbenchTab {
  return {
    id: "sidechat",
    kind: "sidechat",
    title: "侧边聊天",
    subtitle: "即将支持",
    closable: true,
  };
}

export function tabFromView(view: WorkbenchView): WorkbenchTab {
  if (view.type === "overview") return homeTab();
  if (view.type === "progress") {
    return {
      id: "progress",
      kind: "progress",
      title: "进度",
      subtitle: "Progress",
      closable: true,
    };
  }
  if (view.type === "outputs") {
    return {
      id: "outputs",
      kind: "outputs",
      title: "输出",
      subtitle: "Outputs",
      closable: true,
    };
  }
  if (view.type === "files") {
    const title = view.path ? basename(view.path) : "打开文件";
    return {
      id: view.path ? `files:${view.path}` : "files",
      kind: "files",
      title,
      subtitle: view.path ?? "Files",
      path: view.path,
      closable: true,
    };
  }
  if (view.type === "context") {
    return {
      id: "context",
      kind: "context",
      title: "上下文",
      subtitle: "Context",
      closable: true,
    };
  }
  if (view.type === "team") {
    return {
      id: view.teamId ? `team:${view.teamId}` : "team",
      kind: "team",
      title: "Team",
      subtitle: view.teamId ?? "共享白板",
      teamId: view.teamId,
      closable: true,
    };
  }
  const url = view.url?.trim();
  return {
    id: url ? `browser:${url}` : "browser:launcher",
    kind: "browser",
    title: url ? browserTabTitle(url) : "浏览器",
    subtitle: url ?? "选择本地项目",
    url,
    closable: true,
  };
}

export function viewFromTab(tab: WorkbenchTab): WorkbenchView {
  if (tab.kind === "home") return { type: "overview" };
  if (tab.kind === "progress") return { type: "progress" };
  if (tab.kind === "outputs") return { type: "outputs" };
  if (tab.kind === "files") return { type: "files", path: tab.path };
  if (tab.kind === "context") return { type: "context" };
  if (tab.kind === "browser") return { type: "browser", url: tab.url };
  if (tab.kind === "team") return { type: "team", teamId: tab.teamId };
  return { type: "overview" };
}

export function upsertWorkbenchTab(tabs: WorkbenchTab[], tab: WorkbenchTab): WorkbenchTab[] {
  if (tab.id === "home") {
    return tabs.some((item) => item.id === "home") ? tabs : [homeTab(), ...tabs];
  }
  const withHome = tabs.some((item) => item.id === "home") ? tabs : [homeTab(), ...tabs];
  const index = withHome.findIndex((item) => item.id === tab.id);
  if (index >= 0) {
    return withHome.map((item, itemIndex) => (itemIndex === index ? { ...item, ...tab } : item));
  }
  return [...withHome, tab];
}

export function loadStoredWorkbenchTabs(storageKey: string): {
  tabs: WorkbenchTab[];
  activeTabId: string;
} {
  const fallbackTabs = [homeTab()];
  if (typeof window === "undefined") {
    return { tabs: fallbackTabs, activeTabId: "home" };
  }
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { tabs: fallbackTabs, activeTabId: "home" };
    const parsed = JSON.parse(raw) as {
      tabs?: Partial<WorkbenchTab>[];
      activeTabId?: string;
    };
    const validTabs =
      parsed.tabs
        ?.map(normalizeStoredTab)
        .filter((tab): tab is WorkbenchTab => Boolean(tab)) ?? [];
    const tabs = validTabs.some((tab) => tab.id === "home")
      ? validTabs
      : [homeTab(), ...validTabs];
    const activeTabId = tabs.some((tab) => tab.id === parsed.activeTabId)
      ? parsed.activeTabId ?? "home"
      : "home";
    return { tabs, activeTabId };
  } catch {
    return { tabs: fallbackTabs, activeTabId: "home" };
  }
}

function normalizeStoredTab(tab: Partial<WorkbenchTab> | null | undefined): WorkbenchTab | null {
  if (!tab?.id || !tab.kind) return null;
  if (!isWorkbenchTabKind(tab.kind)) return null;
  return {
    id: tab.id,
    kind: tab.kind,
    title: tab.kind === "home" ? "概览" : tab.title || viewTitleFromTabKind(tab.kind),
    subtitle: tab.subtitle,
    closable: tab.kind === "home" ? false : tab.closable !== false,
    url: tab.url,
    path: tab.path,
    teamId: tab.teamId,
  };
}

function isWorkbenchTabKind(kind: string): kind is WorkbenchTabKind {
  return [
    "home",
    "progress",
    "outputs",
    "files",
    "context",
    "browser",
    "team",
    "terminal",
    "sidechat",
  ].includes(kind);
}

function viewTitleFromTabKind(kind: WorkbenchTabKind): string {
  if (kind === "home") return "概览";
  if (kind === "terminal") return "终端";
  if (kind === "sidechat") return "侧边聊天";
  return viewTitle(kind);
}

function tabIcon(kind: WorkbenchTabKind) {
  if (kind === "home") return HomeTabIcon;
  if (kind === "progress") return Clock;
  if (kind === "outputs") return Boxes;
  if (kind === "files") return FolderOpen;
  if (kind === "context") return FileText;
  if (kind === "browser") return Globe;
  if (kind === "team") return Network;
  if (kind === "terminal") return Terminal;
  return MessageSquare;
}

function HomeTabIcon({
  size = 13,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M2.5 7.1 8 2.6l5.5 4.5v5.4a1 1 0 0 1-1 1h-2.7V9.1H6.2v4.4H3.5a1 1 0 0 1-1-1V7.1Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="M5.4 4.7V3.2h1.7"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function buildWorkbenchRecommendations({
  cwd,
  artifacts,
  browserSnapshot,
}: {
  cwd: string;
  artifacts: ProgressArtifact[];
  browserSnapshot: BrowserSnapshot;
}): WorkbenchRecommendation[] {
  const recommendations: WorkbenchRecommendation[] = [];
  const seen = new Set<string>();
  const add = (item: WorkbenchRecommendation) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    recommendations.push(item);
  };

  if (browserSnapshot.url && !isCurrentAppRootUrl(browserSnapshot.url)) {
    add({
      id: `url:${browserSnapshot.url}`,
      kind: "url",
      title: browserSnapshot.title || browserTabTitle(browserSnapshot.url),
      subtitle: browserSnapshot.url,
      href: browserSnapshot.url,
    });
  }

  for (const artifact of artifacts) {
    const target = artifactTarget(artifact);
    if (target?.type === "browser" && !isCurrentAppRootUrl(target.url)) {
      add({
        id: `url:${target.url}`,
        kind: "url",
        title: artifact.title || browserTabTitle(target.url),
        subtitle: target.url,
        href: target.url,
      });
    } else if (target?.type === "files") {
      add({
        id: `file:${target.path}`,
        kind: artifact.kind === "file" ? "file" : "output",
        title: artifact.title || basename(target.path),
        subtitle: target.path,
        href: target.path,
      });
    }
  }

  if (cwd) {
    add({
      id: `file:${cwd}/README.md`,
      kind: "file",
      title: "README.md",
      subtitle: `${cwd}/README.md`,
      href: `${cwd}/README.md`,
    });
  }

  return recommendations;
}

function isFileLikeArtifact(kind: ProgressArtifact["kind"]): boolean {
  return ["file", "screenshot", "test", "diff", "log", "browser", "other"].includes(kind);
}

function artifactTarget(
  artifact: ProgressArtifact
):
  | { type: "browser"; url: string }
  | { type: "files"; path: string }
  | null {
  const href = artifact.href?.trim();
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return { type: "browser", url: href };
  if (isFileLikeArtifact(artifact.kind)) {
    const path = filePathFromHref(href);
    if (path) return { type: "files", path };
  }
  return null;
}

function filePathFromHref(href: string): string | null {
  if (href.startsWith("/")) return href;
  if (!href.startsWith("file://")) return null;
  try {
    return decodeURIComponent(new URL(href).pathname);
  } catch {
    return null;
  }
}

function isCurrentAppRootUrl(url: string | null | undefined): boolean {
  if (!url || typeof window === "undefined") return false;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin && parsed.pathname === "/";
  } catch {
    return false;
  }
}

function browserTabTitle(url: string): string {
  try {
    const parsed = new URL(url, typeof window === "undefined" ? "http://localhost" : window.location.href);
    return parsed.host || url;
  } catch {
    return url;
  }
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) || trimmed : trimmed;
}

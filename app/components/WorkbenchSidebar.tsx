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
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  FolderOpen,
  GitBranch,
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
import { getAgentTeamFinalSummary } from "@/lib/agent-team/final-summary";
import { sanitizeAgentTeamObjective, summarizeAgentTeamObjective } from "@/lib/agent-team/objective";
import FileBrowser from "./FileBrowser";
import { BrowserPanel } from "./BrowserPanel";
import { ProgressPopover } from "./ProgressPopover";
import type { FilesLayout } from "./RightPanelContainer";

type AgentTeamEvent = AgentTeamRun["board"]["events"][number];
type TeamRecentEventItem =
  | { kind: "event"; event: AgentTeamEvent }
  | { kind: "member_spawned_group"; id: string; count: number; memberNames: string[] };

export type WorkbenchView =
  | { type: "overview" }
  | { type: "progress" }
  | { type: "outputs" }
  | { type: "files"; path?: string }
  | { type: "context" }
  | { type: "browser"; url?: string }
  | { type: "team"; teamId?: string; memberId?: string };

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
  memberId?: string;
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
  onOpenAgentTeamMember?: (sessionFile: string) => boolean | Promise<boolean>;
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
      | { type: "diagnose_team" }
      | { type: "recover_team" }
      | { type: "repair_result"; resultId: string }
      | { type: "manual_submit_finding"; taskId: string; memberId: string; claim: string; evidenceRefs?: string[]; confidence?: "low" | "medium" | "high" }
      | { type: "skip_task_with_reason"; taskId?: string; reason?: string }
      | { type: "finalize_with_risks"; reason?: string }
      | { type: "summarize_available"; reason?: string }
      | { type: "replace_member"; memberId: string }
      | { type: "merge_worktree"; memberId: string; strategy: "accept" | "discard" | "keep_branch" }
      | { type: "resume" }
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
  }:${"teamId" in view ? view.teamId ?? "" : ""}:${
    "memberId" in view ? view.memberId ?? "" : ""
  }`;
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
  useEffect(() => {
    if (activeTab.kind !== "team") return;
    if (agentTeamRuns.length === 0) return;
    if (activeTab.teamId && agentTeamRuns.some((run) => run.id === activeTab.teamId)) return;
    const nextView: WorkbenchView = { type: "team", teamId: agentTeamRuns[0].id };
    const nextTab = tabFromView(nextView);
    queueMicrotask(() => {
      setTabs((currentTabs) =>
        upsertWorkbenchTab(
          currentTabs.filter((tab) => tab.id !== activeTab.id),
          nextTab
        )
      );
      setActiveTabId(nextTab.id);
      onOpenView(nextView);
    });
  }, [activeTab.id, activeTab.kind, activeTab.teamId, agentTeamRuns, onOpenView]);
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
        className="flex h-full min-h-0 min-w-0 flex-col border-l"
        style={{
          flex: `0 0 ${panelWidth}px`,
          width: panelWidth,
          minWidth: open ? Math.min(minWidth, panelWidth) : 0,
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
              memberId={activeTab.memberId}
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
  memberId,
  onOpenMember,
  onCommand,
}: {
  runs: AgentTeamRun[];
  teamId?: string;
  memberId?: string;
  onOpenMember?: (sessionFile: string) => boolean | Promise<boolean>;
  onCommand?: WorkbenchSidebarProps["onAgentTeamCommand"];
}) {
  const [teamMessage, setTeamMessage] = useState("");
  const [activeTranscriptMemberId, setActiveTranscriptMemberId] = useState<string | null>(null);
  const [recordOpenNotice, setRecordOpenNotice] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [objectiveExpanded, setObjectiveExpanded] = useState(false);
  const [expandedTaskDescriptions, setExpandedTaskDescriptions] = useState<Record<string, boolean>>({});
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const revealTeamItem = useCallback((itemId?: string) => {
    setDetailsOpen(true);
    if (!itemId) return;
    setFocusedItemId(itemId);
    window.setTimeout(() => {
      document
        .querySelector(`[data-agent-team-item="${CSS.escape(itemId)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
  }, []);
  const revealMemberTranscript = useCallback(
    (memberId: string) => {
      setActiveTranscriptMemberId(memberId);
      setRecordOpenNotice(null);
      revealTeamItem(`member-transcript:${memberId}`);
    },
    [revealTeamItem]
  );
  const run =
    runs.find((item) => item.id === teamId) ?? runs[0] ?? null;
  const hasRequestedMember = Boolean(
    memberId && run?.members.some((member) => member.id === memberId)
  );
  useEffect(() => {
    if (!memberId || !hasRequestedMember) return;
    queueMicrotask(() => revealMemberTranscript(memberId));
  }, [hasRequestedMember, memberId, run?.id, revealMemberTranscript]);
  useEffect(() => {
    queueMicrotask(() => setRecordOpenNotice(null));
  }, [activeTranscriptMemberId, run?.id]);
  const now = useAgentTeamClock(Boolean(run && (run.status === "running" || run.status === "finalizing")));
  if (!run) {
    return (
      <div className="p-2.5" data-testid="agent-team-workspace-empty">
        <EmptyDetail
          title="暂无团队协作"
          body="使用 /team 启动后，团队的进展、发现和分歧会在这里汇总。"
        />
      </div>
    );
  }

  const openChallenges = run.board.challenges.filter(
    (challenge) =>
      challenge.status === "open" || challenge.status === "needs_evidence"
  );
  const meaningfulOpenChallenges = openChallenges.filter(
    (challenge) => !isEmptyRiskChallenge(challenge.reason)
  );
  const lead = run.members.find((member) => member.id === run.leadAgentId) ?? run.members[0];
  const blockedTasks = run.board.tasks.filter((task) => task.status === "blocked");
  const activeTranscriptMember = activeTranscriptMemberId
    ? run.members.find((member) => member.id === activeTranscriptMemberId)
    : null;
  const activeTranscriptTask = activeTranscriptMember
    ? run.board.tasks.find((task) =>
        task.ownerAgentId === activeTranscriptMember.id ||
        task.id === activeTranscriptMember.currentTaskId
      ) ?? blockedTasks.find((task) => task.ownerAgentId === activeTranscriptMember.id)
    : null;
  const requiredTasks = run.board.tasks.filter((task) => task.required);
  const completedRequiredCount = requiredTasks.filter(
    (task) => task.status === "completed" && task.completionSource !== "lead_override"
  ).length;
  const unresolvedRequiredCount = Math.max(
    requiredTasks.length - completedRequiredCount,
    0
  );
  const pendingPlans = (run.board.plans ?? []).filter((plan) => plan.status === "submitted");
  const pendingGates = run.board.qualityGates.filter((gate) => {
    if (gate.status === "passed") return false;
    if (run.status === "running") return false;
    return true;
  });
  const worktreeMembers = run.members.filter((member) => member.worktree);
  const failedGate = pendingGates.find((gate) => gate.status === "failed");
  const canSummarizeAvailable =
    run.status === "running" && (blockedTasks.length > 0 || Boolean(failedGate));
  const automation = deriveTeamAutomationSummary(run, now);
  const hydrateMissingMemberIds = run.hydrate?.missingMemberIds ?? [];
  const hydrateMissingMembers = run.members.filter(
    (member) =>
      member.id !== run.leadAgentId &&
      (member.hydrateState === "missing" ||
        member.hydrateState === "replaced" ||
        hydrateMissingMemberIds.includes(member.id))
  );
  const terminalRun =
    run.status === "completed" ||
    run.status === "aborted" ||
    run.status === "failed";
  const finalDecision = run.board.decisions
    .filter((decision) => (decision.status ?? "accepted") === "accepted")
    .at(-1);
  const hasHighConfidenceFinalDecision =
    run.status === "completed" && finalDecision?.confidence === "high";
  const terminalUnresolvedRequiredCount =
    run.status === "completed" && !hasHighConfidenceFinalDecision
      ? unresolvedRequiredCount
      : 0;
  const hasHighConfidenceTerminalShortcut =
    run.status === "completed" &&
    hasHighConfidenceFinalDecision &&
    unresolvedRequiredCount > 0;
  const displayedCompletedRequiredCount = hasHighConfidenceTerminalShortcut
    ? requiredTasks.length
    : completedRequiredCount;
  const hydrateBannerVisible = !terminalRun && hydrateMissingMembers.length > 0;
  const teamCanRequireAttention =
    !terminalRun;
  const completedVisibleTasks = run.board.tasks.filter(
    (task) =>
      task.required &&
      (task.status === "completed" || task.status === "skipped")
  );
  const visibleTasks = run.status === "completed"
    ? completedVisibleTasks.length > 0
      ? completedVisibleTasks
      : run.board.tasks.filter((task) => task.status === "completed" || task.status === "skipped")
    : run.board.tasks;
  const activeTeamTasks = run.board.tasks.filter(
    (task) => task.status === "claimed" || task.status === "running"
  );
  const pendingTeamTasks = run.board.tasks.filter((task) => task.status === "pending");
  const workingMembers = run.members.filter((member) => member.status === "working");
  const teamHasAutomaticWorkInFlight = activeTeamTasks.length > 0 || workingMembers.length > 0;
  const recentlyStarted =
    run.status === "running" &&
    activeTeamTasks.length === 0 &&
    workingMembers.length === 0 &&
    pendingTeamTasks.length > 0 &&
    now - Math.max(run.createdAt ?? 0, run.updatedAt ?? 0) < 30_000;
  const userActionOpenChallenges = teamHasAutomaticWorkInFlight ? [] : meaningfulOpenChallenges;
  const attentionItems = teamCanRequireAttention
    ? buildTeamAttentionItems({
        openChallenges: userActionOpenChallenges,
        blockedTasks,
        pendingPlans,
        pendingGates,
      })
    : [];
  const riskNotes = terminalRun ? buildTerminalTeamRiskNotes(run) : [];
  const recentItems = buildRecentTeamEventItems(
    run,
    [...run.board.events].filter(
      (event) => !(terminalRun && isLateCoordinationRejectionEvent(event))
    ).filter(
      (event) => !(hasHighConfidenceTerminalShortcut && isTerminalShortcutNoiseEvent(event))
    )
  ).slice(0, 5);
  const recentEventLine = recentItems[0]
    ? buildRecentTeamEventItemLine(run, recentItems[0])
    : "";
  const nextStepLineBase = deriveTeamNextStepLine({
    attentionItemsCount: attentionItems.length,
    blockedTasksCount: blockedTasks.length,
    completedRequiredCount,
    unresolvedRequiredCount: terminalUnresolvedRequiredCount,
    openChallengesCount: userActionOpenChallenges.length,
    pendingTasksCount: run.board.tasks.filter((task) => task.status === "pending").length,
    requiredTasksCount: requiredTasks.length,
    runStatus: run.status,
  });
  const pausedProviderAuthFailure =
    run.status === "paused" &&
    blockedTasks.some((task) => isProviderAuthFailure(task.blocker || task.lastError));
  const pausedProviderTemporaryFailure =
    run.status === "paused" &&
    !pausedProviderAuthFailure &&
    blockedTasks.some((task) => isProviderTemporaryFailure(task.blocker || task.lastError));
  const nextStepLine =
    run.status === "paused" && hydrateBannerVisible
      ? "有成员记录需要恢复；点击“恢复成员”后，恢复成功会继续处理。"
      : pausedProviderAuthFailure
        ? "当前模型缺少可用凭证；请切换到已授权模型，或完成授权后再重试。"
        : pausedProviderTemporaryFailure
          ? "成员模型暂时不可用；稍后可以重试自动处理，或切换到更稳定的模型。"
          : nextStepLineBase;
  const showManualNudge =
    run.status === "running" &&
    !recentlyStarted &&
    activeTeamTasks.length === 0 &&
    workingMembers.length === 0 &&
    blockedTasks.length > 0;
  const manualNudgeLabel = "重试自动处理";
  const needsUserDecision =
    userActionOpenChallenges.length > 0 ||
    pendingPlans.length > 0 ||
    pausedProviderAuthFailure;
  const attentionLabel =
    attentionItems.length === 0
      ? "无需你操作"
      : needsUserDecision
        ? pausedProviderAuthFailure
          ? `需要处理 ${attentionItems.length}`
          : `需要确认 ${attentionItems.length}`
        : `可选处理 ${attentionItems.length}`;
  const cleanObjective = sanitizeAgentTeamObjective(run.objective);
  const objectiveText = objectiveExpanded
    ? cleanObjective
    : summarizeAgentTeamObjective(cleanObjective, 96);

  return (
    <div className="space-y-3 p-2.5" data-testid="agent-team-workspace">
      <section className="rounded border p-3" style={{ borderColor: "var(--border-soft)", background: "var(--bg-panel-2)" }}>
        <div className="flex min-w-0 items-start gap-2">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded" style={{ background: "var(--bg-selected)", color: "var(--color-info)" }}>
            <Network size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold">团队协作</span>
              <span className="rounded border px-1.5 py-0.5 text-token-xs" style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}>
                {agentTeamStatusText(run.status)}
              </span>
            </div>
            <div
              className={`mt-1 text-token-xs leading-snug ${objectiveExpanded ? "" : "line-clamp-1"}`}
              style={{ color: "var(--text-muted)" }}
              title={run.objective}
            >
              {objectiveText || "团队协作任务"}
            </div>
            {cleanObjective.length > 96 ? (
              <button
                type="button"
                onClick={() => setObjectiveExpanded((value) => !value)}
                className="mt-1 text-token-xs font-medium hover:underline"
                style={{ color: "var(--accent)" }}
              >
                {objectiveExpanded ? "收起目标" : "展开目标"}
              </button>
            ) : null}
          </div>
        </div>
        {hydrateBannerVisible ? (
          <div
            className="mt-3 rounded border px-2.5 py-2"
            style={{
              borderColor: "var(--color-warning)",
              background: "var(--bg-subtle)",
            }}
            data-testid="agent-team-hydrate-banner"
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold" style={{ color: "var(--color-warning)" }}>
                有 {hydrateMissingMembers.length} 位成员记录需要恢复
              </span>
              {onCommand && run.status !== "completed" && run.status !== "aborted" ? (
                <button
                  type="button"
                  data-testid="agent-team-hydrate-resume"
                  onClick={() => onCommand(run.id, { type: "resume" })}
                  className="ml-auto inline-flex h-6 items-center gap-1 rounded border px-2 text-token-xs hover:bg-[color:var(--bg-hover)]"
                  style={{ borderColor: "var(--color-warning)", color: "var(--color-warning)" }}
                >
                  恢复成员
                </button>
              ) : null}
            </div>
            <div
              className="mt-1 text-token-xs leading-snug"
              style={{ color: "var(--text-muted)" }}
            >
              {run.hydrate?.notes ??
                "点击「恢复成员」会尽量接回成员记录；仍不可用时，可以重新派人或用现有结果总结。"}
            </div>
          </div>
        ) : null}
        <div
          className="mt-3 rounded border px-2.5 py-2"
          style={{
            borderColor: automation.tone === "warn" ? "var(--color-warning)" : "var(--border-soft)",
            background: "var(--bg-subtle)",
          }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">团队状态</span>
            <span className="text-token-xs" style={{ color: "var(--text-muted)" }}>
              {automation.title}
            </span>
          </div>
          {recentEventLine ? (
            <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
              最近：{recentEventLine}
            </div>
          ) : (
            <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
              {automation.body}
            </div>
          )}
          <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
            下一步：{nextStepLine}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-token-xs" style={{ color: "var(--fg-faint)" }}>
            {run.status === "aborted" ? (
              <span>已停止</span>
            ) : hasHighConfidenceTerminalShortcut ? (
              <span>结论已生成</span>
            ) : (
              <>
                <span>关键任务 {displayedCompletedRequiredCount}/{requiredTasks.length}</span>
                {terminalUnresolvedRequiredCount > 0 ? (
                  <>
                    <span>·</span>
                    <span>带风险 {terminalUnresolvedRequiredCount}</span>
                  </>
                ) : null}
              </>
            )}
            <span>·</span>
            <span>{attentionLabel}</span>
          </div>
        </div>
        {onCommand && run.status === "running" ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {showManualNudge ? (
              <button
                type="button"
                onClick={() =>
                  onCommand(run.id, {
                    type: "run_until_idle",
                    maxDispatches: Math.min(5, Math.max(1, run.members.length)),
                    maxRounds: 4,
                  })
                }
                className="inline-flex h-8 items-center gap-1.5 rounded border px-2.5 text-token-xs font-medium hover:bg-[color:var(--bg-hover)]"
                style={{ borderColor: "var(--accent)", color: "var(--text)" }}
              >
                <Network size={13} />
                {manualNudgeLabel}
              </button>
            ) : null}
            {userActionOpenChallenges.length > 0 ? (
              <button
                type="button"
                onClick={() => revealTeamItem(`challenge:${userActionOpenChallenges[0]?.id}`)}
                className="inline-flex h-8 items-center gap-1.5 rounded border px-2.5 text-token-xs font-medium hover:bg-[color:var(--bg-hover)]"
                style={{ borderColor: "var(--color-warning)", color: "var(--color-warning)" }}
              >
                处理需要确认的事
              </button>
            ) : null}
            {canSummarizeAvailable ? (
              <button
                type="button"
                onClick={() =>
                  onCommand(run.id, {
                    type: "summarize_available",
                    reason: "用户选择使用当前已有结果生成最终综合，未完成项作为风险说明保留。",
                  })
                }
                className="inline-flex h-8 items-center gap-1.5 rounded border px-2.5 text-token-xs font-medium hover:bg-[color:var(--bg-hover)]"
                style={{ borderColor: "var(--color-warning)", color: "var(--color-warning)" }}
              >
                <CheckCircle2 size={13} />
                用现有结果总结
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      {attentionItems.length > 0 ? (
        <TeamWorkspaceSection
          title={needsUserDecision ? "需要确认" : "可选处理"}
          summary={
            needsUserDecision
              ? "这些事需要你判断一下；没有需要你处理的事时，这块不会出现。"
              : "团队没能完全自动收束；你可以重试自动处理，也可以用现有结果带风险总结。"
          }
          icon={<ShieldCheck size={13} />}
        >
          <div className="space-y-1.5">
            {attentionItems.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => revealTeamItem(item.targetItemId)}
                className="w-full rounded border px-2 py-2 text-left hover:bg-[color:var(--bg-hover)]"
                style={{ borderColor: item.tone === "warn" ? "var(--color-warning)" : "var(--border-soft)", background: "var(--bg-subtle)" }}
              >
                <div className="text-xs font-medium">{item.title}</div>
                <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
                  {item.body}
                </div>
                <div className="mt-1 text-token-xs font-medium" style={{ color: item.tone === "warn" ? "var(--color-warning)" : "var(--accent)" }}>
                  点击查看位置
                </div>
              </button>
            ))}
          </div>
        </TeamWorkspaceSection>
      ) : null}

      {riskNotes.length > 0 ? (
        <TeamWorkspaceSection
          title="风险提示"
          summary="最终结论里保留的不确定点；没有风险时，这块不会出现。"
          icon={<ShieldCheck size={13} />}
        >
          <div className="space-y-1.5">
            {riskNotes.slice(0, 4).map((note) => (
              <div
                key={note.id}
                className="rounded border px-2 py-2"
                style={{
                  borderColor: "var(--border-soft)",
                  background: "var(--bg-subtle)",
                }}
                data-testid="agent-team-risk-note"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                    {note.title}
                  </span>
                  <TeamStatusBadge label="风险提示" tone="muted" />
                </div>
                <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
                  风险原因：{humanizeTeamText(note.reason)}
                </div>
                {note.remark ? (
                  <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--fg-faint)" }}>
                    备注：{humanizeTeamText(note.remark)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </TeamWorkspaceSection>
      ) : null}

      <TeamWorkspaceSection
        title="成员分工"
        summary="看看有哪些成员参与；点击名字可以打开它的记录。"
        icon={<Users size={13} />}
      >
        <div className="flex flex-wrap gap-1.5">
          {run.members.map((member) => {
            const needsReplace =
              member.hydrateState === "missing" || member.hydrateState === "replaced";
            return (
            <button
              type="button"
              key={member.id}
              onClick={() => {
                revealMemberTranscript(member.id);
              }}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border px-2 py-1.5 text-left hover:bg-[color:var(--bg-hover)]"
              style={{
                borderColor: needsReplace ? "var(--color-warning)" : "var(--border-soft)",
                background: "var(--bg-subtle)",
              }}
              data-agent-team-item={`member:${member.id}`}
              data-testid="agent-team-member-chip"
              title={`${teamMemberDisplayName(member)} · ${member.role}`}
            >
              <span className="max-w-[120px] truncate text-xs font-medium">
                {teamMemberDisplayName(member)}
              </span>
            {!terminalRun ? (
              <TeamStatusBadge
                label={teamMemberStatusText(member.status, run.status)}
                tone={teamMemberStatusTone(member.status, run.status)}
              />
            ) : null}
              {needsReplace ? (
                <TeamStatusBadge
                  label={member.hydrateState === "replaced" ? "会话已重置" : "会话丢失"}
                  tone="warn"
                />
              ) : null}
              {member.sessionFile && onOpenMember ? (
                <ExternalLink size={11} className="shrink-0" style={{ color: "var(--text-muted)" }} />
              ) : null}
            </button>
            );
          })}
        </div>
        {lead && onCommand && !terminalRun ? (
          <div className="mt-2 flex gap-1.5">
            <input
              value={teamMessage}
              onChange={(event) => setTeamMessage(event.target.value)}
              placeholder="告诉整个团队..."
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
              title="发送给团队"
              aria-label="发送给团队"
            >
              <MessageSquare size={13} />
            </button>
          </div>
        ) : null}
      </TeamWorkspaceSection>

      <TeamWorkspaceSection
        title="任务流"
        summary="这里记录团队怎么推进；平时不用看，排查时再展开。"
        icon={<Terminal size={13} />}
        action={
          <button
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            className="inline-flex h-7 items-center gap-1 rounded border px-2 text-token-xs font-medium hover:bg-[color:var(--bg-hover)]"
            style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
          >
            {detailsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {detailsOpen ? "收起" : "展开"}
          </button>
        }
      >
        {detailsOpen ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="text-token-xs font-semibold" style={{ color: "var(--text)" }}>
              最近动作
            </div>
            {recentItems.length === 0 ? (
              <div className="rounded border px-2 py-2 text-token-xs" style={{ borderColor: "var(--border-soft)", background: "var(--bg-subtle)", color: "var(--text-muted)" }}>
                团队开始推进后，这里会显示成员领取任务、提交结果和收敛动作。
              </div>
            ) : (
              recentItems.map((item, index) => {
                if (item.kind === "member_spawned_group") {
                  return (
                    <div
                      key={`${item.id}:${index}`}
                      className="w-full rounded border px-2 py-2 text-left"
                      style={{ borderColor: "var(--border-soft)", background: "var(--bg-subtle)" }}
                      data-agent-team-item={item.id}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">
                          成员记录已准备好
                        </span>
                        <span className="shrink-0 text-token-xs" style={{ color: "var(--text-muted)" }}>
                          {item.count} 位成员
                        </span>
                      </div>
                      <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
                        {item.memberNames.length > 0
                          ? `已准备 ${Array.from(new Set(item.memberNames)).join("、")}，后续会自动安排任务。`
                          : `已准备 ${item.count} 个成员记录，后续会自动安排任务。`}
                      </div>
                    </div>
                  );
                }
                const event = item.event;
                const actor = event.actorAgentId
                  ? run.members.find((member) => member.id === event.actorAgentId)
                  : null;
                const task = event.taskId
                  ? run.board.tasks.find((item) => item.id === event.taskId)
                  : null;
                const targetItemId = event.taskId ? `task:${event.taskId}` : undefined;
                return (
                  <button
                    key={`${event.id}:${index}`}
                    type="button"
                    onClick={() => revealTeamItem(targetItemId)}
                    disabled={!targetItemId}
                    className="w-full rounded border px-2 py-2 text-left hover:bg-[color:var(--bg-hover)] disabled:cursor-default disabled:hover:bg-transparent"
                    style={{ borderColor: "var(--border-soft)", background: "var(--bg-subtle)" }}
                    data-agent-team-item={`event:${event.id}`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {teamEventUserText(event.type)}
                      </span>
                      {actor ? (
                        <span className="shrink-0 text-token-xs" style={{ color: "var(--text-muted)" }}>
                          {teamMemberDisplayName(actor)}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
                      {humanizeTeamText(event.message)}
                    </div>
                    {task ? (
                      <div className="mt-1 text-token-xs" style={{ color: "var(--fg-faint)" }}>
                        关联任务：{humanizeTeamText(task.title)}
                      </div>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>

          <div className="space-y-1.5">
            <div className="text-token-xs font-semibold" style={{ color: "var(--text)" }}>
              关键任务 {displayedCompletedRequiredCount}/{requiredTasks.length}
              {terminalUnresolvedRequiredCount > 0 ? ` · 带风险 ${terminalUnresolvedRequiredCount}` : ""}
            </div>
          {visibleTasks.slice(0, 5).map((task) => {
            const owner = task.ownerAgentId
              ? run.members.find((member) => member.id === task.ownerAgentId)
              : null;
            const taskDescription = compactTeamTaskDescription(
              humanizeTeamText(task.description),
              task.title
            );
            const descriptionExpanded = Boolean(expandedTaskDescriptions[task.id]);
            const canExpandDescription = taskDescription.length > 72;
            return (
              <div
                key={task.id}
                data-agent-team-item={`task:${task.id}`}
                className="rounded border px-2 py-2"
                style={{
                  borderColor:
                    focusedItemId === `task:${task.id}`
                      ? "var(--accent)"
                      : task.status === "blocked" && run.status !== "completed"
                        ? "var(--color-warning)"
                        : "var(--border-soft)",
                  background: "var(--bg-subtle)",
                }}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{task.title}</span>
                  <TeamStatusBadge
                    label={teamTaskUserText(
                      hasHighConfidenceTerminalShortcut ? "completed" : task.status,
                      run.status
                    )}
                    tone={teamTaskStatusTone(
                      hasHighConfidenceTerminalShortcut ? "completed" : task.status,
                      run.status
                    )}
                  />
                </div>
                {taskDescription ? (
                  <>
                    <div
                      className={`mt-1 text-token-xs leading-snug ${descriptionExpanded ? "" : "line-clamp-2"}`}
                      style={{ color: "var(--text-muted)" }}
                    >
                      {taskDescription}
                    </div>
                    {canExpandDescription ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedTaskDescriptions((current) => ({
                            ...current,
                            [task.id]: !current[task.id],
                          }))
                        }
                        className="mt-1 text-token-xs font-medium hover:underline"
                        style={{ color: "var(--accent)" }}
                      >
                        {descriptionExpanded ? "收起" : "展开"}
                      </button>
                    ) : null}
                  </>
                ) : null}
                <div className="mt-1 flex flex-wrap gap-1 text-token-xs" style={{ color: "var(--fg-faint)" }}>
                  <span>
                    {teamTaskOwnerLine(
                      hasHighConfidenceTerminalShortcut ? "completed" : task.status,
                      owner,
                      run.status
                    )}
                  </span>
                  <span>
                    {teamTaskNextStepText(
                      hasHighConfidenceTerminalShortcut ? "completed" : task.status,
                      run.status
                    )}
                  </span>
                </div>
                {lead && onCommand && (task.status === "blocked") ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() => onCommand(run.id, { type: "recover_team" })}
                      className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                      style={{ borderColor: "var(--accent)", color: "var(--text)" }}
                    >
                      自动整理
                    </button>
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
                      让模型重试
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const claim = window.prompt("补充一条可采纳的 finding");
                        if (!claim?.trim()) return;
                        const evidenceInput = window.prompt("证据引用，可选，用逗号分隔，例如 file:lib/agent-team/runtime.ts") ?? "";
                        void onCommand(run.id, {
                          type: "manual_submit_finding",
                          taskId: task.id,
                          memberId: task.ownerAgentId || lead.id,
                          claim: claim.trim(),
                          evidenceRefs: evidenceInput
                            .split(",")
                            .map((item) => item.trim())
                            .filter(Boolean),
                        });
                      }}
                      className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                      style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                    >
                      人工补充发现
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onCommand(run.id, {
                          type: "skip_task_with_reason",
                          taskId: task.id,
                          reason: `用户选择跳过阻塞任务「${task.title}」，使用当前已有结果生成最终综合。`,
                        })
                      }
                      className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                      style={{ borderColor: "var(--color-warning)", color: "var(--color-warning)" }}
                    >
                      跳过并总结
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
          </div>

        </div>
        ) : null}
      </TeamWorkspaceSection>

      {detailsOpen ? (
        <>
      {worktreeMembers.length > 0 ? (
        <TeamWorkspaceSection
          title="独立改动区"
          summary="写入型成员会在独立 worktree 中工作；完成前需要合并、保留或丢弃。"
          icon={<GitBranch size={13} />}
        >
          <div className="space-y-1.5">
            {worktreeMembers.map((member) => {
              const worktree = member.worktree!;
              const actionable =
                worktree.status === "active" || worktree.status === "merge_pending";
              const statusLabel =
                worktree.status === "active"
                  ? "待处理"
                  : worktree.status === "merge_pending"
                    ? "待手动处理"
                    : worktree.status === "merged"
                      ? "已合并"
                      : worktree.status === "cleaned"
                        ? "已清理"
                        : worktree.status === "failed"
                          ? "创建失败"
                          : worktree.status;
              return (
                <div
                  key={`${member.id}:${worktree.id}`}
                  className="rounded border px-2 py-2"
                  style={{
                    borderColor: actionable ? "var(--color-warning)" : "var(--border-soft)",
                    background: "var(--bg-subtle)",
                  }}
                  data-agent-team-item={`worktree:${member.id}`}
                  data-testid="agent-team-worktree-item"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {teamMemberDisplayName(member)}
                    </span>
                    <TeamStatusBadge
                      label={statusLabel}
                      tone={
                        worktree.status === "merged" || worktree.status === "cleaned"
                          ? "done"
                          : worktree.status === "failed" || worktree.status === "merge_pending"
                            ? "warn"
                            : "running"
                      }
                    />
                  </div>
                  <div
                    className="mt-1 truncate font-mono text-[11px]"
                    style={{ color: "var(--fg-faint)" }}
                    title={worktree.path}
                  >
                    {worktree.branchName || worktree.id} · {worktree.path}
                  </div>
                  {worktree.failureReason ? (
                    <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--color-warning)" }}>
                      {worktree.failureReason}
                    </div>
                  ) : null}
                  {onCommand && actionable ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          onCommand(run.id, {
                            type: "merge_worktree",
                            memberId: member.id,
                            strategy: "accept",
                          })
                        }
                        className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                        style={{ borderColor: "var(--accent)", color: "var(--text)" }}
                      >
                        合并
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onCommand(run.id, {
                            type: "merge_worktree",
                            memberId: member.id,
                            strategy: "keep_branch",
                          })
                        }
                        className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                        style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                      >
                        保留
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onCommand(run.id, {
                            type: "merge_worktree",
                            memberId: member.id,
                            strategy: "discard",
                          })
                        }
                        className="h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                        style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}
                      >
                        丢弃
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </TeamWorkspaceSection>
      ) : null}

      {activeTranscriptMember ? (
        <TeamWorkspaceSection
          title="成员记录"
          summary="这是成员会话的摘要，完整记录需要时再打开。"
          icon={<FileText size={13} />}
        >
            <div
              className="rounded border px-2 py-2"
              style={{ borderColor: "var(--color-info)", background: "var(--bg-panel)" }}
              data-agent-team-item={`member-transcript:${activeTranscriptMember.id}`}
              data-testid="agent-team-member-transcript-detail"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs font-semibold">
                  {activeTranscriptMember.name} 的记录
                </span>
                <TeamStatusBadge
                  label={teamMemberStatusText(activeTranscriptMember.status, run.status)}
                  tone={teamMemberStatusTone(activeTranscriptMember.status, run.status)}
                />
              </div>
              <div className="mt-1 text-token-xs" style={{ color: "var(--text-muted)" }}>
                {teamMemberRecordSummary(activeTranscriptMember, run.status)}
              </div>
              {activeTranscriptMember.latestOutput && run.status !== "completed" ? (
                <div className="mt-1 text-token-xs leading-snug" style={{ color: "var(--fg-faint)" }}>
                  {humanizeTeamText(activeTranscriptMember.latestOutput)}
                </div>
              ) : null}
              {activeTranscriptMember.sessionFile && onOpenMember ? (
                <button
                  type="button"
                  onClick={async () => {
                    setRecordOpenNotice(null);
                    const opened = await onOpenMember(activeTranscriptMember.sessionFile!);
                    if (!opened) {
                      setRecordOpenNotice(
                        "完整记录暂时不在会话列表里；已停留在这里展示成员摘要。"
                      );
                    }
                  }}
                  className="mt-2 h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                  style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
                >
                  打开完整记录
                </button>
              ) : null}
              {recordOpenNotice ? (
                <div
                  className="mt-2 rounded border px-2 py-1.5 text-token-xs leading-snug"
                  style={{
                    borderColor: "var(--color-warning)",
                    background: "var(--bg-subtle)",
                    color: "var(--text-muted)",
                  }}
                  data-testid="agent-team-member-record-notice"
                >
                  {recordOpenNotice}
                </div>
              ) : null}
              {activeTranscriptMember.latestOutput &&
              activeTranscriptTask &&
              onCommand &&
              run.status !== "completed" ? (
                <button
                  type="button"
                  onClick={() =>
                    onCommand(run.id, {
                      type: "manual_submit_finding",
                      taskId: activeTranscriptTask.id,
                      memberId: activeTranscriptMember.id,
                      claim: humanizeTeamText(activeTranscriptMember.latestOutput).slice(0, 600),
                      evidenceRefs: activeTranscriptMember.sessionFile
                        ? [`session:${activeTranscriptMember.sessionFile}`]
                        : [],
                    })
                  }
                  className="ml-1 mt-2 h-6 rounded border px-1.5 text-token-xs hover:bg-[color:var(--bg-hover)]"
                  style={{ borderColor: "var(--accent)", color: "var(--text)" }}
                >
                  提交到 Team board
                </button>
              ) : null}
            </div>
        </TeamWorkspaceSection>
      ) : null}

        </>
      ) : null}
    </div>
  );
}

function TeamWorkspaceSection({
  title,
  summary,
  icon,
  action,
  children,
}: {
  title: string;
  summary: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 rounded border p-2.5" style={{ borderColor: "var(--border-soft)" }}>
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center" style={{ color: "var(--accent)" }}>
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold">{title}</span>
          <span className="block text-token-xs leading-snug" style={{ color: "var(--text-muted)" }}>
            {summary}
          </span>
        </span>
        {action ? <span className="ml-7 shrink-0 sm:ml-auto">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

function deriveTeamAutomationSummary(run: AgentTeamRun, now: number): {
  title: string;
  body: string;
  tone: "muted" | "warn";
} {
  const blockedTasks = run.board.tasks.filter((task) => task.status === "blocked");
  const providerAuthFailure = blockedTasks.some((task) =>
    isProviderAuthFailure(task.blocker || task.lastError)
  );
  const providerTemporaryFailure =
    !providerAuthFailure &&
    blockedTasks.some((task) => isProviderTemporaryFailure(task.blocker || task.lastError));
  const requiredTasks = run.board.tasks.filter((task) => task.required);
  const completedRequired = requiredTasks.filter(
    (task) => task.status === "completed" && task.completionSource !== "lead_override"
  );
  const unresolvedRequiredCount = Math.max(requiredTasks.length - completedRequired.length, 0);
  const finalDecision = run.board.decisions
    .filter((decision) => (decision.status ?? "accepted") === "accepted")
    .at(-1);
  const hasHighConfidenceFinalDecision =
    run.status === "completed" && finalDecision?.confidence === "high";
  if (run.status === "completed") {
    if (!hasHighConfidenceFinalDecision && unresolvedRequiredCount > 0) {
      return {
        title: "团队已给出结论",
        body: `最终回答已放到会话里，但有 ${unresolvedRequiredCount} 个关键任务没有完整验证。`,
        tone: "warn",
      };
    }
    return {
      title: "团队已完成",
      body: "团队已经给出最终回答，可以回看判断、证据和过程记录。",
      tone: "muted",
    };
  }
  if (run.status === "aborted") {
    return {
      title: "团队已停止",
      body: "本次团队协作已中止，不会再自动处理。",
      tone: "muted",
    };
  }
  if (run.status === "paused") {
    if (providerAuthFailure) {
      return {
        title: "模型账号未配置",
        body: "成员模型调用失败，当前模型缺少可用凭证。换到已授权模型，或完成授权后再重试。",
        tone: "warn",
      };
    }
    if (providerTemporaryFailure) {
      return {
        title: "模型暂时不可用",
        body: "成员模型调用失败，通常是供应商临时繁忙。稍后可重试自动处理，或切换到更稳定的模型。",
        tone: "warn",
      };
    }
    return {
      title: "团队已暂停",
      body: "暂停期间不会分配新任务；恢复后团队会继续自动处理。",
      tone: "warn",
    };
  }
  const openChallenges = run.board.challenges.filter(
    (challenge) =>
      (challenge.status === "open" || challenge.status === "needs_evidence") &&
      !isEmptyRiskChallenge(challenge.reason)
  );
  const workingTasks = run.board.tasks.filter(
    (task) => task.status === "claimed" || task.status === "running"
  );
  const pendingTasks = run.board.tasks.filter((task) => task.status === "pending");
  if (workingTasks.length > 0) {
    const firstWorking = workingTasks[0];
    const owner = firstWorking.ownerAgentId
      ? run.members.find((member) => member.id === firstWorking.ownerAgentId)
      : null;
    const elapsed = formatAgentTeamElapsed(firstWorking.claimedAt ?? owner?.lastActiveAt, now);
    const elapsedText = elapsed ? `，已运行 ${elapsed}` : "";
    return {
      title: "团队正在自动协作",
      body: `${teamMemberDisplayName(owner ?? { name: "成员" })} 正在处理「${firstWorking.title}」${elapsedText}。你可以先不用操作，等团队收敛出结论。`,
      tone: "muted",
    };
  }
  if (openChallenges.length > 0) {
    return {
      title: "团队遇到一个需要判断的问题",
      body: "负责人会先让模型补证据和对齐分歧；如果仍需要你拍板，这里会只给一个明确问题。",
      tone: "warn",
    };
  }
  if (blockedTasks.length > 0) {
    return {
      title: "团队正在自动处理阻塞",
      body: "有任务在等前置证据或成员结果。负责人会先尝试恢复；如果长时间没动，可以重试自动处理。",
      tone: "warn",
    };
  }
  if (pendingTasks.length > 0) {
    return {
      title: "团队已准备好",
      body: "成员和任务已经就绪，负责人会继续自动安排；你不用手动认领或点击推进。",
      tone: "muted",
    };
  }
  if (requiredTasks.length > 0 && completedRequired.length === requiredTasks.length) {
    return {
      title: "团队可以准备总结",
      body: "关键事项已经处理完，下一步是由负责人形成可追溯的最终综合。",
      tone: "muted",
    };
  }
  return {
    title: "团队会自动处理",
    body: "你只需要提出目标；分工、核对、收敛默认交给模型处理。",
    tone: "muted",
  };
}

function deriveTeamNextStepLine({
  attentionItemsCount,
  blockedTasksCount,
  completedRequiredCount,
  openChallengesCount,
  pendingTasksCount,
  requiredTasksCount,
  unresolvedRequiredCount,
  runStatus,
}: {
  attentionItemsCount: number;
  blockedTasksCount: number;
  completedRequiredCount: number;
  openChallengesCount: number;
  pendingTasksCount: number;
  requiredTasksCount: number;
  unresolvedRequiredCount: number;
  runStatus: AgentTeamRun["status"];
}): string {
  if (runStatus === "completed") {
    if (unresolvedRequiredCount > 0) {
      return "最终回答已放到会话里；有关键任务是带风险收束，可以展开任务流查看原因。";
    }
    return "最终回答已放到会话里；这里只保留过程回看。";
  }
  if (runStatus === "aborted") {
    return "本次协作已停止，不会再自动处理。";
  }
  if (runStatus === "paused") {
    return "团队已暂停；恢复后会继续自动处理，也可以停止或用现有结果总结。";
  }
  if (openChallengesCount > 0) {
    return "负责人会先整理分歧和证据；如果需要你判断，会只给一个明确问题。";
  }
  if (blockedTasksCount > 0) {
    return "团队没能自动收束；可以重试自动处理，或用现有结果带风险总结。";
  }
  if (attentionItemsCount > 0) {
    return "还有事项需要你确认，处理后团队会继续自动协作。";
  }
  if (requiredTasksCount > 0 && completedRequiredCount >= requiredTasksCount) {
    return "关键任务已完成，下一步会把已有发现收敛成最终回答。";
  }
  if (pendingTasksCount > 0) {
    return "负责人会继续自动安排剩余任务；正常情况下不需要你手动推进。";
  }
  return "团队会继续收敛已有发现，并在可以回答时把结论放到会话里。";
}

function useAgentTeamClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function formatAgentTeamElapsed(startedAt: number | undefined, now: number): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return "不到 1 分钟";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function buildTeamAttentionItems({
  openChallenges,
  blockedTasks,
  pendingPlans,
  pendingGates,
}: {
  openChallenges: AgentTeamRun["board"]["challenges"];
  blockedTasks: AgentTeamRun["board"]["tasks"];
  pendingPlans: NonNullable<AgentTeamRun["board"]["plans"]>;
  pendingGates: AgentTeamRun["board"]["qualityGates"];
}): Array<{
  id: string;
  title: string;
  body: string;
  tone: "muted" | "warn";
  targetItemId?: string;
}> {
  const items: Array<{
    id: string;
    title: string;
    body: string;
    tone: "muted" | "warn";
    targetItemId?: string;
  }> = [];
  for (const challenge of openChallenges
    .filter((item) => !isEmptyRiskChallenge(item.reason))
    .slice(0, 2)) {
    items.push({
      id: `challenge:${challenge.id}`,
      title: "有结论需要你确认",
      body: humanizeTeamText(challenge.reason),
      tone: "warn",
      targetItemId: `challenge:${challenge.id}`,
    });
  }
  for (const task of blockedTasks.slice(0, 2)) {
    const blocker = humanizeTeamText(task.blocker || task.description);
    const rawProviderFailure = task.blocker || task.lastError || "";
    const providerAuthFailure = isProviderAuthFailure(rawProviderFailure);
    const providerTemporaryFailure = isProviderTemporaryFailure(rawProviderFailure);
    items.push({
      id: `task:${task.id}`,
      title: providerAuthFailure
        ? "模型账号未配置"
        : providerTemporaryFailure
        ? "模型暂时不可用"
        : blocker.includes("成员结果")
          ? "成员结果待整理"
          : "任务没有自动收束",
      body: providerAuthFailure
        ? "成员模型调用失败，当前模型缺少可用凭证。请切换到已授权模型，或在设置里完成授权后重试。"
        : providerTemporaryFailure
        ? "成员模型调用失败，通常是供应商临时繁忙。可以稍后让系统自动重试。"
        : blocker,
      tone: "warn",
      targetItemId: `task:${task.id}`,
    });
  }
  for (const plan of pendingPlans.slice(0, 2)) {
    items.push({
      id: `plan:${plan.id}`,
      title: "计划等待审批",
      body: plan.body,
      tone: "muted",
      targetItemId: `plan:${plan.id}`,
    });
  }
  const failedGate = pendingGates.find((gate) => gate.status === "failed");
  if (failedGate) {
    items.push({
      id: `gate:${failedGate.id}`,
      title: "结束条件未满足",
      body: failedGate.message,
      tone: "warn",
      targetItemId: `gate:${failedGate.id}`,
    });
  }
  return items.slice(0, 4);
}

function isEmptyRiskChallenge(reason: string | undefined): boolean {
  if (!reason) return false;
  const normalized = reason
    .replace(/\s+/g, "")
    .replace(/[：:;；。.\-]/g, "")
    .toLowerCase();
  return (
    normalized === "risks无" ||
    normalized === "risk无" ||
    normalized === "风险无" ||
    normalized.startsWith("risks无") ||
    normalized.startsWith("risk无") ||
    normalized.startsWith("风险无") ||
    normalized.includes("risks无仅") ||
    normalized.includes("无风险")
  );
}

function isProviderTemporaryFailure(text: string | undefined): boolean {
  if (!text) return false;
  if (isProviderAuthFailure(text)) return false;
  return /529|负载|稍后重试|服务集群|rate limit|quota|用量上限|stream ended|finish_reason|模型连接提前结束/i.test(text);
}

function isProviderAuthFailure(text: string | undefined): boolean {
  if (!text) return false;
  return /No API key|API key|OAuth token|unauthorized|authentication|401|403|鉴权|密钥|凭证|未授权|未配置/i.test(text);
}

function buildTerminalTeamRiskNotes(run: AgentTeamRun): Array<{
  id: string;
  title: string;
  reason: string;
  remark?: string;
}> {
  if (run.status === "aborted") return [];
  const notes: Array<{
    id: string;
    title: string;
    reason: string;
    remark?: string;
  }> = [];
  const finalSummary = getAgentTeamFinalSummary(run);
  if (finalSummary?.risk) {
    notes.push({
      id: "final-summary-risk",
      title: "最终结论带风险",
      reason: finalSummary.risk,
      remark: "结论已经生成，但该风险会影响结果可信度或后续复核优先级。",
    });
  }
  const finalDecision = run.board.decisions
    .filter((decision) => (decision.status ?? "accepted") === "accepted")
    .at(-1);
  const finalSourceResultIds = new Set(finalDecision?.sourceResultIds ?? []);
  const hasHighConfidenceFinalDecision =
    run.status === "completed" && finalDecision?.confidence === "high";
  if (!hasHighConfidenceFinalDecision) {
    for (const reason of (run.blockReasons ?? []).slice(0, 3)) {
      notes.push({
        id: `diagnostic:${reason.code}:${reason.entityRefs.taskId ?? ""}:${reason.entityRefs.memberId ?? ""}:${reason.entityRefs.resultId ?? ""}:${reason.entityRefs.challengeId ?? ""}:${reason.entityRefs.gateId ?? ""}`,
        title: teamBlockReasonTitle(reason.code),
        reason: reason.message,
        remark: `建议：${reason.recommendedAction}`,
      });
    }
  }
  const unresolvedResults = (run.board.results ?? [])
    .filter((result) => result.status === "needs_review")
    .filter((result) => !finalSourceResultIds.has(result.id))
    .filter(() => !hasHighConfidenceFinalDecision)
    .slice(0, 2);
  for (const result of unresolvedResults) {
    const hasInvalidJson = result.parseWarnings.some((warning) =>
      warning.toLowerCase().includes("invalid team_result_json")
    );
    notes.push({
      id: `result:${result.id}`,
      title: "成员结果未完全采纳",
      reason: hasInvalidJson
        ? "成员回复的结构格式不完整，系统已改用后续可采纳结果生成结论。"
        : "成员回复没有整理成可直接采纳的发现。",
      remark: result.parseWarnings.length > 0
        ? "这属于过程噪音；只有影响最终结论时才需要继续处理。"
        : "已作为风险保留，不再阻止本次结论展示。",
    });
  }
  for (const gate of run.board.qualityGates.filter((gate) => gate.status === "failed").slice(0, 2)) {
    notes.push({
      id: `gate:${gate.id}`,
      title: "门禁未完全通过",
      reason: gate.message,
      remark: "协作模式允许带风险收束；严格审计模式下这类问题应继续处理。",
    });
  }
  const unresolvedTasks = run.board.tasks
    .filter((task) => task.status === "blocked" || (!hasHighConfidenceFinalDecision && (task.blocker || task.lastError)))
    .slice(0, 2);
  for (const task of unresolvedTasks) {
    notes.push({
      id: `task:${task.id}`,
      title: "任务有未闭环备注",
      reason: task.blocker || task.lastError || task.description,
      remark: `关联任务：${task.title}`,
    });
  }
  const interruptedMembers = run.members
    .filter((member) =>
      isProviderAuthFailure(member.latestOutput) ||
      isProviderTemporaryFailure(member.latestOutput)
    )
    .slice(0, 2);
  for (const member of interruptedMembers) {
    notes.push({
      id: `member:${member.id}:provider-error`,
      title: "成员执行中断",
      reason: humanizeTeamText(member.latestOutput),
      remark: "团队已尽量用其他成员或已有结果继续收束；这条记录用于说明结论的复核边界。",
    });
  }
  if (run.error) {
    notes.push({
      id: "run-error",
      title: "运行过程中出现异常",
      reason: run.error,
      remark: "最终结论已尽量基于已有结果生成，异常会作为风险保留。",
    });
  }
  const seen = new Set<string>();
  return notes.filter((note) => {
    const key = `${note.title}:${note.reason}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildRecentTeamEventLine(
  run: AgentTeamRun,
  event: AgentTeamRun["board"]["events"][number]
): string {
  const actor = event.actorAgentId
    ? run.members.find((member) => member.id === event.actorAgentId)
    : null;
  const task = event.taskId
    ? run.board.tasks.find((item) => item.id === event.taskId)
    : null;
  const actorName = actor ? teamMemberDisplayName(actor) : "";
  const taskName = task ? humanizeTeamText(task.title) : "";
  if (event.type === "task_claimed" && actorName && taskName) {
    return `${actorName} 已领取「${taskName}」。`;
  }
  if (event.type === "task_completed" && actorName && taskName) {
    return `${actorName} 完成了「${taskName}」。`;
  }
  if (event.type === "member_spawned" && actorName) {
    const target = event.targetAgentId
      ? run.members.find((member) => member.id === event.targetAgentId)
      : null;
    return `${target ? teamMemberDisplayName(target) : "成员"} 的记录已准备好。`;
  }
  if (event.type === "member_replaced" && actorName) {
    return `已重新派 ${actorName} 接手任务。`;
  }
  if (event.type === "team_finalized") {
    return "团队已经完成总结。";
  }
  if (event.type === "quality_gate_failed") {
    return "最终总结暂未通过检查。";
  }
  const pieces = [
    actorName,
    teamEventUserText(event.type),
    taskName ? `「${taskName}」` : "",
  ].filter(Boolean);
  const message = humanizeTeamText(event.message);
  return message ? `${pieces.join(" · ")}：${message}` : pieces.join(" · ");
}

function buildRecentTeamEventItems(
  run: AgentTeamRun,
  events: AgentTeamRun["board"]["events"]
): TeamRecentEventItem[] {
  const visibleEvents = events.filter(isVisibleRecentTeamEvent).reverse();
  const spawned = visibleEvents.filter((event) => event.type === "member_spawned");
  const memberNames = spawned
    .map((event) => event.targetAgentId ? run.members.find((member) => member.id === event.targetAgentId) : null)
    .filter((member): member is NonNullable<typeof member> => Boolean(member))
    .map(teamMemberDisplayName);
  const items: TeamRecentEventItem[] = [];
  let insertedGroup = false;
  for (const event of visibleEvents) {
    if (event.type === "member_spawned") {
      if (!insertedGroup) {
        items.push({
          kind: "member_spawned_group",
          id: "event:member-spawned-group",
          count: spawned.length,
          memberNames,
        });
        insertedGroup = true;
      }
      continue;
    }
    items.push({ kind: "event", event });
  }
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.kind === "member_spawned_group") return true;
    const key = [
      item.event.type,
      item.event.actorAgentId || "",
      item.event.taskId || "",
      humanizeTeamText(item.event.message).toLowerCase(),
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isVisibleRecentTeamEvent(event: AgentTeamEvent): boolean {
  if (
    event.type === "team_created" ||
    event.type === "task_created" ||
    event.type === "member_status_changed" ||
    event.type === "file_lock_acquired" ||
    event.type === "file_lock_released"
  ) {
    return false;
  }
  const message = humanizeTeamText(event.message);
  if (!message && !event.taskId && event.type !== "member_spawned") return false;
  return true;
}

function buildRecentTeamEventItemLine(
  run: AgentTeamRun,
  item: TeamRecentEventItem
): string {
  if (item.kind === "member_spawned_group") {
    const names = item.memberNames.length > 0
      ? `：${Array.from(new Set(item.memberNames)).join("、")}`
      : "";
    return `已准备 ${item.count} 个成员记录${names}，后续会自动安排任务。`;
  }
  return buildRecentTeamEventLine(run, item.event);
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
        ? "var(--accent)"
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

function teamBlockReasonTitle(code: string): string {
  switch (code) {
    case "missing_structured_result":
      return "成员结果待整理";
    case "invalid_result_json":
      return "结构化结果格式错误";
    case "missing_findings":
      return "缺少可采纳发现";
    case "missing_evidence":
      return "缺少证据引用";
    case "placeholder_result":
      return "结果像是模板占位";
    case "member_unavailable":
      return "成员会话不可用";
    case "member_timeout":
      return "成员执行超时";
    case "task_dependency_waiting":
      return "等待前置任务";
    case "open_challenge":
      return "还有分歧未处理";
    case "worktree_pending":
      return "改动区未处理";
    case "provider_stream_error":
      return "模型连接提前结束";
    case "quality_gate_failed":
    default:
      return "结束条件未满足";
  }
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
  if (status === "pending") return "待分配";
  if (status === "needs_plan") return "需确认";
  if (status === "claimed") return "已分配";
  if (status === "running") return "进行中";
  if (status === "blocked") return "需恢复";
  if (status === "completed") return "已完成";
  if (status === "skipped") return "已跳过";
  return status;
}

function teamTaskUserText(status: string, runStatus?: string): string {
  if (runStatus === "completed") {
    if (status === "completed") return "已处理";
    if (status === "skipped") return "已跳过";
    if (status === "blocked") return "已记录风险";
    if (status === "pending") return "已跳过";
    return "已收束";
  }
  if (status === "completed") return "已处理";
  if (status === "skipped") return "已跳过";
  if (status === "running" || status === "claimed") return "处理中";
  if (status === "blocked") return "需恢复";
  if (status === "needs_plan") return "需确认";
  if (status === "pending") return "待分配";
  return teamTaskStatusText(status);
}

function teamTaskNextStepText(status: string, runStatus?: string): string {
  if (runStatus === "completed") {
    return status === "skipped" ? "已作为风险纳入最终结论" : "已纳入最终结论";
  }
  if (status === "completed") return "已经纳入后续判断";
  if (status === "skipped") return "已作为风险归档";
  if (status === "running" || status === "claimed") return "模型会继续收集结果";
  if (status === "blocked") return "会先补齐依赖或重试";
  if (status === "needs_plan") return "负责人会先确认做法";
  if (status === "pending") return "团队会自动分配并继续处理";
  return "";
}

function teamTaskOwnerLine(
  status: string,
  owner: AgentTeamRun["members"][number] | null | undefined,
  runStatus: string
): string {
  if (runStatus === "completed") {
    return owner ? `${teamMemberDisplayName(owner)} 已处理` : "已处理";
  }
  if (status === "pending") return "等待团队自动分配";
  return owner ? `${teamMemberDisplayName(owner)} 处理` : "等待自动分配";
}

function teamMemberStatusText(status: string, runStatus?: string): string {
  if (runStatus === "completed") {
    if (status === "blocked") return "已记录";
    if (status === "working") return "已收束";
    if (status === "done") return "已完成";
    return "已参与";
  }
  if (status === "idle") return "已准备";
  if (status === "working") return "处理中";
  if (status === "blocked") return "需恢复";
  if (status === "done") return "已完成";
  return status;
}

function teamMemberStatusTone(status: string, runStatus?: string): "running" | "warn" | "done" | "muted" {
  if (runStatus === "completed") {
    if (status === "done") return "done";
    return "muted";
  }
  if (status === "working") return "running";
  if (status === "blocked") return "warn";
  if (status === "done") return "done";
  return "muted";
}

function teamTaskStatusTone(status: string, runStatus?: string): "running" | "warn" | "done" | "muted" {
  if (runStatus === "completed") {
    if (status === "completed") return "done";
    return "muted";
  }
  if (status === "completed") return "done";
  if (status === "blocked") return "warn";
  if (status === "running" || status === "claimed") return "running";
  return "muted";
}

function teamMemberRecordSummary(member: AgentTeamRun["members"][number], runStatus?: string): string {
  if (runStatus === "completed") {
    if (member.sessionFile) return "团队已完成；这里保留成员记录，方便需要时回看。";
    return "团队已完成；这个成员没有留下可打开的独立记录。";
  }
  if (member.sessionFile) return "已保存成员会话记录，可以打开完整记录。";
  if (member.latestOutput) return "成员结果已整理到团队记录。";
  if (member.agentId) return "成员会话已创建，等待产生记录。";
  return "暂时没有可展示的成员记录。";
}

function compactTeamTaskDescription(text: string, title: string): string {
  const byTitle: Record<string, string> = {
    "界定问题": "明确本次要确认什么、不能做什么，以及怎样算完成。",
    "定位代码与证据": "查找相关文件，并给出可以核对的证据。",
    "风险与回归挑战": "检查结论是否有漏洞、冲突或需要补测的地方。",
    "验收与回归核查": "确认关键结论是否可靠，并标出仍需复核的路径。",
    "形成可追溯综合": "把已确认的信息整理成最终回答。",
  };
  if (byTitle[title]) return byTitle[title];
  return text
    .replace(/「[^」]{48,}」/g, "本次目标")
    .replace(/“[^”]{48,}”/g, "本次目标")
    .replace(/\s+/g, " ")
    .trim();
}

function teamEventUserText(type: string): string {
  if (type === "team_created") return "团队已创建";
  if (type === "member_spawned") return "成员记录已准备好";
  if (type === "member_status_changed") return "成员状态更新";
  if (type === "task_created") return "任务已创建";
  if (type === "task_claimed") return "任务已分配";
  if (type === "task_blocked") return "任务遇到阻塞";
  if (type === "task_retried") return "任务已重试";
  if (type === "task_unblocked") return "任务恢复推进";
  if (type === "task_completed") return "任务已完成";
  if (type === "result_submitted") return "成员提交结果";
  if (type === "finding_proposed") return "提出发现";
  if (type === "finding_accepted") return "发现已采纳";
  if (type === "finding_rejected") return "发现未采纳";
  if (type === "finding_challenged") return "发现被质疑";
  if (type === "challenge_resolved") return "质疑已解决";
  if (type === "challenge_dismissed") return "质疑已忽略";
  if (type === "plan_submitted") return "计划已提交";
  if (type === "plan_approved") return "计划已批准";
  if (type === "plan_rejected") return "计划未通过";
  if (type === "decision_recorded") return "记录判断";
  if (type === "message_sent") return "团队消息";
  if (type === "member_promoted") return "成员已打开记录";
  if (type === "member_replaced") return "成员已替换";
  if (type === "worktree_created") return "改动区已创建";
  if (type === "worktree_failed") return "改动区处理失败";
  if (type === "worktree_cleaned") return "改动区已清理";
  if (type === "worktree_merged") return "改动区已合并";
  if (type === "file_lock_acquired") return "文件锁已获取";
  if (type === "file_lock_released") return "文件锁已释放";
  if (type === "quality_gate_failed") return "质量门禁未通过";
  if (type === "team_paused") return "团队已暂停";
  if (type === "team_resumed") return "团队已继续";
  if (type === "team_finalized") return "团队已总结";
  if (type === "team_aborted") return "团队已停止";
  return type.replaceAll("_", " ");
}

function isLateCoordinationRejectionEvent(event: AgentTeamRun["board"]["events"][number]): boolean {
  if (event.type !== "result_submitted" && event.type !== "finding_proposed") return false;
  const message = `${event.message ?? ""}`.toLowerCase();
  return (
    message.includes("team run is not running") ||
    message.includes("协调工具拒绝") ||
    message.includes("coordination tool rejected") ||
    message.includes("coordination tool refused")
  );
}

function isTerminalShortcutNoiseEvent(event: AgentTeamRun["board"]["events"][number]): boolean {
  const message = humanizeTeamText(event.message).toLowerCase();
  if (event.type === "quality_gate_failed") return true;
  if (event.type === "team_finalized" && /带风险|risk|现有结果|强制|override/.test(message)) {
    return true;
  }
  if (event.type === "task_completed" && /带风险|risk summary|跳过|skipped|override/.test(message)) {
    return true;
  }
  return false;
}

function teamMemberDisplayName(member: { name: string; role?: string }): string {
  if (member.name === "Lead") return "负责人";
  if (member.name === "Research") return "资料员";
  if (member.name === "Critic") return "质疑者";
  if (member.name === "Synthesis") return "整理者";
  if (member.name === "Validation") return "验收员";
  return member.name || member.role || "成员";
}

function humanizeTeamText(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(
      /Dispatch failed: Member model error: No API key for provider:\s*[^。.\n]+(?:。|\.)?/gi,
      "成员模型调用失败，当前模型缺少可用凭证。"
    )
    .replace(
      /Dispatch failed: Member model error:\s*(?:401|403|unauthorized|authentication failed|OAuth token)[^。.\n]*(?:。|\.)?/gi,
      "成员模型调用失败，当前模型账号未授权或凭证已失效。"
    )
    .replace(
      /Dispatch failed: Member model error: 529[^。.\n]*(?:。|\.)?/g,
      "成员模型调用失败，供应商临时繁忙，可以稍后重试。"
    )
    .replace(
      /Dispatch failed: Member model error:\s*Stream ended without finish_reason\.?/gi,
      "成员模型调用失败，模型连接提前结束，没有返回完成标记。"
    )
    .replace(
      /Stream ended without finish_reason\.?/gi,
      "模型连接提前结束，没有返回完成标记。"
    )
    .replace(/Dispatch failed: Member model error:\s*/g, "成员模型调用失败：")
    .replace(/(.+?) failed and is ready for retry\./g, "「$1」执行失败，可以重试。")
    .replace(/([A-Za-z][A-Za-z0-9_-]*) claimed (.+?)\./g, (_match, member, task) => {
      const name = teamMemberDisplayName({ name: member });
      return `${name} 已领取「${task}」。`;
    })
    .replace(/([A-Za-z][A-Za-z0-9_-]*)(was replaced\.?)/g, "$1 was replaced.")
    .replaceAll("Waiting for dependencies:", "等待前置事项完成：")
    .replaceAll("Waiting for dependencies", "等待前置事项完成")
    .replaceAll("Waiting for structured teammate result.", "等待成员返回结果。")
    .replaceAll("Dispatched via until_idle; waiting for structured teammate result.", "已交给成员处理，等待结果返回。")
    .replaceAll("Dispatched via batch; waiting for structured teammate result.", "已批量交给成员处理，等待结果返回。")
    .replaceAll("Dispatched via single; waiting for structured teammate result.", "已交给成员处理，等待结果返回。")
    .replaceAll("Lead accepted the synthesis result as the resolution for this open challenge.", "负责人已采纳整理结果，这个分歧已作为最终结论的一部分收束。")
    .replace(
      /Team hydrate finished: (\d+) rehydrated, (\d+) missing, (\d+) replaced\./g,
      (_match, rehydrated, missing, replaced) =>
        Number(missing) + Number(replaced) > 0
          ? `已恢复 ${rehydrated} 位成员；还有 ${Number(missing) + Number(replaced)} 位成员记录不可用，需要重新派人或用现有结果总结。`
          : `已恢复 ${rehydrated} 位成员，团队会继续自动处理。`
    )
    .replace(
      /Team hydrate inspected: (\d+) teammate session\(s\) need resume or replacement\./g,
      (_match, missing) => `有 ${missing} 位成员记录需要恢复，恢复前不会继续分配任务。`
    )
    .replaceAll("Replacement teammate session 已创建，等待重新认领任务。", "已重新准备成员记录，等待领取任务。")
    .replaceAll("Teammate session 已创建，等待任务认领。", "成员记录已准备好，等待领取任务。")
    .replaceAll("Teammate session created, waiting for task claim.", "成员记录已准备好，等待领取任务。")
    .replaceAll("Replacement teammate session created, waiting for task claim.", "已重新准备成员记录，等待领取任务。")
    .replaceAll("finalized after all quality gates passed.", "所有检查已通过，团队已完成总结。")
    .replaceAll("Finalize blocked by quality gates.", "最终总结暂未通过检查。")
    .replaceAll("quality gates", "质量检查")
    .replaceAll("quality gate", "质量检查")
    .replaceAll("finalized", "已完成总结")
    .replace(/([A-Za-z][A-Za-z0-9_-]*) was replaced\.?/g, "已重新派成员接替 $1。")
    .replaceAll("required tasks", "关键任务")
    .replaceAll("required task", "关键任务")
    .replaceAll("blocking challenge", "阻塞问题")
    .replaceAll("blocking challenges", "阻塞问题")
    .replaceAll("Teammate session", "成员记录")
    .replaceAll("Agent Team", "团队协作")
    .replaceAll("Team Workspace", "团队协作空间")
    .replace(/\bTeam\b/g, "团队")
    .replace(/团队\s+所有/g, "团队所有")
    .replace(/团队\s+最终/g, "团队最终")
    .replaceAll("Accepted finding:", "已采纳发现：")
    .replaceAll("Accepted findings:", "已采纳发现：")
    .replaceAll("Accepted available 发现:", "已采纳可用发现：")
    .replaceAll("Accepted available finding:", "已采纳可用发现：")
    .replaceAll("completed by lead override.", "已用现有结果完成。")
    .replaceAll("completed by lead override", "已用现有结果完成")
    .replaceAll("accepted findings", "已采纳的发现")
    .replaceAll("accepted finding", "已采纳的发现")
    .replace(/采纳\s+发现/g, "采纳发现")
    .replaceAll("resolved challenges", "已解决的问题")
    .replaceAll("resolved challenge", "已解决的问题")
    .replaceAll("transcript", "记录")
    .replaceAll("sidebar", "侧栏")
    .replaceAll("findings", "发现")
    .replaceAll("finding", "发现")
    .replaceAll("challenges", "问题")
    .replaceAll("challenge", "问题")
    .replaceAll("decision", "判断")
    .replaceAll("accepted", "已采纳")
    .replaceAll("rejected", "未采纳")
    .replaceAll("session", "会话")
    .replace(/文件或\s+会话\s+证据/g, "文件或会话证据")
    .replace(/已采纳\s+发现/g, "已采纳发现")
    .replace(/已解决\s+问题/g, "已解决问题")
    .replace(/已采纳发现\s+和已解决问题/g, "已采纳发现和已解决问题")
    .replace(/最终\s+判断/g, "最终判断")
    .replace(/记录最终\s+判断/g, "记录最终判断")
    .replace(/已解决问题 记录最终判断/g, "已解决问题，记录最终判断")
    .replaceAll("基于已采纳 发现 和已解决 问题 记录最终 判断。", "基于已采纳的发现和已解决的问题，记录最终判断。")
    .replace(/采纳\s+发现/g, "采纳发现");
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
      memberId: view.memberId,
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
  if (tab.kind === "team") return { type: "team", teamId: tab.teamId, memberId: tab.memberId };
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
    memberId: tab.memberId,
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

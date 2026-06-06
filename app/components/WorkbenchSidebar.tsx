"use client";

import type {
  Dispatch,
  MouseEventHandler,
  ReactNode,
  SetStateAction,
} from "react";
import { useState } from "react";
import {
  ArrowLeft,
  Boxes,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  FolderOpen,
  Globe,
  LayoutDashboard,
} from "lucide-react";
import type { BrowserAnnotation, BrowserSnapshot } from "@/lib/browser/types";
import type { BudgetStatus } from "@/lib/budget/types";
import type { RuntimeIdentity } from "@/lib/runtime/identity";
import type { StatsSnapshot } from "@/lib/session-runner";
import type { AgentProgress, ProgressArtifact, ProgressGroup } from "@/lib/progress/types";
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
  | { type: "browser"; url?: string };

export interface WorkbenchSidebarProps {
  open: boolean;
  view: WorkbenchView;
  width: number;
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
}

export function WorkbenchSidebar({
  open,
  view,
  width,
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
}: WorkbenchSidebarProps) {
  if (!open) return null;

  const title = viewTitle(view.type);
  const showBack = view.type !== "overview";

  return (
    <>
      <div
        onMouseDown={onSplitterMouseDown}
        title="拖动调整宽度"
        style={{
          width: 4,
          cursor: "ew-resize",
          background: "var(--border-soft)",
          flexShrink: 0,
          transition: "background 0.12s",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--accent)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--border-soft)";
        }}
      />
      <aside
        className="flex h-full min-h-0 flex-col border-l"
        style={{
          flex: `0 1 ${width}px`,
          minWidth:
            view.type === "files" && filesLayout.viewerHidden && filesLayout.treeCollapsed
              ? 56
              : 320,
          maxWidth: "80vw",
          background: "var(--bg-panel)",
          borderColor: "var(--border)",
          color: "var(--text)",
          transition: "flex-basis 0.16s ease",
        }}
        data-testid="workbench-sidebar"
      >
        <header
          className="flex h-10 shrink-0 items-center gap-2 border-b px-2.5"
          style={{ borderColor: "var(--border-soft)" }}
        >
          {showBack ? (
            <button
              type="button"
              onClick={() => onOpenView({ type: "overview" })}
              className="inline-flex h-7 w-7 items-center justify-center rounded border hover:bg-[color:var(--bg-hover)]"
              style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
              aria-label="返回 Overview"
              title="返回 Overview"
            >
              <ArrowLeft size={14} />
            </button>
          ) : (
            <LayoutDashboard size={15} style={{ color: "var(--accent)" }} />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium">{title}</div>
            <div className="truncate text-[10px]" style={{ color: "var(--text-muted)" }}>
              {runtimeIdentity.mode} · {runtimeIdentity.browserId}
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto">
          {view.type === "overview" && (
            <OverviewPanel
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
              onOpenView={onOpenView}
            />
          )}
          {view.type === "progress" && (
            <ProgressDetail progress={progress} onOpenUrl={onOpenProgressUrl} />
          )}
          {view.type === "outputs" && (
            <OutputsDetail
              artifacts={progress?.artifacts ?? []}
              onOpenView={onOpenView}
            />
          )}
          {view.type === "files" && (
            <div className="h-full min-h-0">
              <FileBrowser
                initialPath={cwd || "/"}
                onClose={() => onOpenView({ type: "overview" })}
                onPickPath={onPickPath}
                onLayoutChange={onFilesLayoutChange}
              />
            </div>
          )}
          {view.type === "context" && (
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
          {view.type === "browser" && (
            <BrowserPanel
              agentId={agentId}
              runtimeIdentity={runtimeIdentity}
              snapshot={browserSnapshot}
              width={width}
              openRequest={browserOpenRequest}
              onClose={() => onOpenView({ type: "overview" })}
              onAnnotate={onAnnotate}
            />
          )}
        </div>
      </aside>
    </>
  );
}

function OverviewPanel({
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
  onOpenView,
}: {
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
  onOpenView: (view: WorkbenchView) => void;
}) {
  const progressSummary = summarizeProgress(progress);
  const artifacts = progress?.artifacts ?? [];
  const artifactSummary = summarizeArtifacts(artifacts);
  const contextPct =
    stats?.ctxPct != null ? `${(stats.ctxPct * 100).toFixed(1)}%` : "n/a";
  const budgetTriggered = budgetStatus.triggered.length > 0;
  const browserAnnotations = browserSnapshot.annotations ?? [];
  const progressGroups = normalizedGroups(progress);
  const progressSteps = progressGroups.at(-1)?.steps ?? [];
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    progress: true,
    outputs: true,
    files: true,
    context: true,
    browser: true,
  });
  const toggle = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="space-y-3 p-2.5" data-testid="workbench-overview">
      <OverviewSection
        id="progress"
        icon={<Clock size={13} />}
        title="进度"
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
        {progressSteps.slice(0, 4).map((step) => (
          <OverviewLine
            key={step.id}
            primary={step.title}
            secondary={step.summary ?? step.status}
            checked={step.status === "completed"}
            tone={step.status === "running" ? "running" : step.status === "failed" || step.status === "blocked" ? "error" : undefined}
          />
        ))}
      </OverviewSection>

      <OverviewSection
        id="outputs"
        icon={<Boxes size={13} />}
        title="输出"
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
          <button
            key={artifact.id}
            type="button"
            onClick={() =>
              artifact.kind === "url" && artifact.href
                ? onOpenView({ type: "browser", url: artifact.href })
                : onOpenView({ type: "files" })
            }
            className="block w-full truncate rounded px-1 py-0.5 text-left text-xs hover:bg-[color:var(--bg-hover)]"
            style={{ color: "var(--text)" }}
            title={artifact.href ?? artifact.summary ?? artifact.title}
          >
            {artifact.kind === "url" ? "◎" : "▣"} {artifact.title || artifact.href || artifact.summary}
          </button>
        ))}
      </OverviewSection>

      <OverviewSection
        id="files"
        icon={<FolderOpen size={13} />}
        title="文件"
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
        open={expanded.browser}
        onToggle={() => toggle("browser")}
        actionLabel="打开"
        onAction={() => onOpenView({ type: "browser" })}
      >
        <OverviewLine
          primary={browserSnapshot.title ?? browserSnapshot.status}
          secondary={
            browserSnapshot.url ??
            `${browserSnapshot.status} · ${browserAnnotations.length} annotations`
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
  open,
  actionLabel,
  children,
  onToggle,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  id: string;
  open: boolean;
  actionLabel?: string;
  children: ReactNode;
  onToggle: () => void;
  onAction?: () => void;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section
      className="border-b pb-2 last:border-b-0"
      style={{ borderColor: "var(--border-soft)" }}
      data-testid={`workbench-section-${id}`}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] font-medium hover:bg-[color:var(--bg-hover)]"
          style={{ color: "var(--text-muted)" }}
          aria-expanded={open}
          data-testid={`workbench-section-${id}-toggle`}
        >
          <Chevron size={12} className="shrink-0" />
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center" style={{ color: "var(--accent)" }}>
            {icon}
          </span>
          <span className="truncate">{title}</span>
        </button>
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="rounded px-1.5 py-0.5 text-[10px] hover:bg-[color:var(--bg-hover)]"
            style={{ color: "var(--text-muted)" }}
            data-testid={`workbench-section-${id}-action`}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
      {open ? <div className="mt-1 space-y-1 pl-7">{children}</div> : null}
    </section>
  );
}

function OverviewLine({
  primary,
  secondary,
  checked,
  tone,
}: {
  primary: string;
  secondary?: string;
  checked?: boolean;
  tone?: "running" | "done" | "error";
}) {
  const color =
    tone === "error" ? "#fca5a5" : tone === "running" ? "#f59e0b" : "var(--text-muted)";
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-xs">
      {checked != null ? (
        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: checked ? "var(--text-muted)" : color }} />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={primary} style={{ color: "var(--text)" }}>
          {primary}
        </span>
        {secondary ? (
          <span className="block truncate text-[11px]" title={secondary} style={{ color }}>
            {secondary}
          </span>
        ) : null}
      </span>
    </div>
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
  return (
    <div className="space-y-1.5 p-2.5" data-testid="workbench-outputs-detail">
      {artifacts.map((artifact) => {
        const isUrl =
          artifact.href?.startsWith("http://") || artifact.href?.startsWith("https://");
        return (
          <button
            key={artifact.id}
            type="button"
            onClick={() => {
              if (isUrl && artifact.href) onOpenView({ type: "browser", url: artifact.href });
              else onOpenView({ type: "files", path: artifact.href });
            }}
            className="flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left hover:bg-[color:var(--bg-hover)]"
            style={{ borderColor: "var(--border-soft)", background: "var(--bg-panel-2)" }}
          >
            <FileText size={13} className="mt-0.5 shrink-0" style={{ color: "var(--text-muted)" }} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{artifact.title}</span>
              <span className="block truncate text-[10px]" style={{ color: "var(--text-muted)" }}>
                {artifact.kind}{artifact.href ? ` · ${artifact.href}` : ""}
              </span>
            </span>
          </button>
        );
      })}
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

function summarizeProgress(progress: AgentProgress | null) {
  const groups = normalizedGroups(progress);
  const steps = groups.at(-1)?.steps ?? [];
  const completed = steps.filter((step) => step.status === "completed").length;
  const running = steps.find((step) => step.status === "running");
  const failed = steps.filter((step) => step.status === "failed").length;
  const blocked = steps.filter((step) => step.status === "blocked").length;
  if (steps.length === 0) {
    return {
      primary: "暂无进行中的任务",
      secondary: "等待 agent 更新进度",
      badge: undefined,
      tone: undefined,
    };
  }
  return {
    primary: running?.title ?? `${completed}/${steps.length} completed`,
    secondary: `任务组 ${groups.at(-1)?.index ?? 1} · ${completed}/${steps.length}${
      failed || blocked ? ` · ${failed + blocked} needs attention` : ""
    }`,
    badge: `${completed}/${steps.length}`,
    tone: failed || blocked ? "error" : running ? "running" : "done",
  } as const;
}

function normalizedGroups(progress: AgentProgress | null): ProgressGroup[] {
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

function summarizeArtifacts(artifacts: ProgressArtifact[]): string {
  if (artifacts.length === 0) return "";
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    counts.set(artifact.kind, (counts.get(artifact.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => `${kind} ${count}`)
    .join(" · ");
}

function viewTitle(type: WorkbenchView["type"]) {
  if (type === "overview") return "Overview";
  if (type === "progress") return "Progress";
  if (type === "outputs") return "Outputs";
  if (type === "files") return "Files";
  if (type === "context") return "Context";
  return "Browser";
}

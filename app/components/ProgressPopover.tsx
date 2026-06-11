"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ExternalLink,
  FileText,
  Globe,
  ListChecks,
  Loader2,
  Monitor,
  XCircle,
} from "lucide-react";
import type {
  AgentProgress,
  ProgressArtifact,
  ProgressGroup,
  ProgressStep,
} from "@/lib/progress/types";

export interface ProgressPopoverProps {
  progress: AgentProgress | null;
  onOpenUrl?: (url: string) => void;
}

export function ProgressPopover({
  progress,
  onOpenUrl,
}: ProgressPopoverProps) {
  // 归一化为分组列表：优先使用 progress.groups；旧数据只有扁平 steps 时，兜底成单个分组。
  const groups = useMemo<ProgressGroup[]>(() => {
    if (!progress) return [];
    const progressGroups = progress.groups ?? [];
    const progressSteps = progress.steps ?? [];
    if (progressGroups.length > 0) return progressGroups;
    if (progressSteps.length > 0) {
      return [
        {
          id: "legacy",
          index: 1,
          steps: progressSteps,
          startedAt: progress.updatedAt,
        },
      ];
    }
    return [];
  }, [progress]);

  const artifacts = progress?.artifacts ?? [];
  const hasArtifacts = artifacts.length > 0;

  if (!progress || (groups.length === 0 && !hasArtifacts)) {
    return null;
  }

  return (
    <div
      className="mb-2 rounded-md border px-3 py-2 text-xs"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        color: "var(--text)",
        overflowAnchor: "none",
      }}
      data-testid="progress-panel"
    >
      {groups.length > 0 && (
        <div className="space-y-2">
          {groups.map((group) => (
            <ProgressGroupBlock
              key={group.id}
              group={group}
              // 默认全部收起，由用户按需点击展开。
              defaultExpanded={false}
              showLabel={groups.length > 1}
            />
          ))}
        </div>
      )}

      {hasArtifacts && (
        <>
          <div
            className="my-2 h-px"
            style={{ background: "var(--border-soft)" }}
          />
          <div className="mb-1.5 font-medium" style={{ color: "var(--text-muted)" }}>
            输出
          </div>
          <div className="flex flex-wrap gap-1.5">
            {artifacts.map((artifact) => (
              <ArtifactChip
                key={artifact.id}
                artifact={artifact}
                onOpenUrl={onOpenUrl}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ProgressGroupBlock({
  group,
  defaultExpanded,
  showLabel,
}: {
  group: ProgressGroup;
  defaultExpanded: boolean;
  showLabel: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const completed = group.steps.filter(
    (step) => step.status === "completed"
  ).length;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded px-1 py-0.5 hover:bg-[color:var(--bg-hover)]"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        data-testid="progress-group-toggle"
      >
        <Chevron size={13} className="shrink-0" style={{ color: "var(--text-muted)" }} />
        <ListChecks size={14} className="shrink-0" style={{ color: "var(--accent)" }} />
        <span className="font-medium">
          {showLabel ? `任务组 ${group.index}` : "进度"}
        </span>
        <span className="ml-auto text-token-xs" style={{ color: "var(--text-muted)" }}>
          {completed}/{group.steps.length}
        </span>
      </button>

      {expanded && group.steps.length > 0 && (
        <div className="mt-1.5 space-y-1.5 pl-1">
          {group.steps.map((step, idx) => (
            // 每组序号从 1 重新开始，不跨组累加。
            <ProgressStepRow key={step.id} step={step} order={idx + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProgressStepRow({ step, order }: { step: ProgressStep; order: number }) {
  const Icon = stepIcon(step.status);
  const tone = stepTone(step.status);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span
        className="mt-0.5 w-4 shrink-0 text-right text-token-xs tabular-nums"
        style={{ color: "var(--text-muted)" }}
      >
        {order}.
      </span>
      <Icon
        size={14}
        className={step.status === "running" ? "mt-0.5 shrink-0 animate-spin" : "mt-0.5 shrink-0"}
        style={{ color: tone }}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium" title={step.title}>
          {step.title}
        </div>
        {step.summary && (
          <div
            className="mt-0.5 line-clamp-2 text-token-xs"
            style={{ color: "var(--text-muted)" }}
            title={step.summary}
          >
            {step.summary}
          </div>
        )}
      </div>
      <span
        className="shrink-0 rounded px-1.5 py-0.5 uppercase"
        style={{ background: "var(--bg-selected)", color: tone }}
      >
        {step.status}
      </span>
    </div>
  );
}

function ArtifactChip({
  artifact,
  onOpenUrl,
}: {
  artifact: ProgressArtifact;
  onOpenUrl?: (url: string) => void;
}) {
  const Icon = artifactIcon(artifact.kind);
  const isUrl = artifact.href?.startsWith("http://") || artifact.href?.startsWith("https://");
  const canOpen = Boolean(artifact.href);
  const content = (
    <>
      <Icon size={13} className="shrink-0" />
      <span className="truncate">{artifact.title}</span>
      {canOpen && <ExternalLink size={12} className="shrink-0 opacity-70" />}
    </>
  );

  if (!canOpen) {
    return (
      <span
        className="inline-flex max-w-[240px] items-center gap-1.5 rounded border px-2 py-1"
        style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
        title={artifact.summary ?? artifact.title}
      >
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="inline-flex max-w-[240px] items-center gap-1.5 rounded border px-2 py-1 hover:bg-[color:var(--bg-hover)]"
      style={{ borderColor: "var(--border-soft)" }}
      title={artifact.summary ?? artifact.href}
      onClick={() => {
        if (isUrl && onOpenUrl) onOpenUrl(artifact.href!);
        else window.open(artifact.href, "_blank", "noopener,noreferrer");
      }}
    >
      {content}
    </button>
  );
}

function stepIcon(status: ProgressStep["status"]) {
  if (status === "completed") return CheckCircle2;
  if (status === "running") return Loader2;
  if (status === "blocked" || status === "failed") return XCircle;
  return Circle;
}

function stepTone(status: ProgressStep["status"]) {
  if (status === "completed") return "var(--color-success)";
  if (status === "running") return "var(--accent)";
  if (status === "blocked" || status === "failed") return "var(--color-danger)";
  return "var(--text-muted)";
}

function artifactIcon(kind: ProgressArtifact["kind"]) {
  if (kind === "url") return Globe;
  if (kind === "browser" || kind === "screenshot") return Monitor;
  return FileText;
}

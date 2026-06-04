"use client";

import {
  CheckCircle2,
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
  if (!progress || (progress.steps.length === 0 && progress.artifacts.length === 0)) {
    return null;
  }

  return (
    <div
      className="mb-2 rounded-md border px-3 py-2 text-xs"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        color: "var(--text)",
      }}
      data-testid="progress-panel"
    >
      <div className="mb-2 flex items-center gap-2">
        <ListChecks size={14} style={{ color: "var(--accent)" }} />
        <span className="font-medium">进度</span>
        <span className="ml-auto text-[11px]" style={{ color: "var(--text-muted)" }}>
          {progress.steps.filter((step) => step.status === "completed").length}/
          {progress.steps.length}
        </span>
      </div>

      {progress.steps.length > 0 && (
        <div className="space-y-1.5">
          {progress.steps.map((step) => (
            <ProgressStepRow key={step.id} step={step} />
          ))}
        </div>
      )}

      {progress.artifacts.length > 0 && (
        <>
          <div
            className="my-2 h-px"
            style={{ background: "var(--border-soft)" }}
          />
          <div className="mb-1.5 font-medium" style={{ color: "var(--text-muted)" }}>
            输出
          </div>
          <div className="flex flex-wrap gap-1.5">
            {progress.artifacts.map((artifact) => (
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

function ProgressStepRow({ step }: { step: ProgressStep }) {
  const Icon = stepIcon(step.status);
  const tone = stepTone(step.status);
  return (
    <div className="flex min-w-0 items-start gap-2">
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
            className="mt-0.5 line-clamp-2 text-[11px]"
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
  if (status === "completed") return "#16a34a";
  if (status === "running") return "var(--accent)";
  if (status === "blocked" || status === "failed") return "#dc2626";
  return "var(--text-muted)";
}

function artifactIcon(kind: ProgressArtifact["kind"]) {
  if (kind === "url") return Globe;
  if (kind === "browser" || kind === "screenshot") return Monitor;
  return FileText;
}

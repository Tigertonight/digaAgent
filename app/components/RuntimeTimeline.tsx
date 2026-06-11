"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  FileText,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import type { EvidenceRef } from "@/lib/evidence/types";
import type { RuntimeEvent, RuntimeEventStatus } from "@/lib/runtime/events";
import { useRuntimeTimeline } from "@/app/hooks/useRuntimeTimeline";

export interface RuntimeTimelineProps {
  agentId: string | null;
  browserId?: string | null;
  enabled: boolean;
}

export function RuntimeTimeline({
  agentId,
  browserId,
  enabled,
}: RuntimeTimelineProps) {
  const { data, loading, error, reload } = useRuntimeTimeline({
    agentId,
    browserId,
    enabled,
  });
  const hasContent = data.events.length > 0 || data.evidence.length > 0;

  if (!enabled || !agentId) return null;

  return (
    <section
      className="border-b px-2.5 py-2"
      style={{ borderColor: "var(--border-soft)" }}
      data-testid="runtime-timeline"
    >
      <div className="mb-1.5 flex items-center gap-2 text-token-xs">
        <CircleDot size={12} style={{ color: "var(--accent)" }} />
        <span className="font-medium" style={{ color: "var(--text)" }}>
          统一事件
        </span>
        <span style={{ color: "var(--fg-faint)" }}>
          {data.events.length} events · {data.evidence.length} evidence
        </span>
        <button
          type="button"
          onClick={() => void reload()}
          className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded hover:bg-[color:var(--bg-hover)]"
          style={{ color: "var(--text-muted)" }}
          title="刷新统一事件"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
        </button>
      </div>

      {error && (
        <div className="mb-1.5 flex items-center gap-1.5 text-token-xs text-[color:var(--color-danger)]">
          <AlertTriangle size={12} />
          {error}
        </div>
      )}

      {!loading && !error && !hasContent && (
        <div className="text-token-xs" style={{ color: "var(--fg-faint)" }}>
          暂无统一事件。agent 使用 browser tools 后，这里会显示跨 browser/progress/approval 的审计记录。
        </div>
      )}

      {hasContent && (
        <div className="grid gap-2 md:grid-cols-2">
          <RuntimeEventList events={data.events.slice(-6).reverse()} />
          <EvidenceList evidence={data.evidence.slice(-6).reverse()} />
        </div>
      )}
    </section>
  );
}

function RuntimeEventList({ events }: { events: RuntimeEvent[] }) {
  return (
    <div>
      <div className="mb-1 text-token-xs font-medium uppercase" style={{ color: "var(--text-muted)" }}>
        Events
      </div>
      <div className="space-y-1">
        {events.map((event) => {
          const tone = statusTone(event.status);
          const Icon = statusIcon(event.status);
          return (
            <div
              key={event.id}
              className="rounded border px-2 py-1"
              style={{ borderColor: "var(--border-soft)", background: "var(--bg-panel-2)" }}
            >
              <div className="flex min-w-0 items-center gap-1.5 text-token-xs">
                <Icon size={12} className="shrink-0" style={{ color: tone }} />
                <span className="shrink-0 rounded px-1 py-0.5 text-token-xs uppercase" style={{ background: "var(--bg-selected)", color: tone }}>
                  {event.source}
                </span>
                <span className="min-w-0 truncate font-medium" title={event.type}>
                  {event.type}
                </span>
                <span className="ml-auto shrink-0 text-token-xs" style={{ color: "var(--fg-faint)" }}>
                  {formatTime(event.createdAt)}
                </span>
              </div>
              {event.evidence && event.evidence.length > 0 && (
                <div className="mt-0.5 truncate text-token-xs" style={{ color: "var(--text-muted)" }}>
                  evidence: {event.evidence.map((item) => item.title).join(", ")}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: EvidenceRef[] }) {
  return (
    <div>
      <div className="mb-1 text-token-xs font-medium uppercase" style={{ color: "var(--text-muted)" }}>
        Evidence
      </div>
      <div className="space-y-1">
        {evidence.map((item) => (
          <div
            key={item.id}
            className="rounded border px-2 py-1"
            style={{ borderColor: "var(--border-soft)", background: "var(--bg-panel-2)" }}
          >
            <div className="flex min-w-0 items-center gap-1.5 text-token-xs">
              <FileText size={12} className="shrink-0" style={{ color: "var(--text-muted)" }} />
              <span className="shrink-0 rounded px-1 py-0.5 text-token-xs uppercase" style={{ background: "var(--bg-selected)", color: "var(--text-muted)" }}>
                {item.kind}
              </span>
              <span className="min-w-0 truncate font-medium" title={item.title}>
                {item.title}
              </span>
            </div>
            {item.textPreview && (
              <div className="mt-0.5 line-clamp-2 text-token-xs" style={{ color: "var(--text-muted)" }}>
                {item.textPreview}
              </div>
            )}
            {(item.url || item.filePath) && (
              <div className="mt-0.5 truncate text-token-xs" style={{ color: "var(--fg-faint)" }}>
                {item.url ?? item.filePath}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function statusIcon(status: RuntimeEventStatus | undefined) {
  if (status === "done") return CheckCircle2;
  if (status === "error" || status === "blocked" || status === "aborted") {
    return XCircle;
  }
  if (status === "running" || status === "queued") return Loader2;
  return CircleDot;
}

function statusTone(status: RuntimeEventStatus | undefined) {
  if (status === "done") return "var(--color-success)";
  if (status === "error" || status === "blocked" || status === "aborted") {
    return "var(--color-danger)";
  }
  if (status === "running" || status === "queued") return "var(--color-warning)";
  return "var(--text-muted)";
}

function formatTime(ms: number) {
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

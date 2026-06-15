"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  FileText,
  Loader2,
  XCircle,
} from "lucide-react";
import type { GoalEvidence, GoalTurn } from "@/lib/goal/types";
import { userFacingMessage } from "@/lib/user-facing-error";

export interface GoalTimelineProps {
  agentId: string;
  /** When false the component renders nothing (collapsed). */
  open: boolean;
}

interface TimelinePayload {
  turns: GoalTurn[];
  evidence: GoalEvidence[];
}

function turnTone(status: GoalTurn["status"]) {
  switch (status) {
    case "completed":
      return { color: "var(--color-success)", Icon: CheckCircle2 };
    case "blocked":
      return { color: "var(--color-danger)", Icon: XCircle };
    case "failed":
      return { color: "var(--color-danger)", Icon: AlertTriangle };
    default:
      return { color: "var(--accent)", Icon: CircleDot };
  }
}

function formatTime(ms?: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return "";
  }
}

function formatDuration(turn: GoalTurn): string {
  if (!turn.endedAt) return "";
  const sec = Math.max(0, Math.round((turn.endedAt - turn.startedAt) / 1000));
  return `${sec}s`;
}

export function GoalTimeline({ agentId, open }: GoalTimelineProps) {
  const [data, setData] = useState<TimelinePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // G4：agentId 变化时丢弃老数据（避免 A 的 timeline 短暂出现在 B 上）会在
  // 下面的 useEffect 中手动重置 — 以 cancelled 模式避免 setState in effect 警告。

  const load = useCallback(async () => {
    if (!agentId) return;
    const aidAtStart = agentId;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/${aidAtStart}?action=goal_timeline`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Partial<TimelinePayload>;
      // 返回后校验 agentId 未变。这个闭包里 agentId 是发起时的，
      // useCallback 重建后老 closure 里仍是老 aidAtStart — 不能仅靠该判断。
      // 用下面的 useEffect 里的 cancelled token 是主要防护。
      setData({
        turns: Array.isArray(json.turns) ? json.turns : [],
        evidence: Array.isArray(json.evidence) ? json.evidence : [],
      });
    } catch (e) {
      setError(userFacingMessage(e));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (!open) return;
    if (!agentId) return;
    // 进 effect 后调一个 microtask：先用 cancelled 跨过同步阶段，避免
    // 在 effect 体里同步 setState。重置 + fetch 全部在微任务里，取消后不再 setState。
    let cancelled = false;
    const aidAtStart = agentId;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setData(null);
      setError(null);
      setLoading(true);
      try {
        const res = await fetch(`/api/agent/${aidAtStart}?action=goal_timeline`);
        if (cancelled) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Partial<TimelinePayload>;
        if (cancelled) return;
        setData({
          turns: Array.isArray(json.turns) ? json.turns : [],
          evidence: Array.isArray(json.evidence) ? json.evidence : [],
        });
      } catch (e) {
        if (cancelled) return;
        setError(userFacingMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, open]);

  if (!open) return null;

  return (
    <div
      className="mt-1 mb-2 rounded-md border px-3 py-2 text-xs"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        color: "var(--text)",
      }}
      data-testid="goal-timeline"
    >
      {loading && (
        <div
          className="flex items-center gap-1.5"
          style={{ color: "var(--text-muted)" }}
        >
          <Loader2 size={12} className="animate-spin" />
          Loading timeline…
        </div>
      )}

      {error && (
        <div
          className="flex items-center gap-1.5"
          style={{ color: "var(--color-danger)" }}
        >
          <AlertTriangle size={12} />
          {error}
          <button
            type="button"
            onClick={() => void load()}
            className="underline hover:opacity-80"
          >
            retry
          </button>
        </div>
      )}

      {!loading && !error && data && (
        <>
          {data.turns.length === 0 && data.evidence.length === 0 && (
            <div style={{ color: "var(--text-muted)" }}>
              No turns or evidence recorded yet.
            </div>
          )}

          {data.turns.length > 0 && (
            <div className="mb-2">
              <div
                className="mb-1 font-medium uppercase tracking-wide text-token-xs"
                style={{ color: "var(--text-muted)" }}
              >
                Turns ({data.turns.length})
              </div>
              <ol className="space-y-1">
                {data.turns.map((turn) => {
                  const { color, Icon } = turnTone(turn.status);
                  return (
                    <li
                      key={turn.turnNumber}
                      className="flex items-start gap-1.5"
                    >
                      <Icon
                        size={12}
                        style={{ color }}
                        className="mt-0.5 shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">#{turn.turnNumber}</span>
                          <span style={{ color }}>{turn.status}</span>
                          <span
                            className="text-token-xs"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {formatTime(turn.startedAt)}
                            {formatDuration(turn)
                              ? ` · ${formatDuration(turn)}`
                              : ""}
                          </span>
                        </div>
                        {turn.summary && (
                          <div
                            className="truncate"
                            title={turn.summary}
                            style={{ color: "var(--text-muted)" }}
                          >
                            {turn.summary}
                          </div>
                        )}
                        {turn.blockedReason && (
                          <div
                            className="truncate"
                            title={turn.blockedReason}
                            style={{ color: "var(--color-danger)" }}
                          >
                            blocked: {turn.blockedReason}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {data.evidence.length > 0 && (
            <div>
              <div
                className="mb-1 font-medium uppercase tracking-wide text-token-xs"
                style={{ color: "var(--text-muted)" }}
              >
                Evidence ({data.evidence.length})
              </div>
              <ul className="space-y-1">
                {data.evidence.map((ev) => (
                  <li key={ev.id} className="flex items-start gap-1.5">
                    <FileText
                      size={12}
                      className="mt-0.5 shrink-0"
                      style={{ color: "var(--text-muted)" }}
                    />
                    <div className="min-w-0 flex-1">
                      <span
                        className="mr-1 rounded-token-sm px-1 py-0.5 text-token-xs uppercase"
                        style={{
                          background: "var(--bg-selected)",
                          color: "var(--text-muted)",
                        }}
                      >
                        {ev.kind}
                      </span>
                      {ev.href ? (
                        <a
                          href={ev.href}
                          target="_blank"
                          rel="noreferrer"
                          className="underline hover:opacity-80"
                          title={ev.href}
                        >
                          {ev.title}
                        </a>
                      ) : (
                        <span title={ev.summary ?? ev.title}>{ev.title}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Pause,
  Play,
  Target,
  Trash2,
  XCircle,
} from "lucide-react";
import type { AgentGoal } from "@/lib/goal/types";
import {
  GOAL_ACCEPTANCE_STATUS_LABELS,
  GOAL_BLOCKED_CATEGORY_LABELS,
  goalAcceptanceSummary,
  goalStatusLabel,
} from "@/lib/goal/labels";
import { GoalTimeline } from "./GoalTimeline";
import { UiFaultBoundary } from "./UiFaultBoundary";

export interface GoalBarProps {
  goal: AgentGoal | null;
  agentId?: string | null;
  disabled?: boolean;
  onPause: () => Promise<void> | void;
  onResume: () => Promise<void> | void;
  onClear: () => Promise<void> | void;
}

function statusTone(goal: AgentGoal) {
  if (goal.status === "complete")
    return { color: "var(--color-success)", icon: CheckCircle2 };
  if (goal.status === "blocked")
    return { color: "var(--color-danger)", icon: XCircle };
  if (goal.status === "paused")
    return { color: "var(--color-warning)", icon: Pause };
  return { color: "var(--accent)", icon: Target };
}

export function GoalBar({
  goal,
  agentId,
  disabled,
  onPause,
  onResume,
  onClear,
}: GoalBarProps) {
  const [expanded, setExpanded] = useState(false);

  if (!goal) return null;
  const tone = statusTone(goal);
  const StatusIcon = tone.icon;
  const canPause = goal.status === "active";
  const canResume = goal.status === "paused" || goal.status === "blocked";
  const blocked = goal.blockedState;

  return (
    <div className="mb-2">
      <div
        className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs"
        style={{
          background: "var(--bg-panel)",
          borderColor: "var(--border)",
          color: "var(--text)",
        }}
        role="status"
        data-testid="goal-bar"
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[color:var(--bg-hover)]"
          title={expanded ? "Hide timeline" : "Show timeline"}
          aria-label={expanded ? "Hide goal timeline" : "Show goal timeline"}
          aria-expanded={expanded}
          data-testid="goal-timeline-toggle"
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <StatusIcon size={14} style={{ color: tone.color }} className="shrink-0" />
        <span
          className="shrink-0 rounded px-1.5 py-0.5 tracking-normal"
          style={{ background: "var(--bg-selected)", color: tone.color }}
        >
          {goalStatusLabel(goal)}
        </span>
        <span className="min-w-0 flex-1 truncate" title={goal.objective}>
          {goal.objective}
        </span>
        <span className="hidden shrink-0 text-token-xs sm:inline" style={{ color: "var(--text-muted)" }}>
          {goalAcceptanceSummary(goal.acceptanceCriteria)}
        </span>
        <span className="shrink-0 text-token-xs" style={{ color: "var(--text-muted)" }}>
          {goal.turns} 轮
        </span>
        {canPause && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void onPause()}
            className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
            title="Pause goal"
            aria-label="Pause goal"
          >
            <Pause size={13} />
          </button>
        )}
        {canResume && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void onResume()}
            className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
            title="继续目标"
            aria-label="继续目标"
          >
            <Play size={13} />
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={() => void onClear()}
          className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
          title="Clear goal"
          aria-label="Clear goal"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Structured blocked detail: category + concrete unblock action. */}
      {blocked && goal.status === "blocked" && !blocked.resolvedAt && (
        <div
          className="mt-1 rounded-token border px-2.5 py-1.5 text-token-xs"
          style={{
            background: "var(--color-danger-bg)",
            borderColor: "var(--color-danger)",
            color: "var(--color-danger)",
          }}
          data-testid="goal-blocked-detail"
        >
          <div className="flex items-center gap-1.5">
            <XCircle size={12} className="shrink-0" />
            <span className="font-medium uppercase tracking-wide">
              {GOAL_BLOCKED_CATEGORY_LABELS[blocked.category]}
            </span>
            {blocked.repeatedCount > 1 && (
              <span
                className="rounded-token-sm px-1 py-0.5 text-token-xs"
                style={{ background: "var(--color-danger-bg)" }}
              >
                ×{blocked.repeatedCount}
              </span>
            )}
          </div>
          <div className="mt-0.5">{blocked.unblockAction}</div>
          {blocked.reason && (
            <div className="mt-0.5 opacity-80" title={blocked.reason}>
              {blocked.reason}
            </div>
          )}
        </div>
      )}

      {expanded && (
        <GoalAcceptancePanel goal={goal} />
      )}

      {agentId && (
        <UiFaultBoundary
          surface="GoalTimeline"
          fallbackTitle="目标时间线异常，已隔离该模块"
        >
          <GoalTimeline agentId={agentId} open={expanded} />
        </UiFaultBoundary>
      )}
    </div>
  );
}

function GoalAcceptancePanel({ goal }: { goal: AgentGoal }) {
  const criteria = goal.acceptanceCriteria ?? [];
  return (
    <div
      className="mt-1 rounded-md border px-3 py-2 text-xs"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        color: "var(--text)",
      }}
      data-testid="goal-acceptance-panel"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-medium">验收标准</span>
        <span style={{ color: "var(--text-muted)" }}>
          {goalAcceptanceSummary(criteria)}
        </span>
      </div>
      {criteria.length === 0 ? (
        <div style={{ color: "var(--text-muted)" }}>
          该 goal 未定义验收标准。
        </div>
      ) : (
        <ul className="space-y-1">
          {criteria.map((criterion) => {
            const met = criterion.status === "met";
            const failed = criterion.status === "failed";
            const Icon = met ? CheckCircle2 : failed ? XCircle : Target;
            const color = met
              ? "var(--color-success)"
              : failed
                ? "var(--color-danger)"
                : "var(--text-muted)";
            return (
              <li key={criterion.id} className="flex items-start gap-2">
                <Icon size={12} className="mt-0.5 shrink-0" style={{ color }} />
                <div className="min-w-0 flex-1">
                  <div
                    className={met ? "line-through" : undefined}
                    style={{
                      color: met ? "var(--text-muted)" : "var(--text)",
                      opacity: met ? 0.72 : 1,
                    }}
                    title={criterion.criterion}
                  >
                    {criterion.criterion}
                  </div>
                  <div className="text-token-xs" style={{ color }}>
                    {GOAL_ACCEPTANCE_STATUS_LABELS[criterion.status]}
                    {criterion.evidence ? ` · ${criterion.evidence}` : ""}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

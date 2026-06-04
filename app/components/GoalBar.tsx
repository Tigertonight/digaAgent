"use client";

import { CheckCircle2, Pause, Play, Target, Trash2, XCircle } from "lucide-react";
import type { AgentGoal } from "@/lib/goal/types";

export interface GoalBarProps {
  goal: AgentGoal | null;
  disabled?: boolean;
  onPause: () => Promise<void> | void;
  onResume: () => Promise<void> | void;
  onClear: () => Promise<void> | void;
}

function statusTone(goal: AgentGoal) {
  if (goal.status === "complete") return { color: "#16a34a", icon: CheckCircle2 };
  if (goal.status === "blocked") return { color: "#dc2626", icon: XCircle };
  if (goal.status === "paused") return { color: "#ca8a04", icon: Pause };
  return { color: "var(--accent)", icon: Target };
}

export function GoalBar({
  goal,
  disabled,
  onPause,
  onResume,
  onClear,
}: GoalBarProps) {
  if (!goal) return null;
  const tone = statusTone(goal);
  const StatusIcon = tone.icon;
  const canPause = goal.status === "active";
  const canResume = goal.status === "paused" || goal.status === "blocked";

  return (
    <div
      className="mb-2 flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        color: "var(--text)",
      }}
      role="status"
      data-testid="goal-bar"
    >
      <StatusIcon size={14} style={{ color: tone.color }} className="shrink-0" />
      <span
        className="shrink-0 rounded px-1.5 py-0.5 uppercase tracking-normal"
        style={{ background: "var(--bg-selected)", color: tone.color }}
      >
        {goal.status}
      </span>
      <span className="min-w-0 flex-1 truncate" title={goal.objective}>
        {goal.objective}
      </span>
      <span className="shrink-0 text-[11px]" style={{ color: "var(--text-muted)" }}>
        {goal.turns} turns
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
          title="Resume goal"
          aria-label="Resume goal"
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
  );
}

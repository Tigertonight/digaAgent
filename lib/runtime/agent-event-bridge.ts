import type { BrowserSnapshot } from "@/lib/browser/types";
import type { ApprovalRequest } from "@/lib/collab/types";
import type { EvidenceRef } from "@/lib/evidence/types";
import type { AgentProgress } from "@/lib/progress/types";
import type { SubagentBatch, SubagentResult } from "@/lib/subagents/types";
import type { WorkflowArtifact, WorkflowCheckpoint, WorkflowRun } from "@/lib/workflows/types";
import type {
  RuntimeEvent,
  RuntimeEventSource,
  RuntimeEventStatus,
} from "./events";

export interface AgentEventBridgeContext {
  agentId: string;
  sessionId?: string | null;
  sessionPath?: string | null;
  cwd?: string | null;
  seq: number;
}

export interface AgentEventBridgeResult {
  event: RuntimeEvent;
  evidence: EvidenceRef[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function textPreview(value: unknown, max = 600): string | undefined {
  if (typeof value === "string") return value.trim().slice(0, max) || undefined;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return undefined;
  }
}

function statusFrom(value: unknown): RuntimeEventStatus | undefined {
  if (value === "running" || value === "queued") return value;
  if (value === "pending") return "queued";
  if (value === "busy" || value === "launching" || value === "active") {
    return "running";
  }
  if (
    value === "completed" ||
    value === "complete" ||
    value === "passed" ||
    value === "allowed"
  ) {
    return "done";
  }
  if (
    value === "failed" ||
    value === "error" ||
    value === "denied" ||
    value === "deny"
  ) {
    return "error";
  }
  if (value === "blocked" || value === "paused") return "blocked";
  if (value === "aborted" || value === "timeout") return "aborted";
  if (value === "ready" || value === "idle" || value === "closed") return "done";
  return undefined;
}

function baseEvent(
  ctx: AgentEventBridgeContext,
  source: RuntimeEventSource,
  type: string,
  payload: unknown,
  status?: RuntimeEventStatus
): RuntimeEvent {
  const now = Date.now();
  return {
    id: `${ctx.agentId}:${ctx.seq}:${type}`,
    source,
    type,
    status,
    sessionId: ctx.sessionId ?? null,
    agentId: ctx.agentId,
    payload,
    createdAt: now,
  };
}

function withEvidence(event: RuntimeEvent, evidence: EvidenceRef[]): AgentEventBridgeResult {
  return {
    event: evidence.length > 0 ? { ...event, evidence } : event,
    evidence,
  };
}

function browserIdForAgent(agentId: string): string {
  return `agent:${agentId}`;
}

function progressStatus(progress: AgentProgress | undefined): RuntimeEventStatus {
  const steps = progress?.groups.at(-1)?.steps ?? progress?.steps ?? [];
  if (steps.some((step) => step.status === "failed")) return "error";
  if (steps.some((step) => step.status === "blocked")) return "blocked";
  if (steps.some((step) => step.status === "running")) return "running";
  if (steps.some((step) => step.status === "pending")) return "queued";
  return steps.length > 0 ? "done" : "running";
}

function bridgeBrowserState(
  ctx: AgentEventBridgeContext,
  event: Record<string, unknown>
): AgentEventBridgeResult {
  const snapshot = event.snapshot as BrowserSnapshot | undefined;
  const browserId = browserIdForAgent(ctx.agentId);
  const evidence: EvidenceRef[] = [];
  const now = Date.now();

  for (const step of snapshot?.steps ?? []) {
    evidence.push({
      id: `browser-step:${browserId}:${step.id}`,
      kind: "browser_step",
      title: `${step.action}: ${step.label}`,
      sessionId: ctx.sessionId ?? null,
      agentId: ctx.agentId,
      browserId,
      taskId: step.taskId ?? null,
      url: step.url,
      screenshotDataUrl: step.screenshotDataUrl,
      textPreview: step.extractedText ?? step.error ?? undefined,
      metadata: {
        action: step.action,
        status: step.status,
        passed: step.passed,
        pointer: step.pointer,
      },
      createdAt: step.createdAt ?? now,
      updatedAt: now,
    });
  }

  for (const annotation of snapshot?.annotations ?? []) {
    evidence.push({
      id: `browser-annotation:${annotation.browserId}:${annotation.id}`,
      kind: "browser_annotation",
      title: `Annotation: ${annotation.comment.slice(0, 80)}`,
      sessionId: ctx.sessionId ?? null,
      agentId: ctx.agentId,
      browserId: annotation.browserId,
      url: annotation.url,
      screenshotDataUrl: annotation.screenshotDataUrl,
      textPreview: annotation.comment,
      metadata: {
        rect: annotation.rect,
        status: annotation.status ?? "open",
        title: annotation.title,
      },
      createdAt: annotation.createdAt,
      updatedAt: annotation.updatedAt ?? now,
    });
  }

  const runtimeEvent = {
    ...baseEvent(
      ctx,
      "browser",
      "browser.state",
      snapshot ?? event,
      statusFrom(snapshot?.status)
    ),
    browserId,
  };
  return withEvidence(runtimeEvent, evidence);
}

function bridgeProgress(
  ctx: AgentEventBridgeContext,
  event: Record<string, unknown>
): AgentEventBridgeResult {
  const progress = event.progress as AgentProgress | undefined;
  const evidence: EvidenceRef[] = (progress?.artifacts ?? []).map((artifact) => ({
    id: `progress-artifact:${ctx.agentId}:${artifact.id}`,
    kind: "progress_artifact",
    title: artifact.title,
    sessionId: ctx.sessionId ?? null,
    agentId: ctx.agentId,
    url: artifact.kind === "url" ? artifact.href : undefined,
    filePath: artifact.kind === "file" ? artifact.href : undefined,
    textPreview: artifact.summary,
    metadata: { kind: artifact.kind, href: artifact.href },
    createdAt: artifact.createdAt,
    updatedAt: progress?.updatedAt,
  }));
  return withEvidence(
    baseEvent(
      ctx,
      "progress",
      "progress.updated",
      progress ?? event,
      progressStatus(progress)
    ),
    evidence
  );
}

function bridgeApproval(
  ctx: AgentEventBridgeContext,
  event: Record<string, unknown>
): AgentEventBridgeResult {
  const type = event.type === "approval_resolved" ? "approval.resolved" : "approval.request";
  const request = event.request as ApprovalRequest | undefined;
  const toolCallId = asString(event.toolCallId) ?? request?.toolCallId ?? "unknown";
  const evidence: EvidenceRef[] =
    event.type === "approval_resolved"
      ? [
          {
            id: `approval:${ctx.agentId}:${toolCallId}`,
            kind: "approval_decision",
            title: `Approval ${String(event.decision ?? "resolved")}: ${toolCallId}`,
            sessionId: ctx.sessionId ?? null,
            agentId: ctx.agentId,
            textPreview: asString(event.denyReason) ?? undefined,
            metadata: {
              decision: event.decision,
              resolvedBy: event.resolvedBy,
              approvalId: event.id,
            },
            createdAt: Date.now(),
          },
        ]
      : [];
  return withEvidence(
    baseEvent(
      ctx,
      "approval",
      type,
      event,
      event.type === "approval_resolved" ? statusFrom(event.decision) : "blocked"
    ),
    evidence
  );
}

function bridgeWorkflow(
  ctx: AgentEventBridgeContext,
  event: Record<string, unknown>
): AgentEventBridgeResult {
  const workflowId =
    asString(event.workflowId) ?? ((event.run as WorkflowRun | undefined)?.id ?? null);
  const sourceEvent = baseEvent(
    ctx,
    "workflow",
    String(event.type).replace(/_/g, "."),
    event,
    statusFrom((event.run as WorkflowRun | undefined)?.status ?? event.status)
  );
  const runtimeEvent = workflowId ? { ...sourceEvent, workflowId } : sourceEvent;
  const evidence: EvidenceRef[] = [];

  const artifact = event.artifact as WorkflowArtifact | undefined;
  if (workflowId && artifact) {
    evidence.push({
      id: `workflow-artifact:${workflowId}:${artifact.name}`,
      kind: "workflow_artifact",
      title: artifact.name,
      sessionId: ctx.sessionId ?? null,
      agentId: ctx.agentId,
      workflowId,
      textPreview: textPreview(artifact.value),
      metadata: { value: artifact.value },
      createdAt: artifact.createdAt,
    });
  }

  const checkpoint = event.checkpoint as WorkflowCheckpoint | undefined;
  if (workflowId && checkpoint) {
    evidence.push({
      id: `workflow-checkpoint:${workflowId}:${checkpoint.name}`,
      kind: "workflow_artifact",
      title: `Checkpoint: ${checkpoint.name}`,
      sessionId: ctx.sessionId ?? null,
      agentId: ctx.agentId,
      workflowId,
      textPreview: textPreview(checkpoint.value),
      metadata: { checkpoint: true, value: checkpoint.value },
      createdAt: checkpoint.createdAt,
    });
  }

  return withEvidence(runtimeEvent, evidence);
}

function bridgeSubagent(
  ctx: AgentEventBridgeContext,
  event: Record<string, unknown>
): AgentEventBridgeResult {
  const batch = event.batch as SubagentBatch | undefined;
  const batchId = asString(event.batchId) ?? batch?.id ?? null;
  const taskId = asString(event.taskId);
  const runtimeEvent = {
    ...baseEvent(
      ctx,
      "subagent",
      String(event.type).replace(/_/g, "."),
      event,
      statusFrom(event.status)
    ),
    ...(batchId ? { parentId: batchId } : {}),
    ...(taskId ? { taskId } : {}),
  };

  const evidence: EvidenceRef[] = [];
  const resultList = Array.isArray(event.results)
    ? (event.results as SubagentResult[])
    : event.type === "subagent_task_end"
      ? [
          {
            taskId: String(event.taskId ?? "unknown"),
            agentId: String(event.agentId ?? ""),
            status: String(event.status ?? "completed") as SubagentResult["status"],
            answer: asString(event.answer) ?? undefined,
            error: asString(event.error) ?? undefined,
            startedAt: Date.now(),
            endedAt: typeof event.endedAt === "number" ? event.endedAt : Date.now(),
            sessionFile: asString(event.sessionFile) ?? undefined,
          },
        ]
      : [];

  for (const result of resultList) {
    evidence.push({
      id: `subagent-result:${batchId ?? "batch"}:${result.taskId}:${result.agentId}`,
      kind: "subagent_result",
      title: `Subagent ${result.status}: ${result.taskId}`,
      sessionId: ctx.sessionId ?? null,
      agentId: ctx.agentId,
      taskId: result.taskId,
      textPreview: result.answer ?? result.error,
      filePath: result.sessionFile,
      metadata: { childAgentId: result.agentId, usage: result.usage },
      createdAt: result.endedAt ?? result.startedAt,
    });
  }

  return withEvidence(runtimeEvent, evidence);
}

function bridgeGoal(
  ctx: AgentEventBridgeContext,
  event: Record<string, unknown>
): AgentEventBridgeResult {
  const goal = asRecord(event.goal);
  const evidence: EvidenceRef[] = goal
    ? [
        {
          id: `goal-turn:${ctx.agentId}:${String(goal.turns ?? ctx.seq)}`,
          kind: "goal_turn",
          title: `Goal ${String(goal.status ?? "updated")}: ${String(goal.objective ?? "")}`.slice(0, 140),
          sessionId: ctx.sessionId ?? null,
          agentId: ctx.agentId,
          textPreview: textPreview(goal.blockedReason ?? goal.pauseReason ?? goal.objective),
          metadata: {
            status: goal.status,
            turns: goal.turns,
            blockedStreak: goal.blockedStreak,
            blockedState: goal.blockedState,
          },
          createdAt: typeof goal.updatedAt === "number" ? goal.updatedAt : Date.now(),
        },
      ]
    : [];
  return withEvidence(
    baseEvent(ctx, "goal", "goal.updated", event.goal ?? null, statusFrom(goal?.status)),
    evidence
  );
}

export function bridgeAgentEventToRuntime(
  ctx: AgentEventBridgeContext,
  rawEvent: unknown
): AgentEventBridgeResult | null {
  const event = asRecord(rawEvent);
  const type = asString(event?.type);
  if (!event || !type) return null;

  if (type === "browser_state") return bridgeBrowserState(ctx, event);
  if (type === "progress_updated") return bridgeProgress(ctx, event);
  if (type === "approval_request" || type === "approval_resolved") {
    return bridgeApproval(ctx, event);
  }
  if (type.startsWith("workflow_")) return bridgeWorkflow(ctx, event);
  if (type.startsWith("subagent_")) return bridgeSubagent(ctx, event);
  if (type === "goal_updated") return bridgeGoal(ctx, event);

  if (type === "agent_start" || type === "agent_end") {
    return withEvidence(
      baseEvent(
        ctx,
        "agent",
        type.replace(/_/g, "."),
        event,
        type === "agent_start" ? "running" : "done"
      ),
      []
    );
  }

  return null;
}

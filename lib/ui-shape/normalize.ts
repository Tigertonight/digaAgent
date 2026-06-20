import type {
  AgentProgress,
  ProgressArtifact,
  ProgressGroup,
  ProgressStep,
} from "@/lib/progress/types";
import type { MessagePart } from "@/lib/types";
import {
  recordUiShapeViolation,
  type RecordUiShapeViolationInput,
} from "./diagnostics";

interface ShapeContext {
  surface?: string;
  sourceEventType?: string;
  agentId?: string;
  sessionId?: string;
  fieldPath?: string;
}

function report(
  ctx: ShapeContext | undefined,
  fieldPath: string,
  expected: string,
  received: unknown
): void {
  if (!ctx?.surface) return;
  recordUiShapeViolation({
    surface: ctx.surface,
    fieldPath,
    expected,
    received,
    sourceEventType: ctx.sourceEventType,
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
  } satisfies RecordUiShapeViolationInput);
}

export function safeArray<T = unknown>(
  value: unknown,
  ctx?: ShapeContext & { fieldPath?: string }
): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value !== undefined) {
    report(ctx, ctx?.fieldPath ?? "value", "array", value);
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeProgressStep(value: unknown, index: number): ProgressStep {
  const rec = asRecord(value);
  return {
    id: stringOr(rec?.id, `step-${index + 1}`),
    title: stringOr(rec?.title, `Step ${index + 1}`),
    status:
      rec?.status === "pending" ||
      rec?.status === "running" ||
      rec?.status === "completed" ||
      rec?.status === "blocked" ||
      rec?.status === "failed"
        ? rec.status
        : "pending",
    summary: typeof rec?.summary === "string" ? rec.summary : undefined,
    evidenceIds: safeArray<string>(rec?.evidenceIds),
    startedAt: typeof rec?.startedAt === "number" ? rec.startedAt : undefined,
    completedAt: typeof rec?.completedAt === "number" ? rec.completedAt : undefined,
  };
}

function normalizeProgressArtifact(value: unknown, index: number): ProgressArtifact {
  const rec = asRecord(value);
  return {
    id: stringOr(rec?.id, `artifact-${index + 1}`),
    kind:
      rec?.kind === "file" ||
      rec?.kind === "url" ||
      rec?.kind === "screenshot" ||
      rec?.kind === "test" ||
      rec?.kind === "diff" ||
      rec?.kind === "log" ||
      rec?.kind === "browser" ||
      rec?.kind === "other"
        ? rec.kind
        : "other",
    title: stringOr(rec?.title, `Artifact ${index + 1}`),
    href: typeof rec?.href === "string" ? rec.href : undefined,
    summary: typeof rec?.summary === "string" ? rec.summary : undefined,
    createdAt: numberOr(rec?.createdAt, Date.now()),
  };
}

function normalizeProgressGroup(
  value: unknown,
  index: number,
  ctx?: ShapeContext
): ProgressGroup {
  const rec = asRecord(value);
  const steps = safeArray<unknown>(rec?.steps, {
    ...ctx,
    fieldPath: `groups.${index}.steps`,
  }).map(normalizeProgressStep);
  return {
    id: stringOr(rec?.id, `group-${index + 1}`),
    index: numberOr(rec?.index, index + 1),
    steps,
    startedAt: numberOr(rec?.startedAt, Date.now()),
    endedAt: typeof rec?.endedAt === "number" ? rec.endedAt : undefined,
  };
}

export function normalizeAgentProgress(
  value: unknown,
  ctx?: ShapeContext
): AgentProgress | null {
  if (!value) return null;
  const rec = asRecord(value);
  if (!rec) {
    report(ctx, "progress", "object", value);
    return null;
  }
  const groups = safeArray<unknown>(rec.groups, {
    ...ctx,
    fieldPath: "groups",
  }).map((group, index) => normalizeProgressGroup(group, index, ctx));
  const stepsSource =
    groups.length > 0
      ? groups.at(-1)?.steps ?? []
      : safeArray<unknown>(rec.steps, { ...ctx, fieldPath: "steps" }).map(
          normalizeProgressStep
        );
  return {
    steps: stepsSource,
    groups,
    artifacts: safeArray<unknown>(rec.artifacts, {
      ...ctx,
      fieldPath: "artifacts",
    }).map(normalizeProgressArtifact),
    updatedAt: numberOr(rec.updatedAt, Date.now()),
  };
}

export function normalizeMessageParts(value: unknown, ctx?: ShapeContext): MessagePart[] {
  return safeArray<MessagePart>(value, {
    ...ctx,
    fieldPath: ctx?.fieldPath ?? "parts",
  }).map((part) => {
    if (part && typeof part === "object" && "kind" in part) return part;
    report(ctx, "parts.item", "message part object", part);
    return { kind: "text", text: "" };
  });
}

export interface NormalizedWorkflowPayload {
  checkpoints: unknown[];
  artifacts: unknown[];
  logs: unknown[];
  traceEvents: unknown[];
  warnings: string[];
}

export function normalizeWorkflowUiPayload(
  value: unknown,
  ctx?: ShapeContext
): NormalizedWorkflowPayload {
  const rec = asRecord(value) ?? {};
  return {
    checkpoints: safeArray(rec.checkpoints, { ...ctx, fieldPath: "checkpoints" }),
    artifacts: safeArray(rec.artifacts, { ...ctx, fieldPath: "artifacts" }),
    logs: safeArray(rec.logs, { ...ctx, fieldPath: "logs" }),
    traceEvents: safeArray(rec.traceEvents, { ...ctx, fieldPath: "traceEvents" }),
    warnings: safeArray<unknown>(rec.warnings, { ...ctx, fieldPath: "warnings" }).filter(
      (item): item is string => typeof item === "string"
    ),
  };
}

export interface NormalizedSubagentBatch {
  tasks: unknown[];
  auditEvents: unknown[];
  attempts: unknown[];
}

export function normalizeSubagentBatchPayload(
  value: unknown,
  ctx?: ShapeContext
): NormalizedSubagentBatch {
  const rec = asRecord(value) ?? {};
  return {
    tasks: safeArray(rec.tasks, { ...ctx, fieldPath: "tasks" }),
    auditEvents: safeArray(rec.auditEvents, { ...ctx, fieldPath: "auditEvents" }),
    attempts: safeArray(rec.attempts, { ...ctx, fieldPath: "attempts" }),
  };
}

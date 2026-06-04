import "server-only";
import { randomUUID } from "node:crypto";
import type {
  AgentProgress,
  ProgressArtifact,
  ProgressArtifactUpdateInput,
  ProgressStep,
  ProgressStepUpdateInput,
  ProgressUpdateInput,
} from "./types";

const MAX_STEPS = 20;
const MAX_ARTIFACTS = 30;

interface ProgressStore {
  progress: Map<string, AgentProgress>;
}

const g = globalThis as unknown as { __miniPiProgress?: ProgressStore };
if (!g.__miniPiProgress) {
  g.__miniPiProgress = { progress: new Map() };
}
const store = g.__miniPiProgress;

function now() {
  return Date.now();
}

function emptyProgress(): AgentProgress {
  return { steps: [], artifacts: [], updatedAt: now() };
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function normalizeStep(input: ProgressStepUpdateInput): ProgressStep {
  const t = now();
  const status = input.status;
  return {
    id: cleanText(input.id, 80) || randomUUID(),
    title: cleanText(input.title, 160),
    status,
    ...(input.summary ? { summary: cleanText(input.summary, 500) } : {}),
    ...(Array.isArray(input.evidenceIds)
      ? {
          evidenceIds: input.evidenceIds
            .map((id) => cleanText(id, 80))
            .filter(Boolean)
            .slice(0, 10),
        }
      : {}),
    ...(status === "running" ? { startedAt: t } : {}),
    ...(status === "completed" || status === "blocked" || status === "failed"
      ? { completedAt: t }
      : {}),
  };
}

function normalizeArtifact(input: ProgressArtifactUpdateInput): ProgressArtifact {
  return {
    id: cleanText(input.id, 80) || randomUUID(),
    kind: input.kind,
    title: cleanText(input.title, 160),
    ...(input.href ? { href: cleanText(input.href, 1000) } : {}),
    ...(input.summary ? { summary: cleanText(input.summary, 500) } : {}),
    createdAt: now(),
  };
}

export function getProgress(agentId: string): AgentProgress {
  return store.progress.get(agentId) ?? emptyProgress();
}

export function clearProgress(agentId: string): AgentProgress {
  const progress = emptyProgress();
  store.progress.set(agentId, progress);
  return progress;
}

export function updateProgress(
  agentId: string,
  input: ProgressUpdateInput
): AgentProgress {
  const current = getProgress(agentId);
  const incomingSteps = (input.steps ?? [])
    .map(normalizeStep)
    .filter((step) => step.title);
  const incomingArtifacts = (input.artifacts ?? [])
    .map(normalizeArtifact)
    .filter((artifact) => artifact.title);

  const steps = input.replaceSteps
    ? incomingSteps
    : mergeById(current.steps, incomingSteps).slice(-MAX_STEPS);
  const artifacts = input.replaceArtifacts
    ? incomingArtifacts
    : mergeById(current.artifacts, incomingArtifacts).slice(-MAX_ARTIFACTS);

  const progress: AgentProgress = {
    steps,
    artifacts,
    updatedAt: now(),
  };
  store.progress.set(agentId, progress);
  return progress;
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    byId.set(item.id, { ...byId.get(item.id), ...item });
  }
  return [...byId.values()];
}

export function __resetProgressStoreForTest(): void {
  store.progress.clear();
}

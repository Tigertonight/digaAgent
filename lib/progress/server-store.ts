import "server-only";
import { randomUUID } from "node:crypto";
import type {
  AgentProgress,
  ProgressArtifact,
  ProgressArtifactUpdateInput,
  ProgressGroup,
  ProgressStep,
  ProgressStepUpdateInput,
  ProgressUpdateInput,
} from "./types";

const MAX_STEPS = 20;
const MAX_ARTIFACTS = 30;

interface ProgressStore {
  progress: Map<string, AgentProgress>;
}

const g = globalThis as unknown as { __digaAgentProgress?: ProgressStore };
if (!g.__digaAgentProgress) {
  g.__digaAgentProgress = { progress: new Map() };
}
const store = g.__digaAgentProgress;

function now() {
  return Date.now();
}

function emptyProgress(): AgentProgress {
  return { steps: [], groups: [], artifacts: [], updatedAt: now() };
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

export function failOpenProgress(
  agentId: string,
  summary = "已中止。"
): AgentProgress {
  const current = getProgress(agentId);
  const t = now();
  const closeStep = (step: ProgressStep): ProgressStep => {
    if (step.status !== "running" && step.status !== "pending") return step;
    return {
      ...step,
      status: "failed",
      summary: step.summary ? `${step.summary}\n${summary}` : summary,
      completedAt: t,
    };
  };
  const groups = current.groups.map((group) => ({
    ...group,
    steps: group.steps.map(closeStep),
    endedAt:
      group.endedAt ??
      (group.steps.some(
        (step) => step.status === "running" || step.status === "pending"
      )
        ? t
        : undefined),
  }));
  const progress: AgentProgress = {
    ...current,
    steps: current.steps.map(closeStep),
    groups,
    updatedAt: t,
  };
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

  // Hydrate groups for legacy progress objects that only have a flat `steps`
  // list (persisted before grouping landed): treat them as group 1.
  const groups: ProgressGroup[] =
    current.groups && current.groups.length > 0
      ? current.groups.map((g) => ({ ...g, steps: g.steps.slice() }))
      : current.steps.length > 0
        ? [
            {
              id: randomUUID(),
              index: 1,
              steps: current.steps.slice(),
              startedAt: current.updatedAt,
            },
          ]
        : [];

  const t = now();
  const currentGroup = groups[groups.length - 1];

  // Open a new group when the agent replaces the step list and the current
  // group already has steps. Each new group restarts its own 1-based numbering.
  const shouldOpenNewGroup =
    input.replaceSteps === true &&
    currentGroup !== undefined &&
    currentGroup.steps.length > 0;

  if (shouldOpenNewGroup && currentGroup) {
    currentGroup.endedAt = t;
    groups.push({
      id: randomUUID(),
      index: currentGroup.index + 1,
      steps: incomingSteps,
      startedAt: t,
    });
  } else if (currentGroup) {
    // Merge into (or replace within) the current group.
    currentGroup.steps = input.replaceSteps
      ? incomingSteps
      : mergeById(currentGroup.steps, incomingSteps).slice(-MAX_STEPS);
  } else if (incomingSteps.length > 0) {
    // First ever group.
    groups.push({
      id: randomUUID(),
      index: 1,
      steps: incomingSteps,
      startedAt: t,
    });
  }

  const latestGroup = groups[groups.length - 1];
  const steps = latestGroup ? latestGroup.steps : [];

  const artifacts = input.replaceArtifacts
    ? incomingArtifacts
    : mergeById(current.artifacts, incomingArtifacts).slice(-MAX_ARTIFACTS);

  const progress: AgentProgress = {
    steps,
    groups,
    artifacts,
    updatedAt: t,
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

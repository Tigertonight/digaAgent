import "server-only";
import { randomUUID } from "node:crypto";
import type {
  DynamicWorkflowResult,
  RunDynamicWorkflowDeps,
  RunDynamicWorkflowInput,
  WorkflowStage,
  WorkflowStageResult,
  WorkflowStep,
} from "./types";

const DEFAULT_MAX_STAGES = 6;
const DEFAULT_MAX_STEPS_PER_STAGE = 8;
const DEFAULT_STAGE_CONCURRENCY = 4;

function cleanId(raw: string | undefined, fallback: string): string {
  const id = raw?.trim() || fallback;
  return id.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 80);
}

function cleanText(raw: string | undefined, fallback = ""): string {
  return (raw?.trim() || fallback).slice(0, 12000);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function normalizeStep(raw: WorkflowStep, index: number): WorkflowStep {
  return {
    id: cleanId(raw.id, `step-${index + 1}`),
    title: cleanText(raw.title, `Step ${index + 1}`).slice(0, 120),
    prompt: cleanText(raw.prompt),
    role: raw.role,
    cwd: raw.cwd,
    allowedTools: raw.allowedTools?.filter(Boolean).slice(0, 24),
    maxTurns: raw.maxTurns,
    timeoutMs: raw.timeoutMs,
  };
}

function normalizeStage(raw: WorkflowStage, index: number): WorkflowStage {
  const steps = (raw.steps ?? [])
    .slice(0, DEFAULT_MAX_STEPS_PER_STAGE)
    .map(normalizeStep)
    .filter((step) => step.prompt.length > 0);
  return {
    id: cleanId(raw.id, `stage-${index + 1}`),
    title: cleanText(raw.title, `Stage ${index + 1}`).slice(0, 120),
    strategy: raw.strategy,
    steps,
    concurrency: clamp(
      Math.floor(raw.concurrency ?? DEFAULT_STAGE_CONCURRENCY),
      1,
      Math.min(DEFAULT_STAGE_CONCURRENCY, Math.max(steps.length, 1))
    ),
    synthesisInstructions: cleanText(raw.synthesisInstructions, undefined),
  };
}

function normalizeInput(input: RunDynamicWorkflowInput): RunDynamicWorkflowInput {
  const objective = cleanText(input.objective).slice(0, 2000);
  const rationale = cleanText(input.rationale).slice(0, 2000);
  if (!objective) throw new Error("run_dynamic_workflow requires an objective");
  if (!rationale) throw new Error("run_dynamic_workflow requires a rationale");
  const stages = (input.stages ?? [])
    .slice(0, DEFAULT_MAX_STAGES)
    .map(normalizeStage)
    .filter((stage) => stage.steps.length > 0);
  if (stages.length === 0) {
    throw new Error("run_dynamic_workflow requires at least one stage with steps");
  }
  return {
    objective,
    rationale,
    stages,
    finalSynthesisInstructions: cleanText(input.finalSynthesisInstructions, undefined),
  };
}

function priorStageContext(stages: WorkflowStageResult[]): string {
  if (stages.length === 0) return "";
  return [
    "Prior workflow stage results:",
    ...stages.map((stage) => {
      const answers = stage.results
        .map((result) => {
          const body = result.answer || result.error || "(no answer)";
          return `- ${result.taskId} (${result.status}): ${body}`;
        })
        .join("\n");
      return [`## ${stage.title}`, answers].join("\n");
    }),
  ].join("\n\n");
}

function stepPrompt(
  objective: string,
  stage: WorkflowStage,
  step: WorkflowStep,
  completedStages: WorkflowStageResult[]
): string {
  const context = priorStageContext(completedStages);
  return [
    `Workflow objective: ${objective}`,
    `Current stage: ${stage.title}`,
    stage.strategy ? `Stage strategy: ${stage.strategy}` : "",
    context,
    "Current step:",
    step.prompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function runDynamicWorkflow(
  deps: RunDynamicWorkflowDeps,
  rawInput: RunDynamicWorkflowInput,
  signal?: AbortSignal
): Promise<DynamicWorkflowResult> {
  const input = normalizeInput(rawInput);
  const workflowId = randomUUID();
  const startedAt = Date.now();
  const stageResults: WorkflowStageResult[] = [];

  for (const stage of input.stages) {
    if (signal?.aborted) break;
    const stageStartedAt = Date.now();
    const stageResult: WorkflowStageResult = {
      stageId: stage.id,
      title: stage.title,
      status: "running",
      results: [],
      startedAt: stageStartedAt,
    };
    stageResults.push(stageResult);

    try {
      const { batchId, results } = await deps.runSubagents(
        {
          reason: [
            input.rationale,
            `Dynamic workflow ${workflowId}, stage ${stage.id}: ${stage.title}`,
          ].join("\n"),
          concurrency: stage.concurrency,
          synthesisInstructions: stage.synthesisInstructions,
          tasks: stage.steps.map((step) => ({
            ...step,
            prompt: stepPrompt(input.objective, stage, step, stageResults.slice(0, -1)),
          })),
        },
        signal
      );
      stageResult.batchId = batchId;
      stageResult.results = results;
      stageResult.status = results.some((result) => result.status === "completed")
        ? "completed"
        : "failed";
    } catch (err) {
      stageResult.status = signal?.aborted ? "aborted" : "failed";
      stageResult.error = (err as Error).message;
    } finally {
      stageResult.endedAt = Date.now();
    }

    if (stageResult.status !== "completed") break;
  }

  const endedAt = Date.now();
  const status = signal?.aborted
    ? "aborted"
    : stageResults.every((stage) => stage.status === "completed")
      ? "completed"
      : "failed";

  return {
    workflowId,
    objective: input.objective,
    status,
    stages: stageResults,
    startedAt,
    endedAt,
  };
}

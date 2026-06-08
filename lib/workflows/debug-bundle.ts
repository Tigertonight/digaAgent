import type { WorkflowDebugBundle, WorkflowRun } from "./types";
import { workflowResumeSnapshot } from "./server-store";

export function buildWorkflowDebugBundle(run: WorkflowRun): WorkflowDebugBundle {
  const traceEvents = run.traceEvents ?? [];
  return {
    workflow: {
      id: run.id,
      parentAgentId: run.parentAgentId,
      objective: run.objective,
      rationale: run.rationale,
      status: run.status,
      manifest: run.manifest,
      createdAt: run.createdAt,
      endedAt: run.endedAt,
      resumedFromWorkflowId: run.resumedFromWorkflowId,
      error: run.error,
    },
    resume: workflowResumeSnapshot(run),
    script: run.script,
    counts: {
      artifacts: run.artifacts.length,
      checkpoints: run.checkpoints.length,
      logs: run.logs.length,
      traceEvents: traceEvents.length,
    },
    artifacts: run.artifacts,
    checkpoints: run.checkpoints,
    logs: run.logs,
    traceEvents,
    returnValue: run.returnValue,
  };
}

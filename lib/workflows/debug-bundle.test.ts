import { describe, expect, it } from "vitest";
import { buildWorkflowDebugBundle } from "./debug-bundle";
import type { WorkflowRun } from "./types";

describe("buildWorkflowDebugBundle", () => {
  it("summarizes a workflow run with trace and resume data", () => {
    const run: WorkflowRun = {
      id: "workflow-1",
      parentAgentId: "agent-1",
      objective: "Audit auth",
      rationale: "Use adversarial verification",
      status: "completed",
      script: "return 1;",
      manifest: {
        capabilities: ["spawn_agent", "read_files"],
        maxAgents: 4,
        maxConcurrency: 2,
        timeoutMs: 60000,
        runtime: "process",
      },
      artifacts: [
        {
          name: "summary",
          value: { ok: true },
          createdAt: 10,
        },
      ],
      checkpoints: [
        {
          name: "phase-1",
          value: ["done"],
          createdAt: 11,
        },
      ],
      logs: [{ level: "info", message: "started", createdAt: 12 }],
      traceEvents: [
        {
          type: "agent_start",
          workflowId: "workflow-1",
          agentRunId: "agent-run-1",
          title: "Reviewer",
          createdAt: 13,
        },
      ],
      createdAt: 1,
      endedAt: 20,
      returnValue: { ok: true },
    };

    const bundle = buildWorkflowDebugBundle(run);

    expect(bundle.workflow).toMatchObject({
      id: "workflow-1",
      parentAgentId: "agent-1",
      status: "completed",
    });
    expect(bundle.script).toBe("return 1;");
    expect(bundle.counts).toEqual({
      artifacts: 1,
      checkpoints: 1,
      logs: 1,
      traceEvents: 1,
    });
    expect(bundle.resume.workflowId).toBe("workflow-1");
    expect(bundle.resume.canResume).toBe(true);
    expect(bundle.traceEvents[0]?.type).toBe("agent_start");
  });
});

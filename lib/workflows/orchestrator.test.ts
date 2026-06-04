import { describe, expect, it } from "vitest";
import { runDynamicWorkflow } from "./orchestrator";

describe("runDynamicWorkflow", () => {
  it("runs stages sequentially and passes prior results into later prompts", async () => {
    const calls: Array<{ reason: string; prompt: string }> = [];

    const result = await runDynamicWorkflow({
      runSubagents: async (input) => {
        calls.push({
          reason: input.reason,
          prompt: input.tasks[0]?.prompt ?? "",
        });
        return {
          batchId: `batch-${calls.length}`,
          results: [
            {
              taskId: input.tasks[0]?.id ?? "missing",
              agentId: `agent-${calls.length}`,
              status: "completed",
              answer: `answer-${calls.length}`,
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          ],
        };
      },
    }, {
      objective: "Audit the project.",
      rationale: "The work needs staged inspection and verification.",
      stages: [
        {
          id: "inspect",
          title: "Inspect",
          steps: [{ id: "read", title: "Read", prompt: "Read files." }],
        },
        {
          id: "verify",
          title: "Verify",
          steps: [{ id: "check", title: "Check", prompt: "Check findings." }],
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain("Prior workflow stage results");
    expect(calls[1].prompt).toContain("answer-1");
  });
});

import { describe, expect, it, vi } from "vitest";
import { createDelegateSubagentsTool, createPlanSubagentsTool } from "./extension";

describe("createDelegateSubagentsTool", () => {
  it("returns planning and synthesis artifacts to the main agent", async () => {
    const onDelegate = vi.fn(async () => ({
      batchId: "batch-tool",
      planning: {
        status: "caution" as const,
        plannedAt: 100,
        rationale: "many independent questions",
        taskCount: 2,
        requestedConcurrency: 9,
        concurrency: 2,
        maxConcurrency: 2,
        warnings: ["Requested concurrency 9 was clamped to 2."],
      },
      results: [
        {
          taskId: "q1",
          agentId: "child-1",
          status: "completed" as const,
          answer: "Answer with enough detail for synthesis.",
          startedAt: 110,
          endedAt: 120,
        },
      ],
      synthesis: {
        status: "partial" as const,
        generatedAt: 130,
        summary: "Synthesis partial: 1 usable, 1 caution, 0 rejected.",
        usableTaskIds: ["q1"],
        cautionTaskIds: ["q2"],
        rejectedTaskIds: [],
        instructions: "Combine cautiously.",
      },
      auditEvents: [
        {
          type: "batch_completed" as const,
          at: 140,
          message: "Subagent batch ended as completed.",
        },
      ],
    }));
    const tool = createDelegateSubagentsTool({ onDelegate });

    const result = await (
      tool.execute as (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal
      ) => ReturnType<typeof tool.execute>
    )(
      "call-1",
      {
        reason: "many independent questions",
        concurrency: 9,
        tasks: [
          { id: "q1", title: "Question 1", prompt: "Answer Q1" },
          { id: "q2", title: "Question 2", prompt: "Answer Q2" },
        ],
      },
      undefined
    );

    expect(onDelegate).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "many independent questions",
        concurrency: 9,
        tasks: expect.arrayContaining([
          expect.objectContaining({ id: "q1", title: "Question 1" }),
        ]),
      }),
      undefined
    );
    const text = result.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    expect(text).toContain("## Planning policy");
    expect(text).toContain("Requested concurrency: 9");
    expect(text).toContain("## Synthesis guidance");
    expect(text).toContain("Usable task ids: q1");
    expect(text).toContain("Caution task ids: q2");
    expect(result.details).toMatchObject({
      batchId: "batch-tool",
      planning: { status: "caution", concurrency: 2 },
      synthesis: { status: "partial", usableTaskIds: ["q1"] },
      auditEvents: [
        {
          type: "batch_completed",
          message: "Subagent batch ended as completed.",
        },
      ],
    });
  });
});

describe("createPlanSubagentsTool", () => {
  it("returns a planner recommendation before delegation", async () => {
    const tool = createPlanSubagentsTool();

    const result = await (
      tool.execute as (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal
      ) => ReturnType<typeof tool.execute>
    )("plan-1", {
      goal: "请并行分析 4 个模块：api、hooks、components、tests",
    });

    const text = result.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    expect(text).toContain("## Subagent planner recommendation");
    expect(result.details).toMatchObject({
      mode: "multi-agent",
      suggestedConcurrency: 4,
    });
    expect(result.details.signals).toEqual(
      expect.arrayContaining(["explicit-multi-agent-intent"])
    );
  });
});

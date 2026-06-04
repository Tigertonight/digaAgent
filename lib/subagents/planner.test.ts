import { describe, expect, it } from "vitest";
import { planSubagents } from "./planner";

describe("planSubagents", () => {
  it("recommends multi-agent for explicit batched independent questions", () => {
    const plan = planSubagents({
      goal: [
        "请分多个 subagent 并行回答以下制度问题：",
        "1. 小额快速采购金额上限是多少？",
        "2. 集采和自采有什么区别？",
        "3. 合同审批通过后可以下单吗？",
        "4. 供应商报价错了怎么办？",
      ].join("\n"),
    });

    expect(plan).toMatchObject({
      mode: "multi-agent",
      taskCount: 4,
      suggestedConcurrency: 4,
    });
    expect(plan.confidence).toBeGreaterThanOrEqual(0.62);
    expect(plan.signals).toEqual(
      expect.arrayContaining([
        "explicit-multi-agent-intent",
        "multiple-independent-items",
        "large-fanout",
      ])
    );
    expect(plan.tasks[0]).toMatchObject({
      id: "task-1",
      role: "rag",
    });
  });

  it("keeps simple requests single-agent", () => {
    const plan = planSubagents({
      goal: "解释一下小额快速采购是什么。",
    });

    expect(plan).toMatchObject({
      mode: "single-agent",
      taskCount: 0,
      suggestedConcurrency: 1,
    });
    expect(plan.confidence).toBeLessThan(0.62);
  });
});

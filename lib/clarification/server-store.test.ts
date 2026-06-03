import { afterEach, describe, expect, it } from "vitest";
import {
  __resetClarificationStoreForTest,
  clearAgentClarifications,
  listPendingClarifications,
  registerPendingClarification,
  resolveClarification,
} from "./server-store";
import type { ClarificationRequest } from "./types";

function clarification(
  agentId: string,
  requestId: string
): ClarificationRequest {
  return {
    id: `${agentId}:${requestId}`,
    agentId,
    requestId,
    title: "需要你确认下一步",
    question: "先做 MVP 还是完整重构？",
    options: [
      {
        id: "mvp",
        label: "先做 MVP",
        description: "更快闭环",
        value: "先实现 MVP",
      },
      {
        id: "full",
        label: "完整重构",
        description: "长期更干净",
        value: "完整重构",
      },
    ],
    recommendedOptionId: "mvp",
    createdAt: Date.now(),
  };
}

describe("clarification server-store", () => {
  afterEach(() => {
    __resetClarificationStoreForTest();
  });

  it("listPendingClarifications 可按 agentId 过滤并 resolve", async () => {
    const q1 = clarification("agent-a", "q1");
    const q2 = clarification("agent-b", "q2");
    const p1 = registerPendingClarification(q1);
    const p2 = registerPendingClarification(q2);

    expect(listPendingClarifications().map((q) => q.id)).toEqual([
      "agent-a:q1",
      "agent-b:q2",
    ]);
    expect(listPendingClarifications("agent-a").map((q) => q.id)).toEqual([
      "agent-a:q1",
    ]);
    expect(listPendingClarifications("missing")).toEqual([]);

    expect(resolveClarification(q1.id, { selectedOptionId: "mvp" })).toBe(
      true
    );
    expect(resolveClarification(q2.id, { customText: "先调研" })).toBe(true);
    await expect(p1).resolves.toEqual({ selectedOptionId: "mvp" });
    await expect(p2).resolves.toEqual({ customText: "先调研" });
  });

  it("clearAgentClarifications 会清理指定 agent 的 pending", async () => {
    const q1 = clarification("agent-a", "q1");
    const q2 = clarification("agent-b", "q2");
    const p1 = registerPendingClarification(q1);
    const p2 = registerPendingClarification(q2);

    clearAgentClarifications("agent-a");

    expect(listPendingClarifications().map((q) => q.id)).toEqual([
      "agent-b:q2",
    ]);
    await expect(p1).resolves.toEqual({
      customText: "Clarification was aborted.",
    });
    expect(resolveClarification(q2.id, { selectedOptionId: "full" })).toBe(
      true
    );
    await expect(p2).resolves.toEqual({ selectedOptionId: "full" });
  });
});

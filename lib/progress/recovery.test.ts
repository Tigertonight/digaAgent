import { describe, it, expect } from "vitest";
import { hasUnpairedToolCalls, markInterruptedProgress } from "./recovery";
import type { AgentProgress } from "./types";

describe("hasUnpairedToolCalls", () => {
  it("无 tool_use 返回 false", () => {
    expect(
      hasUnpairedToolCalls([
        {
          role: "user",
          content: [{ type: "text" }],
        },
        {
          role: "assistant",
          content: [{ type: "text" }],
        },
      ])
    ).toBe(false);
  });

  it("anthropic-style tool_use 配对 tool_result 返回 false", () => {
    expect(
      hasUnpairedToolCalls([
        { role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
        {
          role: "tool",
          content: [{ type: "tool_result", tool_use_id: "t1" }],
        },
      ])
    ).toBe(false);
  });

  it("OpenAI-style toolCall + toolResult 配对返回 false", () => {
    expect(
      hasUnpairedToolCalls([
        { role: "assistant", content: [{ type: "toolCall", id: "t1" }] },
        { role: "toolResult", toolCallId: "t1" },
      ])
    ).toBe(false);
  });

  it("有 tool_use 但没对应 tool_result 返回 true（异常中断）", () => {
    expect(
      hasUnpairedToolCalls([
        { role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
        // 没有 tool_result
      ])
    ).toBe(true);
  });

  it("两个 tool_use 只有一个 result 返回 true", () => {
    expect(
      hasUnpairedToolCalls([
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1" },
            { type: "tool_use", id: "t2" },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool_result", tool_use_id: "t1" }],
        },
      ])
    ).toBe(true);
  });
});

describe("markInterruptedProgress", () => {
  it("把 running/pending step 收口为 failed 并补 endedAt", () => {
    const progress: AgentProgress = {
      steps: [],
      groups: [
        {
          id: "g1",
          index: 1,
          startedAt: 1,
          steps: [
            { id: "s1", title: "S1", status: "completed", completedAt: 2 },
            { id: "s2", title: "S2", status: "running" },
            { id: "s3", title: "S3", status: "pending" },
          ],
        },
      ],
      artifacts: [],
      updatedAt: 10,
    };
    const next = markInterruptedProgress(progress)!;
    const group = next.groups[0];
    expect(group.endedAt).toBeGreaterThan(0);
    const byId = new Map(group.steps.map((s) => [s.id, s]));
    expect(byId.get("s1")?.status).toBe("completed");
    expect(byId.get("s2")?.status).toBe("failed");
    expect(byId.get("s3")?.status).toBe("failed");
    // 原本全部 “completed” 的快照不会出现这里；但已经被 close 为 failed 后
    // hasAttentionStep 为 true，所以不会额外补 runtime-interrupted。
    // 检查重要信号”到达 failed/blocked“：任一被 close 的 step summary 带上 interrupted hint。
    const sumS2 = byId.get("s2")?.summary ?? "";
    expect(sumS2).toMatch(/中断/);
  });

  it("如果末尾已有 failed/blocked 节点就不再补 interrupted 标记", () => {
    const progress: AgentProgress = {
      steps: [],
      groups: [
        {
          id: "g1",
          index: 1,
          startedAt: 1,
          endedAt: 5,
          steps: [
            { id: "s1", title: "S1", status: "failed", completedAt: 5 },
          ],
        },
      ],
      artifacts: [],
      updatedAt: 10,
    };
    const next = markInterruptedProgress(progress);
    expect(next).toBe(progress); // 没改动
  });

  it("null progress 直接返回 null", () => {
    expect(markInterruptedProgress(null)).toBeNull();
  });

  it("已经全部 completed 的 progress 会被补一条 runtime-interrupted（关机后恢复信号）", () => {
    const progress: AgentProgress = {
      steps: [],
      groups: [
        {
          id: "g1",
          index: 1,
          startedAt: 1,
          endedAt: 2,
          steps: [
            { id: "s1", title: "S1", status: "completed", completedAt: 2 },
          ],
        },
      ],
      artifacts: [],
      updatedAt: 5,
    };
    const next = markInterruptedProgress(progress);
    expect(next).not.toBe(progress);
    expect(next!.groups[0].steps.at(-1)?.id).toBe("runtime-interrupted");
  });
});

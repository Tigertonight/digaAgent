import { describe, expect, it } from "vitest";
import { buildProcessSummary } from "./process-summary";
import type { ChatMessage } from "./types";

describe("buildProcessSummary", () => {
  it("summarizes tools, usage, model, and recovered errors", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        parts: [
          { kind: "thinking", text: "check" },
          {
            kind: "tool",
            toolCallId: "t1",
            toolName: "bash",
            status: "done",
            result: "ok",
          },
          {
            kind: "tool",
            toolCallId: "t2",
            toolName: "read",
            status: "error",
            isError: true,
            result: "missing",
          },
        ],
        meta: {
          model: "GPT-5.5",
          usage: {
            input: 1200,
            output: 340,
            cacheRead: 0,
            cacheWrite: 0,
            total: 1540,
            cost: 0.0123,
          },
        },
      },
    ];

    const summary = buildProcessSummary({ messages });
    expect(summary.title).toContain("GPT-5.5");
    expect(summary.title).toContain("3 个步骤");
    expect(summary.title).toContain("1 个问题已恢复");
    expect(summary.detail).toContain("bash");
    expect(summary.detail).toContain("read");
    expect(summary.detail).toContain("$0.0123");
  });

  it("marks summaries as running when forced", () => {
    const summary = buildProcessSummary({
      parts: [{ kind: "thinking", text: "still going" }],
      forceRunning: true,
    });
    expect(summary.running).toBe(true);
    expect(summary.title).toContain("执行中");
  });
});

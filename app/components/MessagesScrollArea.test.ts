import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCollapsedProcessItems,
  dedupeAdjacentRestoredMessages,
  shouldForceProcessGroupExecuting,
} from "./MessagesScrollArea";
import type { ChatMessage } from "@/lib/types";

function user(text: string, timestamp: number): ChatMessage {
  return {
    role: "user",
    text,
    timestamp,
    parts: [{ kind: "text", text }],
  };
}

function assistantProcess(timestamp: number): ChatMessage {
  return {
    role: "assistant",
    text: "",
    timestamp,
    stopReason: "tool_use",
    parts: [
      {
        kind: "tool",
        toolCallId: `tool-${timestamp}`,
        toolName: "read",
        status: "done",
      },
    ],
  };
}

function assistantText(text: string, timestamp: number): ChatMessage {
  return {
    role: "assistant",
    text,
    timestamp,
    parts: [{ kind: "text", text }],
  };
}

describe("MessagesScrollArea process grouping", () => {
  it("renders a later user before assistant process items that arrived after it", () => {
    const messages = [
      user("first question", 1000),
      assistantProcess(3000),
      user("follow up", 2000),
    ];

    const items = buildCollapsedProcessItems({ messages });

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "message",
      "process_group",
    ]);
    expect(items[1]).toMatchObject({
      kind: "message",
      index: 2,
    });
  });

  it("does not force an old process group into running once a later user exists", () => {
    const messages = [
      user("first question", 1000),
      assistantProcess(1500),
      user("done yet?", 2000),
    ];

    expect(shouldForceProcessGroupExecuting(messages, 1, true)).toBe(false);
  });

  it("still forces the tail process group while the current turn is streaming", () => {
    const messages = [
      user("first question", 1000),
      assistantText("working on it", 1100),
      assistantProcess(1500),
    ];

    expect(shouldForceProcessGroupExecuting(messages, 2, true)).toBe(true);
  });

  it("dedupes adjacent restored user messages with the same content", () => {
    const messages = [
      user("same prompt", 1000),
      user("same prompt", 1000),
      assistantText("answer", 1100),
    ];

    const deduped = dedupeAdjacentRestoredMessages(messages);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]).toMatchObject({ role: "user", text: "same prompt" });

    const items = buildCollapsedProcessItems({ messages });
    expect(items.filter((item) => item.kind === "message")).toHaveLength(2);
  });

  it("keeps message rendering behind UI shape guards", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/components/MessagesScrollArea.tsx"),
      "utf8"
    );

    expect(source).toContain("normalizeMessageParts");
    expect(source).toContain("<UiFaultBoundary");
    expect(source).toContain("消息渲染异常，已隔离该消息");
  });

  it("keeps Agent Team run cards visible instead of folding them into process groups", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/components/MessagesScrollArea.tsx"),
      "utf8"
    );

    expect(source).toContain('part.kind === "agent_team_run"');
    expect(source).toContain("return false");
  });
});

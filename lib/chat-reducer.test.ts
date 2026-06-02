import { describe, it, expect } from "vitest";
import { createInitialState, ctxToMessages } from "./chat-reducer";
import type { ChatMessage } from "./types";

describe("createInitialState", () => {
  it("默认返回空 messages 和 activeAssistantIndex=-1", () => {
    const s = createInitialState();
    expect(s.messages).toEqual([]);
    expect(s.activeAssistantIndex).toBe(-1);
  });

  it("传入 messages 时透传", () => {
    const seed: ChatMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "hi" }], text: "hi" },
    ];
    const s = createInitialState(seed);
    expect(s.messages).toBe(seed);
    expect(s.activeAssistantIndex).toBe(-1);
  });
});

describe("ctxToMessages", () => {
  it("空数组 → 空数组", () => {
    expect(ctxToMessages([])).toEqual([]);
  });

  it("user 只含 text → 输出一个 user message，parts/text/timestamp 正确", () => {
    const out = ctxToMessages([
      {
        role: "user",
        timestamp: 1000,
        content: [{ type: "text", text: "hello" }],
      },
    ]);
    expect(out).toEqual([
      {
        role: "user",
        parts: [{ kind: "text", text: "hello" }],
        text: "hello",
        timestamp: 1000,
      },
    ]);
  });

  it("user 含 text + image → parts 顺序保留，text 字段只拼 text", () => {
    const out = ctxToMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "look:" },
          { type: "image", data: "BASE64", mimeType: "image/png" },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].parts).toEqual([
      { kind: "text", text: "look:" },
      { kind: "image", data: "BASE64", mimeType: "image/png" },
    ]);
    expect(out[0].text).toBe("look:");
  });

  it("assistant 含 text + thinking + image → parts 全部映射", () => {
    const out = ctxToMessages([
      {
        role: "assistant",
        timestamp: 2000,
        content: [
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "answer" },
          { type: "image", data: "IMG", mimeType: "image/jpeg" },
        ],
      },
    ]);
    expect(out).toEqual([
      {
        role: "assistant",
        timestamp: 2000,
        parts: [
          { kind: "thinking", text: "let me think" },
          { kind: "text", text: "answer" },
          { kind: "image", data: "IMG", mimeType: "image/jpeg" },
        ],
      },
    ]);
  });

  it("assistant tool_use + 后续 tool_result → 回填 result/status=done", () => {
    const out = ctxToMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "read_file",
            input: { path: "a.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "file contents",
            is_error: false,
          },
        ],
      },
    ]);
    expect(out).toHaveLength(1); // role=tool 独立 message 被合并
    expect(out[0].role).toBe("assistant");
    expect(out[0].parts).toEqual([
      {
        kind: "tool",
        toolCallId: "call-1",
        toolName: "read_file",
        args: { path: "a.ts" },
        result: "file contents",
        isError: false,
        status: "done",
      },
    ]);
  });

  it("tool_result is_error=true → status=error", () => {
    const out = ctxToMessages([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c2", name: "bash" }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "c2",
            content: "boom",
            is_error: true,
          },
        ],
      },
    ]);
    expect(out[0].parts).toHaveLength(1);
    const tp = out[0].parts![0];
    expect(tp).toMatchObject({
      kind: "tool",
      toolCallId: "c2",
      status: "error",
      isError: true,
      result: "boom",
    });
  });

  it("assistant tool_use 但没有对应 tool_result → status=running", () => {
    const out = ctxToMessages([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "pending", name: "long_task", input: {} },
        ],
      },
    ]);
    expect(out[0].parts).toEqual([
      {
        kind: "tool",
        toolCallId: "pending",
        toolName: "long_task",
        args: {},
        result: undefined,
        isError: false,
        status: "running",
      },
    ]);
  });

  it("role=tool 的独立 message 不出现在输出里（即使没有对应的 tool_use）", () => {
    const out = ctxToMessages([
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "orphan", content: "x" },
        ],
      },
    ]);
    expect(out).toEqual([]);
  });

  it("跳过未知 role（system / 其它）", () => {
    const out = ctxToMessages([
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { role: "weird", content: [{ type: "text", text: "x" }] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });

  it("多轮顺序保留：user → assistant(tool_use) → tool → user", () => {
    const out = ctxToMessages([
      { role: "user", content: [{ type: "text", text: "q1" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking..." },
          { type: "tool_use", id: "t1", name: "search" },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "hits" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "q2" }] },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const assistant = out[1];
    expect(assistant.parts).toHaveLength(2);
    expect(assistant.parts![0]).toEqual({ kind: "text", text: "thinking..." });
    expect(assistant.parts![1]).toMatchObject({
      kind: "tool",
      toolCallId: "t1",
      status: "done",
      result: "hits",
    });
  });

  it("assistant tool_use 缺少 id 或 name → 跳过该 part", () => {
    const out = ctxToMessages([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "ok", name: "f" },
          { type: "tool_use", name: "no_id" },
          { type: "tool_use", id: "no_name" },
        ],
      },
    ]);
    expect(out[0].parts).toHaveLength(1);
    expect((out[0].parts![0] as { toolCallId: string }).toolCallId).toBe("ok");
  });
});

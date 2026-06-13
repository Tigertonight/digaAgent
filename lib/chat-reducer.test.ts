import { describe, it, expect } from "vitest";
import {
  appendRestoredSubagentBatches,
  applyEvent,
  createInitialState,
  ctxToMessages,
} from "./chat-reducer";
import type { ChatMessage, MessagePart } from "./types";

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

  it("assistant 认证失效且 content 为空 → 显示可操作错误提示", () => {
    const out = ctxToMessages([
      {
        role: "assistant",
        timestamp: 2000,
        stopReason: "error",
        errorMessage:
          "Your authentication token has been invalidated. Please try signing in again.",
        content: [],
      },
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].parts).toEqual([
      {
        kind: "text",
        text: "当前登录凭证已失效，请重新登录 ChatGPT Plus/Pro（Codex Subscription）或重新配置 Provider 凭证后再发送。",
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

describe("appendRestoredSubagentBatches", () => {
  it("appends persisted subagent batches that are not already present", () => {
    const messages = ctxToMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    ]);
    const out = appendRestoredSubagentBatches(messages, [
      {
        id: "batch-restored",
        parentAgentId: "agent-1",
        parentSessionPath: "/tmp/session.jsonl",
        status: "completed",
        reason: "restore audit",
        planning: {
          status: "accepted",
          plannedAt: 90,
          rationale: "restore audit",
          taskCount: 1,
          concurrency: 1,
          maxConcurrency: 1,
          warnings: [],
        },
        verification: {
          status: "passed",
          verifiedAt: 210,
          summary: "1 passed, 0 warnings, 0 failed.",
          passed: 1,
          warnings: 0,
          failed: 0,
        },
        synthesis: {
          status: "ready",
          generatedAt: 220,
          summary: "Synthesis ready: 1 usable, 0 caution, 0 rejected.",
          usableTaskIds: ["q1"],
          cautionTaskIds: [],
          rejectedTaskIds: [],
        },
        createdAt: 100,
        endedAt: 200,
        tasks: [
          {
            id: "q1",
            title: "Question 1",
            prompt: "Answer Q1",
            role: "general",
            status: "completed",
            answer: "restored answer",
            answerPreview: "restored answer",
            verification: {
              status: "passed",
              verifiedAt: 210,
              checks: [
                {
                  id: "answer-present",
                  status: "passed",
                  message: "Task produced an answer.",
                },
              ],
            },
            attempts: [
              {
                attempt: 1,
                status: "failed",
                error: "old failure",
                retriedAt: 150,
              },
            ],
          },
        ],
      },
    ]);

    expect(out).toHaveLength(2);
    const restored = out[1].parts?.[0];
    expect(restored?.kind).toBe("subagent_batch");
    if (restored?.kind !== "subagent_batch") throw new Error("type narrow");
    expect(restored.id).toBe("batch-restored");
    expect(restored.restored).toBe(true);
    expect(restored.planning?.status).toBe("accepted");
    expect(restored.verification?.status).toBe("passed");
    expect(restored.synthesis?.status).toBe("ready");
    expect(restored.tasks[0]).toMatchObject({
      status: "completed",
      answer: "restored answer",
      verification: { status: "passed" },
      attempts: [{ attempt: 1, status: "failed" }],
    });
  });

  it("does not append a persisted batch already reconstructed from tool results", () => {
    const seed: ChatMessage[] = [
      {
        role: "assistant",
        parts: [
          {
            kind: "subagent_batch",
            id: "batch-1",
            reason: "already present",
            status: "completed",
            createdAt: 100,
            tasks: [],
          },
        ],
      },
    ];
    const out = appendRestoredSubagentBatches(seed, [
      {
        id: "batch-1",
        parentAgentId: "agent-1",
        status: "completed",
        reason: "already present",
        createdAt: 100,
        tasks: [],
      },
    ]);
    expect(out).toBe(seed);
  });
});

describe("applyEvent — shim duplicate completion guards", () => {
  it("message_end 认证失效且 content 为空 → 不保留空 assistant 气泡", () => {
    let s = createInitialState();
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage:
        "Your authentication token has been invalidated. Please try signing in again.",
      content: [],
      timestamp: 1000,
    };

    s = applyEvent(s, { type: "message_start", message });
    s = applyEvent(s, { type: "message_end", message });

    expect(s.messages).toHaveLength(1);
    expect(s.activeAssistantIndex).toBe(-1);
    expect(s.messages[0].parts).toEqual([
      {
        kind: "text",
        text: "当前登录凭证已失效，请重新登录 ChatGPT Plus/Pro（Codex Subscription）或重新配置 Provider 凭证后再发送。",
      },
    ]);
  });

  it("uses full assistant content from message_start and ignores duplicate deltas", () => {
    let s = createInitialState();
    const message = {
      role: "assistant",
      responseId: "msg-1",
      content: [{ type: "text", text: "answer" }],
      stopReason: "stop",
      timestamp: 1000,
    };

    s = applyEvent(s, { type: "message_start", message });
    s = applyEvent(s, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "answer",
        partial: message,
      },
      message,
    });
    s = applyEvent(s, { type: "message_end", message });
    s = applyEvent(s, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "answer",
        partial: message,
      },
      message,
    });

    expect(s.messages).toHaveLength(1);
    expect(s.activeAssistantIndex).toBe(-1);
    expect(s.messages[0].parts).toEqual([{ kind: "text", text: "answer" }]);
  });

  it("ignores chunked delta replay after a full message_start", () => {
    let s = createInitialState();
    const message = {
      role: "assistant",
      responseId: "msg-chunk-replay",
      content: [{ type: "text", text: "hello world" }],
      timestamp: 1000,
    };

    s = applyEvent(s, { type: "message_start", message });
    for (const delta of ["hello", " ", "world"]) {
      s = applyEvent(s, {
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta,
          partial: { responseId: message.responseId },
        },
      });
    }
    s = applyEvent(s, { type: "message_end", message });

    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].parts).toEqual([{ kind: "text", text: "hello world" }]);
  });

  it("ignores full delta replay even when update responseId differs", () => {
    let s = createInitialState();
    const message = {
      role: "assistant",
      responseId: "msg-start-id",
      content: [{ type: "text", text: "我先看看你这个项目长啥样，再给针对性建议。" }],
      timestamp: 1000,
    };

    s = applyEvent(s, { type: "message_start", message });
    s = applyEvent(s, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "我先看看你这个项目长啥样，再给针对性建议。",
        partial: { responseId: "different-update-id" },
      },
    });

    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].parts).toEqual([
      { kind: "text", text: "我先看看你这个项目长啥样，再给针对性建议。" },
    ]);
  });

  it("continues appending when a delta extends beyond the replayed prefix", () => {
    let s = createInitialState();
    const message = {
      role: "assistant",
      responseId: "msg-replay-prefix",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1000,
    };

    s = applyEvent(s, { type: "message_start", message });
    s = applyEvent(s, {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "hello world",
        partial: { responseId: message.responseId },
      },
    });
    s = applyEvent(s, { type: "message_end", message });

    expect(s.messages[0].parts).toEqual([{ kind: "text", text: "hello world" }]);
  });

  it("does not create a second assistant for duplicate message_start responseId", () => {
    let s = createInitialState();
    const message = {
      role: "assistant",
      responseId: "msg-start-replay",
      content: [{ type: "text", text: "answer" }],
      timestamp: 1000,
    };

    s = applyEvent(s, { type: "message_start", message });
    s = applyEvent(s, { type: "message_start", message });

    expect(s.messages).toHaveLength(1);
    expect(s.activeAssistantIndex).toBe(0);
    expect(s.messages[0].parts).toEqual([{ kind: "text", text: "answer" }]);
  });

  it("ignores duplicate message_start after message_end for same responseId", () => {
    let s = createInitialState();
    const message = {
      role: "assistant",
      responseId: "msg-start-after-end",
      content: [{ type: "text", text: "answer" }],
      timestamp: 1000,
    };

    s = applyEvent(s, { type: "message_start", message });
    s = applyEvent(s, { type: "message_end", message });
    s = applyEvent(s, { type: "message_start", message });
    s = applyEvent(s, { type: "message_update", assistantMessageEvent: {
      type: "text_delta",
      delta: "answer",
      partial: { responseId: message.responseId },
    } });

    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].parts).toEqual([{ kind: "text", text: "answer" }]);
  });

  it("dedupes full non-streaming assistant starts without responseId in the same turn", () => {
    let s = createInitialState([
      { role: "user", parts: [{ kind: "text", text: "who are you" }] },
    ]);
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "I am pi." }],
      timestamp: 1000,
    };

    s = applyEvent(s, { type: "message_start", message });
    s = applyEvent(s, { type: "message_start", message });

    expect(s.messages).toHaveLength(2);
    expect(s.messages[1].parts).toEqual([{ kind: "text", text: "I am pi." }]);
  });

  it("merges a later responseId onto an existing full assistant in the same turn", () => {
    let s = createInitialState([
      { role: "user", parts: [{ kind: "text", text: "who are you" }] },
    ]);
    const first = {
      role: "assistant",
      content: [{ type: "text", text: "I am pi." }],
      timestamp: 1000,
    };
    const replay = {
      ...first,
      responseId: "msg-late-id",
      provider: "local-runway",
    };

    s = applyEvent(s, { type: "message_start", message: first });
    s = applyEvent(s, { type: "message_start", message: replay });

    expect(s.messages).toHaveLength(2);
    expect(s.messages[1].parts).toEqual([{ kind: "text", text: "I am pi." }]);
    expect(s.messages[1].meta?.responseId).toBe("msg-late-id");
  });

  it("keeps provider/model/usage pinned to the assistant message", () => {
    let s = createInitialState();
    const startMessage = {
      role: "assistant",
      responseId: "msg-usage",
      provider: "local-runway",
      model: "claude-opus-4-7",
      api: "openai-completions",
      content: [{ type: "text", text: "answer" }],
      timestamp: 1000,
    };
    const endMessage = {
      ...startMessage,
      usage: {
        input: 12,
        output: 8,
        cacheRead: 3,
        cacheWrite: 0,
        totalTokens: 23,
        cost: { total: 0.0012 },
      },
    };

    s = applyEvent(s, { type: "message_start", message: startMessage });
    s = applyEvent(s, { type: "message_end", message: endMessage });

    expect(s.messages[0].meta).toEqual({
      provider: "local-runway",
      model: "claude-opus-4-7",
      api: "openai-completions",
      responseId: "msg-usage",
      usage: {
        input: 12,
        output: 8,
        cacheRead: 3,
        cacheWrite: 0,
        total: 23,
        cost: 0.0012,
      },
    });
  });
});

describe("applyEvent — approval_request / approval_resolved (RFC-2 Phase B3)", () => {
  /** 帮助函数：先起一个 active assistant，再喂 approval_request。 */
  function setupActiveAssistantWithApproval() {
    let s = createInitialState();
    s = applyEvent(s, { type: "message_start", message: { role: "assistant" } });
    s = applyEvent(s, {
      type: "approval_request",
      request: {
        id: "agent-1:tool-call-A",
        toolCallId: "tool-call-A",
        toolName: "bash",
        input: { command: "rm -rf /tmp/xx" },
        ruleId: "dangerous-bash-destructive",
        createdAt: 1234,
      },
    });
    return s;
  }

  it("approval_request 在 active assistant 末尾 push approval part(status=pending)", () => {
    const s = setupActiveAssistantWithApproval();
    const msg = s.messages[s.activeAssistantIndex];
    const parts = msg.parts as MessagePart[];
    expect(parts).toHaveLength(1);
    const p = parts[0];
    expect(p.kind).toBe("approval");
    if (p.kind !== "approval") throw new Error("type narrow");
    expect(p.id).toBe("agent-1:tool-call-A");
    expect(p.toolCallId).toBe("tool-call-A");
    expect(p.toolName).toBe("bash");
    expect(p.status).toBe("pending");
    expect(p.ruleId).toBe("dangerous-bash-destructive");
    expect(p.input).toEqual({ command: "rm -rf /tmp/xx" });
    expect(p.createdAt).toBe(1234);
  });

  it("approval_resolved decision=allow → status=allowed + resolvedBy 记录", () => {
    let s = setupActiveAssistantWithApproval();
    s = applyEvent(s, {
      type: "approval_resolved",
      id: "agent-1:tool-call-A",
      decision: "allow",
      resolvedBy: "user",
    });
    const msg = s.messages[s.activeAssistantIndex];
    const p = (msg.parts as MessagePart[])[0];
    if (p.kind !== "approval") throw new Error("type narrow");
    expect(p.status).toBe("allowed");
    expect(p.resolvedBy).toBe("user");
    expect(p.denyReason).toBeUndefined();
  });

  it("approval_resolved decision=deny + denyReason → status=denied + denyReason 透传", () => {
    let s = setupActiveAssistantWithApproval();
    s = applyEvent(s, {
      type: "approval_resolved",
      id: "agent-1:tool-call-A",
      decision: "deny",
      resolvedBy: "user",
      denyReason: "太危险了",
    });
    const p = (s.messages[s.activeAssistantIndex].parts as MessagePart[])[0];
    if (p.kind !== "approval") throw new Error("type narrow");
    expect(p.status).toBe("denied");
    expect(p.denyReason).toBe("太危险了");
  });

  it("approval_resolved 找不到对应 id → state 不变（noop，不抛错）", () => {
    const before = setupActiveAssistantWithApproval();
    const after = applyEvent(before, {
      type: "approval_resolved",
      id: "non-existent-id",
      decision: "allow",
      resolvedBy: "user",
    });
    // approval part 仍是 pending
    const p = (after.messages[after.activeAssistantIndex].parts as MessagePart[])[0];
    if (p.kind !== "approval") throw new Error("type narrow");
    expect(p.status).toBe("pending");
  });

  it("同 id 重复 approval_request → 不重复 push（保持 1 个 approval part）", () => {
    let s = setupActiveAssistantWithApproval();
    s = applyEvent(s, {
      type: "approval_request",
      request: {
        id: "agent-1:tool-call-A",
        toolCallId: "tool-call-A",
        toolName: "bash",
        input: { command: "rm -rf /tmp/xx" },
        createdAt: 9999,
      },
    });
    const parts = s.messages[s.activeAssistantIndex].parts as MessagePart[];
    expect(parts).toHaveLength(1);
    // 仍是原 createdAt（去重以现有 part 为准）
    const p = parts[0];
    if (p.kind !== "approval") throw new Error("type narrow");
    expect(p.createdAt).toBe(1234);
  });

  it("approval_request 恢复到无 active assistant 的状态时会新建 pending 气泡", () => {
    let s = createInitialState([
      { role: "user", parts: [{ kind: "text", text: "run a command" }] },
      { role: "assistant", parts: [{ kind: "text", text: "checking..." }] },
    ]);
    s = applyEvent(s, {
      type: "approval_request",
      request: {
        id: "agent-1:tool-call-restored",
        toolCallId: "tool-call-restored",
        toolName: "bash",
        input: { command: "rm -rf /tmp/xx" },
        ruleId: "dangerous-bash-destructive",
        createdAt: 2345,
      },
    });

    expect(s.activeAssistantIndex).toBe(2);
    const msg = s.messages[2];
    expect(msg.role).toBe("assistant");
    const p = (msg.parts as MessagePart[])[0];
    if (p.kind !== "approval") throw new Error("type narrow");
    expect(p.status).toBe("pending");
    expect(p.id).toBe("agent-1:tool-call-restored");
  });

  it("approval_resolved 在 message_end 之后到达（active 已 closed）→ 仍能找到旧 assistant 的 approval part", () => {
    let s = setupActiveAssistantWithApproval();
    s = applyEvent(s, { type: "message_end", message: { role: "assistant" } });
    expect(s.activeAssistantIndex).toBe(-1);
    s = applyEvent(s, {
      type: "approval_resolved",
      id: "agent-1:tool-call-A",
      decision: "allow",
      resolvedBy: "user",
    });
    // active 已经 -1，但 reducer 应该在 messages 里倒序找到那条 assistant 并更新
    const m = s.messages[s.messages.length - 1];
    const p = (m.parts as MessagePart[])[0];
    if (p.kind !== "approval") throw new Error("type narrow");
    expect(p.status).toBe("allowed");
  });
});

describe("applyEvent — clarification_request / clarification_resolved (RFC-5)", () => {
  function clarificationRequest(id = "agent-1:q1") {
    return {
      id,
      agentId: "agent-1",
      requestId: id.split(":")[1] ?? "q1",
      title: "需要你确认下一步",
      question: "先做 MVP 还是完整重构？",
      context: "两条路径成本不同",
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
      createdAt: 3456,
    };
  }

  function setupActiveAssistantWithClarification() {
    let s = createInitialState();
    s = applyEvent(s, { type: "message_start", message: { role: "assistant" } });
    s = applyEvent(s, {
      type: "clarification_request",
      request: clarificationRequest(),
    });
    return s;
  }

  it("clarification_request 在 active assistant 末尾 push clarification part", () => {
    const s = setupActiveAssistantWithClarification();
    const parts = s.messages[s.activeAssistantIndex].parts as MessagePart[];
    expect(parts).toHaveLength(1);
    const p = parts[0];
    expect(p.kind).toBe("clarification");
    if (p.kind !== "clarification") throw new Error("type narrow");
    expect(p.id).toBe("agent-1:q1");
    expect(p.requestId).toBe("q1");
    expect(p.status).toBe("pending");
    expect(p.recommendedOptionId).toBe("mvp");
    expect(p.options).toHaveLength(2);
  });

  it("同 id 重复 clarification_request → 不重复 push", () => {
    let s = setupActiveAssistantWithClarification();
    s = applyEvent(s, {
      type: "clarification_request",
      request: { ...clarificationRequest(), createdAt: 9999 },
    });
    const parts = s.messages[s.activeAssistantIndex].parts as MessagePart[];
    expect(parts).toHaveLength(1);
    const p = parts[0];
    if (p.kind !== "clarification") throw new Error("type narrow");
    expect(p.createdAt).toBe(3456);
  });

  it("clarification_request 恢复到无 active assistant 时会新建 pending 卡片", () => {
    let s = createInitialState([
      { role: "user", parts: [{ kind: "text", text: "build it" }] },
      { role: "assistant", parts: [{ kind: "text", text: "I need a choice." }] },
    ]);
    s = applyEvent(s, {
      type: "clarification_request",
      request: clarificationRequest("agent-1:q-restored"),
    });

    expect(s.activeAssistantIndex).toBe(2);
    const p = (s.messages[2].parts as MessagePart[])[0];
    if (p.kind !== "clarification") throw new Error("type narrow");
    expect(p.status).toBe("pending");
    expect(p.id).toBe("agent-1:q-restored");
  });

  it("clarification_resolved 在 message_end 后仍能更新旧 assistant part", () => {
    let s = setupActiveAssistantWithClarification();
    s = applyEvent(s, { type: "message_end", message: { role: "assistant" } });
    expect(s.activeAssistantIndex).toBe(-1);
    s = applyEvent(s, {
      type: "clarification_resolved",
      id: "agent-1:q1",
      requestId: "q1",
      selectedOptionId: "mvp",
      resolvedBy: "user",
    });

    const m = s.messages[s.messages.length - 1];
    const p = (m.parts as MessagePart[])[0];
    if (p.kind !== "clarification") throw new Error("type narrow");
    expect(p.status).toBe("resolved");
    expect(p.selectedOptionId).toBe("mvp");
    expect(p.resolvedBy).toBe("user");
  });

  it("cowork: child clarification 携带 originAgentId/taskTitle 归属信息", () => {
    let s = createInitialState();
    s = applyEvent(s, { type: "message_start", message: { role: "assistant" } });
    s = applyEvent(s, {
      type: "clarification_request",
      request: {
        ...clarificationRequest("parent-1:child:child-9:q1"),
        agentId: "parent-1",
        originAgentId: "child-9",
        taskTitle: "重构 auth 模块",
      },
    });
    const parts = s.messages[s.activeAssistantIndex].parts as MessagePart[];
    const p = parts[0];
    if (p.kind !== "clarification") throw new Error("type narrow");
    expect(p.originAgentId).toBe("child-9");
    expect(p.taskTitle).toBe("重构 auth 模块");
    expect(p.status).toBe("pending");
  });
});

describe("applyEvent — subagent batch events (RFC-6)", () => {
  it("tracks subagent task progress inside one assistant part", () => {
    let s = createInitialState();
    s = applyEvent(s, { type: "message_start", message: { role: "assistant" } });
    s = applyEvent(s, {
      type: "subagent_batch_start",
      batch: {
        id: "batch-1",
        parentAgentId: "agent-1",
        status: "running",
        reason: "questions are independent",
        createdAt: 100,
        planning: {
          status: "accepted",
          plannedAt: 100,
          rationale: "questions are independent",
          taskCount: 2,
          concurrency: 2,
          maxConcurrency: 2,
          warnings: [],
        },
        tasks: [
          {
            id: "q1",
            title: "Question 1",
            prompt: "Answer Q1",
            role: "general",
            status: "pending",
          },
          {
            id: "q2",
            title: "Question 2",
            prompt: "Answer Q2",
            role: "rag",
            status: "pending",
          },
        ],
      },
    });

    let part = (s.messages[s.activeAssistantIndex].parts as MessagePart[])[0];
    expect(part.kind).toBe("subagent_batch");
    if (part.kind !== "subagent_batch") throw new Error("type narrow");
    expect(part.planning?.concurrency).toBe(2);
    expect(part.tasks.map((task) => task.status)).toEqual([
      "pending",
      "pending",
    ]);

    s = applyEvent(s, {
      type: "subagent_task_start",
      batchId: "batch-1",
      taskId: "q1",
      agentId: "child-1",
      title: "Question 1",
      role: "general",
      startedAt: 120,
    });
    s = applyEvent(s, {
      type: "subagent_task_end",
      batchId: "batch-1",
      taskId: "q1",
      status: "completed",
      answerPreview: "Q1 answer",
      endedAt: 180,
      verification: {
        status: "passed",
        verifiedAt: 181,
        checks: [
          {
            id: "answer-present",
            status: "passed",
            message: "Task produced an answer.",
          },
        ],
      },
    });
    s = applyEvent(s, {
      type: "subagent_batch_end",
      batchId: "batch-1",
      status: "completed",
      endedAt: 220,
      verification: {
        status: "warning",
        verifiedAt: 220,
        summary: "1 passed, 1 warnings, 0 failed.",
        passed: 1,
        warnings: 1,
        failed: 0,
      },
      synthesis: {
        status: "partial",
        generatedAt: 221,
        summary: "Synthesis partial: 1 usable, 1 caution, 0 rejected.",
        usableTaskIds: ["q1"],
        cautionTaskIds: ["q2"],
        rejectedTaskIds: [],
      },
    });

    part = (s.messages[s.activeAssistantIndex].parts as MessagePart[])[0];
    if (part.kind !== "subagent_batch") throw new Error("type narrow");
    expect(part.status).toBe("completed");
    expect(part.endedAt).toBe(220);
    expect(part.verification?.status).toBe("warning");
    expect(part.synthesis?.status).toBe("partial");
    expect(part.tasks[0]).toMatchObject({
      status: "completed",
      agentId: "child-1",
      answerPreview: "Q1 answer",
      startedAt: 120,
      endedAt: 180,
      verification: { status: "passed" },
    });
    expect(part.tasks[1].status).toBe("pending");
  });

  it("merges subagent retry attempts from task events", () => {
    let s = createInitialState();
    s = applyEvent(s, { type: "message_start", message: { role: "assistant" } });
    s = applyEvent(s, {
      type: "subagent_batch_start",
      batch: {
        id: "batch-retry",
        parentAgentId: "agent-1",
        status: "running",
        reason: "retry one task",
        createdAt: 100,
        tasks: [
          {
            id: "q1",
            title: "Question 1",
            prompt: "Answer Q1",
            role: "general",
            status: "completed",
            answer: "old answer",
            attempts: [
              {
                attempt: 1,
                agentId: "child-1",
                status: "failed",
                error: "first failure",
                retriedAt: 150,
              },
            ],
          },
        ],
      },
    });

    const attempts = [
      {
        attempt: 1,
        agentId: "child-1",
        status: "failed" as const,
        error: "first failure",
        retriedAt: 150,
      },
      {
        attempt: 2,
        agentId: "child-2",
        status: "completed" as const,
        answer: "old answer",
        retriedAt: 200,
      },
    ];
    s = applyEvent(s, {
      type: "subagent_task_start",
      batchId: "batch-retry",
      taskId: "q1",
      agentId: "child-3",
      title: "Question 1",
      role: "general",
      startedAt: 220,
      attempts,
    });
    s = applyEvent(s, {
      type: "subagent_task_end",
      batchId: "batch-retry",
      taskId: "q1",
      status: "completed",
      answer: "new answer",
      endedAt: 260,
      attempts,
    });

    const part = (s.messages[s.activeAssistantIndex].parts as MessagePart[])[0];
    if (part.kind !== "subagent_batch") throw new Error("type narrow");
    expect(part.tasks[0].attempts).toEqual(attempts);
    expect(part.tasks[0]).toMatchObject({
      status: "completed",
      agentId: "child-3",
      answer: "new answer",
    });
  });
});

describe("applyEvent — workflow script events", () => {
  it("tracks workflow checkpoints, artifacts, logs, and completion", () => {
    let s = createInitialState();
    s = applyEvent(s, { type: "message_start", message: { role: "assistant" } });
    s = applyEvent(s, {
      type: "workflow_start",
      run: {
        id: "workflow-1",
        parentAgentId: "agent-1",
        objective: "Review project",
        rationale: "Needs a generated harness",
        status: "running",
        script: "return true",
        manifest: {
          capabilities: ["spawn_agent", "read_files"],
          maxAgents: 8,
          maxConcurrency: 4,
          timeoutMs: 600000,
          runtime: "process",
        },
        artifacts: [],
        checkpoints: [],
        logs: [],
        createdAt: 100,
      },
    });
    s = applyEvent(s, {
      type: "workflow_log",
      workflowId: "workflow-1",
      log: { level: "info", message: "stage:start", createdAt: 110 },
    });
    s = applyEvent(s, {
      type: "workflow_checkpoint",
      workflowId: "workflow-1",
      checkpoint: { name: "draft", value: { ok: true }, createdAt: 120 },
    });
    s = applyEvent(s, {
      type: "workflow_artifact",
      workflowId: "workflow-1",
      artifact: { name: "summary", value: "done", createdAt: 130 },
    });
    s = applyEvent(s, {
      type: "workflow_end",
      workflowId: "workflow-1",
      status: "completed",
      endedAt: 180,
      artifacts: [{ name: "summary", value: "done", createdAt: 130 }],
      checkpoints: [{ name: "draft", value: { ok: true }, createdAt: 120 }],
      logs: [{ level: "info", message: "stage:start", createdAt: 110 }],
      returnValue: { ok: true },
    });

    const part = (s.messages[s.activeAssistantIndex].parts as MessagePart[])[0];
    expect(part.kind).toBe("workflow_run");
    if (part.kind !== "workflow_run") throw new Error("type narrow");
    expect(part.status).toBe("completed");
    expect(part.checkpoints[0].name).toBe("draft");
    expect(part.artifacts[0].name).toBe("summary");
    expect(part.logs[0].message).toBe("stage:start");
    expect(part.returnValue).toEqual({ ok: true });
  });
});

import { describe, it, expect } from "vitest";
import { applyEvent, createInitialState, ctxToMessages } from "./chat-reducer";
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
});

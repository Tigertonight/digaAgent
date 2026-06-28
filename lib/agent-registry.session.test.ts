/**
 * T1.2 / T3.1：会话生命周期相关守门测试。
 *
 * 由于 lib/agent-registry.ts 大量依赖 SDK / Next.js 上下文，这里只覆盖两个不依赖
 * 完整运行时的纯函数 / 行为契约：
 *
 *   1) finalizeAfterAbort：必须先清 finishWatchdog / toolWatchdog，再把 isStreaming
 *      置 false，避免“点击中止后过 1.5s 又跑一轮”。
 *   2) createAgent in-flight 去重：覆盖在另外的 e2e 套件，这里仅校验导出存在性。
 */
import { describe, it, expect } from "vitest";

// 极小桩：finalizeAfterAbort 只读写 record 上四个字段，不需要真实 AgentRecord。
type StubRecord = {
  finishWatchdog: ReturnType<typeof setTimeout> | null;
  toolWatchdog: ReturnType<typeof setTimeout> | null;
  pendingFinishMessage: unknown;
  pendingToolCall: unknown;
  isStreaming: boolean;
  updatedAt: number;
};

function makeStub(): StubRecord {
  return {
    finishWatchdog: setTimeout(() => {}, 60_000),
    toolWatchdog: setTimeout(() => {}, 60_000),
    pendingFinishMessage: { foo: 1 },
    pendingToolCall: { id: "x" },
    isStreaming: true,
    updatedAt: 0,
  };
}

describe("finalizeAfterAbort", () => {
  it("清 finishWatchdog / toolWatchdog 并置 isStreaming=false（避免 ghost run）", async () => {
    const { finalizeAfterAbort } = await import("./agent-registry");
    const rec = makeStub();
    const before = rec.finishWatchdog;
    expect(before).toBeTruthy();

    finalizeAfterAbort(rec as never);

    expect(rec.finishWatchdog).toBeNull();
    expect(rec.toolWatchdog).toBeNull();
    expect(rec.pendingFinishMessage).toBeNull();
    expect(rec.pendingToolCall).toBeNull();
    expect(rec.isStreaming).toBe(false);
    expect(rec.updatedAt).toBeGreaterThan(0);
  });

  it("即使 record 上 watchdog 已为 null 也不报错（幂等）", async () => {
    const { finalizeAfterAbort } = await import("./agent-registry");
    const rec: StubRecord = {
      finishWatchdog: null,
      toolWatchdog: null,
      pendingFinishMessage: null,
      pendingToolCall: null,
      isStreaming: true,
      updatedAt: 0,
    };
    expect(() => finalizeAfterAbort(rec as never)).not.toThrow();
    expect(rec.isStreaming).toBe(false);
  });
});

describe("finishStreamingAfterPromptError", () => {
  it("pushes agent_end when it closes a streaming run", async () => {
    const mod = await import("./agent-registry");
    const g = globalThis as unknown as {
      __digaAgent: { agents: Map<string, unknown> };
    };
    const rec: StubRecord & {
      id: string;
      session: { dispose: () => void };
      cwd: string;
      events: Array<{ seq: number; event: { type: string } } | undefined>;
      nextSeq: number;
      listeners: Set<() => void>;
      unsubscribe: () => void;
      lastAgentEndAt: number | null;
      recentClientRequests: Map<string, number>;
    } = {
      id: "agent-prompt-error",
      session: { dispose: () => undefined },
      cwd: "/tmp",
      events: [],
      nextSeq: 0,
      listeners: new Set<() => void>(),
      unsubscribe: () => undefined,
      isStreaming: true,
      updatedAt: 0,
      lastAgentEndAt: null,
      recentClientRequests: new Map(),
      finishWatchdog: null,
      pendingFinishMessage: null,
      toolWatchdog: null,
      pendingToolCall: null,
    };
    g.__digaAgent.agents.set("agent-prompt-error", rec);

    try {
      mod.finishStreamingAfterPromptError("agent-prompt-error");

      expect(rec.isStreaming).toBe(false);
      expect(rec.lastAgentEndAt).toEqual(expect.any(Number));
      expect(rec.events.map((item) => item?.event)).toContainEqual({
        type: "agent_end",
      });
    } finally {
      g.__digaAgent.agents.delete("agent-prompt-error");
    }
  });

  it("disposeAgent awaits parent workflow/subagent abort before deleting the record", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./agent-registry.ts", import.meta.url), "utf8")
    );

    expect(source).toContain("export async function disposeAgent");
    expect(source).toContain("await Promise.allSettled");
    expect(source.indexOf("await Promise.allSettled")).toBeLessThan(
      source.indexOf("reg.agents.delete(id)")
    );
  });
});

describe("finishStreamingAfterAbort", () => {
  it("pushes agent_end when it closes a streaming run", async () => {
    const mod = await import("./agent-registry");
    const g = globalThis as unknown as {
      __digaAgent: { agents: Map<string, unknown> };
    };
    const rec: StubRecord & {
      id: string;
      session: { dispose: () => void };
      cwd: string;
      events: Array<{ seq: number; event: { type: string } } | undefined>;
      nextSeq: number;
      listeners: Set<() => void>;
      unsubscribe: () => void;
      lastAgentEndAt: number | null;
      recentClientRequests: Map<string, number>;
    } = {
      id: "agent-abort",
      session: { dispose: () => undefined },
      cwd: "/tmp",
      events: [],
      nextSeq: 0,
      listeners: new Set<() => void>(),
      unsubscribe: () => undefined,
      isStreaming: true,
      updatedAt: 0,
      lastAgentEndAt: null,
      recentClientRequests: new Map(),
      finishWatchdog: null,
      pendingFinishMessage: null,
      toolWatchdog: null,
      pendingToolCall: null,
    };
    g.__digaAgent.agents.set("agent-abort", rec);

    try {
      mod.finishStreamingAfterAbort("agent-abort");

      expect(rec.isStreaming).toBe(false);
      expect(rec.lastAgentEndAt).toEqual(expect.any(Number));
      expect(rec.events.map((item) => item?.event)).toContainEqual({
        type: "agent_end",
      });
    } finally {
      g.__digaAgent.agents.delete("agent-abort");
    }
  });
});

describe("forceFinishStream contract", () => {
  it("centralizes forced terminal paths that synthesize agent_end", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./agent-registry.ts", import.meta.url), "utf8")
    );

    expect(source).toContain("function forceFinishStream");
    expect(source).toContain("finishStreamingAfterPromptError(agentId: string)");
    expect(source).toMatch(
      /finishStreamingAfterPromptError[\s\S]*forceFinishStream\(rec/
    );
    expect(source).toMatch(/finishStreamingAfterAbort[\s\S]*forceFinishStream\(rec/);
    expect(source).toMatch(/reason: "tool_timeout"[\s\S]*pushAgentEnd: true/);
  });
});

describe("createAgent in-flight dedup（导出契约）", () => {
  it("createAgent 与 finalizeAfterAbort 都被正确导出", async () => {
    const mod = await import("./agent-registry");
    expect(typeof mod.createAgent).toBe("function");
    expect(typeof mod.finalizeAfterAbort).toBe("function");
  });
});

describe("buildLocalCodingAssistantPromptWithContext", () => {
  it("includes recent visible Team final answers for follow-up questions", async () => {
    const { buildLocalCodingAssistantPromptWithContext } = await import(
      "./agent-registry"
    );
    const prompt = buildLocalCodingAssistantPromptWithContext(
      {
        session: {
          agent: {
            state: {
              messages: [
                {
                  role: "user",
                  content: "检查一个不存在的文件",
                },
                {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text:
                        "结论\n\n不存在 — 当前项目里没有找到 `/definitely-not-a-real-file-xyz.ts`。\n\n<!-- agent-team-final:team-1 -->",
                    },
                  ],
                },
              ],
            },
          },
        },
      } as never,
      "这个结论用一句话解释一下。"
    );

    expect(prompt).toContain("最近的可见会话上下文");
    expect(prompt).toContain("不存在 — 当前项目里没有找到");
    expect(prompt).not.toContain("agent-team-final");
    expect(prompt).toContain("用户的新问题：\n这个结论用一句话解释一下。");
  });

  it("returns the original text when there is no useful history", async () => {
    const { buildLocalCodingAssistantPromptWithContext } = await import(
      "./agent-registry"
    );

    expect(
      buildLocalCodingAssistantPromptWithContext(
        {
          session: { agent: { state: { messages: [] } } },
        } as never,
        "你好"
      )
    ).toBe("你好");
  });

  it("filters provider errors from follow-up history", async () => {
    const { buildLocalCodingAssistantPromptWithContext } = await import(
      "./agent-registry"
    );

    const prompt = buildLocalCodingAssistantPromptWithContext(
      {
        session: {
          agent: {
            state: {
              messages: [
                {
                  role: "assistant",
                  content:
                    'API Error: 500 {"error":"ValidationException: messages: Unexpected role \\"system\\"."} [自研 Coding 助手退出，代码 1]',
                },
              ],
            },
          },
        },
      } as never,
      "继续回答刚才的问题"
    );

    expect(prompt).toBe("继续回答刚才的问题");
    expect(prompt).not.toContain("Unexpected role");
    expect(prompt).not.toContain("API Error");
  });

  it("filters process-only Team card text but keeps final conclusions", async () => {
    const { buildLocalCodingAssistantPromptWithContext } = await import(
      "./agent-registry"
    );

    const prompt = buildLocalCodingAssistantPromptWithContext(
      {
        session: {
          agent: {
            state: {
              messages: [
                {
                  role: "assistant",
                  content:
                    "团队协作处理中\n\n开始执行任务\n成员记录已准备好，等待领取任务。\n进度 1/4",
                },
                {
                  role: "assistant",
                  content:
                    "结论\n\n存在 — 已确认 app/page.tsx 在当前项目中。\n\n<!-- agent-team-final:team-ok -->",
                },
              ],
            },
          },
        },
      } as never,
      "这次最终确认的文件是什么？"
    );

    expect(prompt).toContain("存在 — 已确认 app/page.tsx");
    expect(prompt).not.toContain("团队协作处理中");
    expect(prompt).not.toContain("agent-team-final");
  });
});

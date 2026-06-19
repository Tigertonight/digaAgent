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

describe("createAgent in-flight dedup（导出契约）", () => {
  it("createAgent 与 finalizeAfterAbort 都被正确导出", async () => {
    const mod = await import("./agent-registry");
    expect(typeof mod.createAgent).toBe("function");
    expect(typeof mod.finalizeAfterAbort).toBe("function");
  });
});

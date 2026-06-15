import { describe, expect, it } from "vitest";
import { shouldRefreshSidebarOnEvent } from "./useAgentEvents";

describe("shouldRefreshSidebarOnEvent", () => {
  it("approval_request / approval_resolved / clarification_request / clarification_resolved 触发 sidebar 刷新", () => {
    expect(shouldRefreshSidebarOnEvent("approval_request")).toBe(true);
    expect(shouldRefreshSidebarOnEvent("approval_resolved")).toBe(true);
    expect(shouldRefreshSidebarOnEvent("clarification_request")).toBe(true);
    expect(shouldRefreshSidebarOnEvent("clarification_resolved")).toBe(true);
  });

  it("普通流式 / 工具事件不触发 sidebar 刷新（避免无意义全量 fetch）", () => {
    expect(shouldRefreshSidebarOnEvent("message_start")).toBe(false);
    expect(shouldRefreshSidebarOnEvent("message_update")).toBe(false);
    expect(shouldRefreshSidebarOnEvent("message_end")).toBe(false);
    expect(shouldRefreshSidebarOnEvent("tool_execution_start")).toBe(false);
    expect(shouldRefreshSidebarOnEvent("tool_execution_update")).toBe(false);
    expect(shouldRefreshSidebarOnEvent("tool_execution_end")).toBe(false);
  });

  it("agent_start / agent_end 走自己的路径（refreshSessions 在 agent_end 里直接调用）", () => {
    // 这两类事件不通过 scheduleRefreshSessions 调度——agent_end 同步直接 refreshSessions
    expect(shouldRefreshSidebarOnEvent("agent_start")).toBe(false);
    expect(shouldRefreshSidebarOnEvent("agent_end")).toBe(false);
  });

  it("subagent / workflow / browser 事件不直接触发 sidebar 刷新", () => {
    expect(shouldRefreshSidebarOnEvent("subagent_batch_start")).toBe(false);
    expect(shouldRefreshSidebarOnEvent("subagent_batch_end")).toBe(false);
    expect(shouldRefreshSidebarOnEvent("workflow_start")).toBe(false);
    expect(shouldRefreshSidebarOnEvent("workflow_end")).toBe(false);
    expect(shouldRefreshSidebarOnEvent("browser_state")).toBe(false);
  });

  it("未知事件类型默认不触发", () => {
    expect(shouldRefreshSidebarOnEvent("anything-else")).toBe(false);
    expect(shouldRefreshSidebarOnEvent("")).toBe(false);
  });
});

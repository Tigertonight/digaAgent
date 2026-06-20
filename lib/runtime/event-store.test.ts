import { beforeEach, describe, expect, it } from "vitest";
import {
  __MAX_EVENTS_PER_AGENT_FOR_TEST,
  __resetRuntimeEventStoreForTest,
  appendRuntimeEvent,
  disposeRuntimeEventsForAgent,
  getRuntimeEvent,
  listRuntimeEvents,
} from "./event-store";

describe("runtime event store", () => {
  beforeEach(() => {
    __resetRuntimeEventStoreForTest();
  });

  it("appends and lists runtime events by source and owner", () => {
    appendRuntimeEvent({
      id: "progress-1",
      source: "progress",
      type: "progress.update",
      status: "running",
      sessionId: "session-1",
      agentId: "agent-1",
      payload: { steps: 1 },
      createdAt: 2,
    });
    appendRuntimeEvent({
      id: "browser-1",
      source: "browser",
      type: "browser.open",
      status: "done",
      sessionId: "session-1",
      browserId: "agent:agent-1",
      payload: { url: "http://localhost:3000" },
      createdAt: 1,
    });

    expect(listRuntimeEvents({ sessionId: "session-1" }).map((e) => e.id)).toEqual([
      "browser-1",
      "progress-1",
    ]);
    expect(listRuntimeEvents({ source: "browser" })).toHaveLength(1);
    expect(listRuntimeEvents({ status: "running" })).toHaveLength(1);
  });

  it("upserts stable events", () => {
    appendRuntimeEvent({
      id: "event-1",
      source: "approval",
      type: "approval.request",
      status: "running",
      payload: {},
      createdAt: 1,
    });
    appendRuntimeEvent({
      id: "event-1",
      source: "approval",
      type: "approval.decision",
      status: "done",
      payload: { decision: "denied" },
      createdAt: 1,
      updatedAt: 2,
    });

    expect(listRuntimeEvents()).toHaveLength(1);
    expect(getRuntimeEvent("event-1")).toMatchObject({
      type: "approval.decision",
      status: "done",
      updatedAt: 2,
    });
  });

  it("caps events per agent without evicting unrelated agents", () => {
    for (let i = 0; i < __MAX_EVENTS_PER_AGENT_FOR_TEST + 1; i++) {
      appendRuntimeEvent({
        id: `agent-1-${i}`,
        source: "progress",
        type: "progress.update",
        status: "running",
        agentId: "agent-1",
        payload: { i },
        createdAt: i,
      });
    }
    appendRuntimeEvent({
      id: "agent-2-keeper",
      source: "progress",
      type: "progress.update",
      status: "running",
      agentId: "agent-2",
      payload: {},
      createdAt: 99_999,
    });

    expect(getRuntimeEvent("agent-1-0")).toBeNull();
    expect(listRuntimeEvents({ agentId: "agent-1" })).toHaveLength(
      __MAX_EVENTS_PER_AGENT_FOR_TEST
    );
    expect(getRuntimeEvent("agent-2-keeper")).not.toBeNull();
  });

  it("disposes events linked to an agent through related dimensions", () => {
    appendRuntimeEvent({
      id: "direct",
      source: "agent",
      type: "agent.start",
      status: "running",
      agentId: "agent-1",
      payload: {},
      createdAt: 1,
    });
    appendRuntimeEvent({
      id: "browser",
      source: "browser",
      type: "browser.open",
      status: "done",
      browserId: "agent:agent-1",
      payload: {},
      createdAt: 2,
    });
    appendRuntimeEvent({
      id: "child",
      source: "subagent",
      type: "subagent.task",
      status: "running",
      parentId: "agent-1",
      payload: {},
      createdAt: 3,
    });
    appendRuntimeEvent({
      id: "workflow:agent-1:run-1",
      source: "workflow",
      type: "workflow.start",
      status: "running",
      workflowId: "run-1",
      payload: {},
      createdAt: 4,
    });
    appendRuntimeEvent({
      id: "other",
      source: "agent",
      type: "agent.start",
      status: "running",
      agentId: "agent-2",
      payload: {},
      createdAt: 5,
    });

    expect(disposeRuntimeEventsForAgent("agent-1")).toBe(4);

    expect(listRuntimeEvents().map((event) => event.id)).toEqual(["other"]);
  });
});

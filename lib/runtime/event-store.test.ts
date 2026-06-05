import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetRuntimeEventStoreForTest,
  appendRuntimeEvent,
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
});

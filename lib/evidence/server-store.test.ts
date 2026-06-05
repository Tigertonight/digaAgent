import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetEvidenceStoreForTest,
  appendEvidence,
  getEvidence,
  listEvidence,
} from "./server-store";

describe("evidence server store", () => {
  beforeEach(() => {
    __resetEvidenceStoreForTest();
  });

  it("appends and lists evidence by ownership ids", () => {
    appendEvidence({
      id: "browser-1",
      kind: "browser_step",
      title: "Open fixture",
      sessionId: "session-1",
      agentId: "agent-1",
      browserId: "agent:agent-1",
      createdAt: 2,
    });
    appendEvidence({
      id: "workflow-1",
      kind: "workflow_artifact",
      title: "Workflow artifact",
      sessionId: "session-1",
      workflowId: "workflow-1",
      createdAt: 1,
    });

    expect(listEvidence({ sessionId: "session-1" }).map((e) => e.id)).toEqual([
      "workflow-1",
      "browser-1",
    ]);
    expect(listEvidence({ browserId: "agent:agent-1" })).toHaveLength(1);
    expect(listEvidence({ workflowId: "workflow-1" })).toHaveLength(1);
  });

  it("upserts by stable id instead of duplicating", () => {
    appendEvidence({
      id: "same",
      kind: "log",
      title: "First",
      createdAt: 1,
    });
    appendEvidence({
      id: "same",
      kind: "log",
      title: "Second",
      textPreview: "updated",
      createdAt: 1,
      updatedAt: 2,
    });

    expect(listEvidence()).toHaveLength(1);
    expect(getEvidence("same")).toMatchObject({
      title: "Second",
      textPreview: "updated",
      updatedAt: 2,
    });
  });
});

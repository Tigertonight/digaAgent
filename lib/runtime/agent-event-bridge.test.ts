import { describe, expect, it } from "vitest";
import { bridgeAgentEventToRuntime } from "./agent-event-bridge";

const ctx = {
  agentId: "agent-1",
  sessionId: "session-1",
  sessionPath: "/tmp/session.jsonl",
  cwd: "/repo",
  seq: 42,
};

describe("bridgeAgentEventToRuntime", () => {
  it("bridges browser steps and annotations into evidence", () => {
    const result = bridgeAgentEventToRuntime(ctx, {
      type: "browser_state",
      snapshot: {
        status: "ready",
        url: "http://localhost:3000",
        title: "Local",
        screenshotDataUrl: "data:image/png;base64,aaa",
        updatedAt: 10,
        error: null,
        pointer: null,
        task: null,
        logs: [],
        steps: [
          {
            id: "step-1",
            action: "open",
            label: "fixture",
            status: "done",
            url: "http://localhost:3000",
            title: "Local",
            screenshotDataUrl: "data:image/png;base64,aaa",
            pointer: null,
            createdAt: 11,
          },
        ],
        annotations: [
          {
            id: "ann-1",
            browserId: "agent:agent-1",
            url: "http://localhost:3000",
            title: "Local",
            rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
            comment: "Fix this button",
            screenshotDataUrl: "data:image/png;base64,bbb",
            createdAt: 12,
            status: "open",
          },
        ],
      },
    });

    expect(result?.event).toMatchObject({
      source: "browser",
      type: "browser.state",
      status: "done",
      browserId: "agent:agent-1",
    });
    expect(result?.evidence.map((item) => item.kind)).toEqual([
      "browser_step",
      "browser_annotation",
    ]);
  });

  it("bridges progress artifacts", () => {
    const result = bridgeAgentEventToRuntime(ctx, {
      type: "progress_updated",
      progress: {
        steps: [{ id: "step-1", title: "Done", status: "completed" }],
        groups: [
          {
            id: "group-1",
            index: 1,
            steps: [{ id: "step-1", title: "Done", status: "completed" }],
            startedAt: 99,
            endedAt: 101,
          },
        ],
        artifacts: [
          {
            id: "url-1",
            kind: "url",
            title: "Local app",
            href: "http://localhost:3000",
            createdAt: 100,
          },
        ],
        updatedAt: 101,
      },
    });

    expect(result?.event).toMatchObject({
      source: "progress",
      status: "done",
    });
    expect(result?.evidence[0]).toMatchObject({
      id: "progress-artifact:agent-1:url-1",
      kind: "progress_artifact",
      url: "http://localhost:3000",
    });
  });

  it("normalizes browser, progress, and goal statuses", () => {
    const busyBrowser = bridgeAgentEventToRuntime(ctx, {
      type: "browser_state",
      snapshot: {
        status: "busy",
        url: null,
        title: null,
        screenshotDataUrl: null,
        updatedAt: 10,
        error: null,
        pointer: null,
        task: null,
        logs: [],
        steps: [],
        annotations: [],
      },
    });
    const blockedProgress = bridgeAgentEventToRuntime(ctx, {
      type: "progress_updated",
      progress: {
        steps: [{ id: "step-1", title: "Wait", status: "blocked" }],
        groups: [],
        artifacts: [],
        updatedAt: 101,
      },
    });
    const activeGoal = bridgeAgentEventToRuntime(ctx, {
      type: "goal_updated",
      goal: {
        objective: "Ship runtime bridge",
        status: "active",
        turns: 3,
        updatedAt: 102,
      },
    });

    expect(busyBrowser?.event.status).toBe("running");
    expect(blockedProgress?.event.status).toBe("blocked");
    expect(activeGoal?.event.status).toBe("running");
  });

  it("bridges approval decisions", () => {
    const result = bridgeAgentEventToRuntime(ctx, {
      type: "approval_resolved",
      id: "agent-1:tool-1",
      toolCallId: "tool-1",
      decision: "deny",
      resolvedBy: "user",
      denyReason: "Nope.",
    });

    expect(result?.event).toMatchObject({
      source: "approval",
      type: "approval.resolved",
      status: "error",
    });
    expect(result?.evidence[0]).toMatchObject({
      kind: "approval_decision",
      textPreview: "Nope.",
    });
  });

  it("bridges workflow artifacts and subagent results", () => {
    const workflow = bridgeAgentEventToRuntime(ctx, {
      type: "workflow_artifact",
      workflowId: "wf-1",
      artifact: { name: "result.json", value: { ok: true }, createdAt: 1 },
    });
    const subagent = bridgeAgentEventToRuntime(ctx, {
      type: "subagent_batch_end",
      batchId: "batch-1",
      status: "completed",
      endedAt: 2,
      results: [
        {
          taskId: "task-1",
          agentId: "child-1",
          status: "completed",
          answer: "Done",
          startedAt: 1,
          endedAt: 2,
        },
      ],
    });

    expect(workflow?.evidence[0]).toMatchObject({
      kind: "workflow_artifact",
      workflowId: "wf-1",
    });
    expect(subagent?.evidence[0]).toMatchObject({
      kind: "subagent_result",
      taskId: "task-1",
      textPreview: "Done",
    });
  });
});

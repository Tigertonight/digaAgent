import { describe, expect, it } from "vitest";
import { browserIdForRuntime, resolveRuntimeIdentity } from "./identity";

describe("resolveRuntimeIdentity", () => {
  it("resolves draft mode to the default standalone browser", () => {
    expect(
      resolveRuntimeIdentity({
        selectedSessionId: null,
        selectedSessionPath: null,
        cwd: "/repo",
        activeRunnerKey: "draft",
        liveAgentId: null,
      })
    ).toEqual({
      mode: "draft",
      sessionId: null,
      sessionPath: null,
      cwd: "/repo",
      runnerKey: "draft",
      agentId: null,
      browserId: "standalone:default",
    });
  });

  it("resolves persisted-only mode to a session-scoped standalone browser", () => {
    const identity = resolveRuntimeIdentity({
      selectedSessionId: "session-1",
      selectedSessionPath: "/sessions/session-1.json",
      cwd: "/repo",
      activeRunnerKey: "session-1",
      liveAgentId: null,
    });

    expect(identity.mode).toBe("persisted_only");
    expect(identity.agentId).toBeNull();
    expect(identity.browserId).toBe("standalone:session:session-1");
  });

  it("resolves live mode to an agent browser", () => {
    const identity = resolveRuntimeIdentity({
      selectedSessionId: "session-1",
      selectedSessionPath: "/sessions/session-1.json",
      cwd: "/repo",
      activeRunnerKey: "session-1",
      liveAgentId: "agent-1",
    });

    expect(identity.mode).toBe("live");
    expect(identity.agentId).toBe("agent-1");
    expect(identity.browserId).toBe("agent:agent-1");
  });

  it("lets task browsers override agent and session ownership", () => {
    expect(
      browserIdForRuntime({
        taskId: "task-1",
        agentId: "agent-1",
        sessionId: "session-1",
      })
    ).toBe("task:task-1");
  });

  it("does not retain stale agent ownership across session switches", () => {
    const live = resolveRuntimeIdentity({
      selectedSessionId: "session-a",
      selectedSessionPath: "/sessions/a.json",
      cwd: "/repo",
      activeRunnerKey: "session-a",
      liveAgentId: "agent-a",
    });
    const historical = resolveRuntimeIdentity({
      selectedSessionId: "session-b",
      selectedSessionPath: "/sessions/b.json",
      cwd: "/repo",
      activeRunnerKey: "session-b",
      liveAgentId: null,
    });

    expect(live.browserId).toBe("agent:agent-a");
    expect(historical.agentId).toBeNull();
    expect(historical.browserId).toBe("standalone:session:session-b");
  });
});

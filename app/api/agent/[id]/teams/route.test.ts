import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routePath = path.resolve(__dirname, "route.ts");

function readRouteSource() {
  return fs.readFileSync(routePath, "utf8");
}

describe("agent team route auto advance fallback", () => {
  it("schedules backend auto advance when team runs are stale on read", () => {
    const source = readRouteSource();

    expect(source).toContain("shouldAutoKickAgentTeamRun");
    expect(source).toContain("SERVER_AGENT_TEAM_AUTO_ADVANCE_COOLDOWN_MS");
    expect(source).toContain("backend auto advance scheduled");
    expect(source).toContain("scheduleAgentTeamAutoAdvance(req, agentId, run.id, run.members.length)");
  });

  it("checks both single team reads and team list reads", () => {
    const source = readRouteSource();

    expect(source).toContain("maybeScheduleStaleAgentTeamAutoAdvance(req, id, run);");
    expect(source).toContain("for (const run of runs) {\n    maybeScheduleStaleAgentTeamAutoAdvance(req, id, run);\n  }");
  });

  it("does not turn an explicit user stop into a finalized file-review result", () => {
    const source = readRouteSource();

    expect(source).toContain('status === "aborted"');
    expect(source).toContain('? { run: result.run }');
    expect(source).toContain("maybeCompleteNamedFileReviewTeamRun(");
    expect(source).toContain("agentTeamResponse(transitionRun");
    expect(source).toContain("const stopIfAborted = (): boolean");
    expect(source).toContain("if (stopIfAborted()) break;");
  });
});

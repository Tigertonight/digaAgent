import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInitialAgentTeamRun } from "./initial-run";
import { hydrateAgentTeamRun } from "./hydrate";

describe("hydrateAgentTeamRun", () => {
  it("marks teammates without session files as missing", async () => {
    const run = createInitialAgentTeamRun("hydrate missing");
    const result = await hydrateAgentTeamRun(run, {
      recreateIdleTeammates: true,
      now: 100,
    });

    expect(result.missing).toEqual(
      run.members.filter((member) => member.id !== run.leadAgentId).map((member) => member.id)
    );
    expect(result.run.status).toBe("paused");
    expect(result.run.members.find((member) => member.id !== run.leadAgentId)?.hydrateState).toBe("missing");
  });

  it("rehydrates teammates from existing session files", async () => {
    const run = createInitialAgentTeamRun("hydrate rehydrate");
    const memberId = run.members.find((member) => member.id !== run.leadAgentId)!.id;
    const prepared = {
      ...run,
      status: "paused" as const,
      members: run.members.map((member) =>
        member.id === memberId
          ? { ...member, agentId: undefined, sessionFile: "/tmp/member.jsonl" }
          : member.id === run.leadAgentId
            ? member
            : { ...member, sessionFile: "/tmp/other.jsonl" }
      ),
    };

    const result = await hydrateAgentTeamRun(prepared, {
      recreateIdleTeammates: true,
      sessionExists: () => true,
      recreateMember: async (member) => ({
        agentId: `rehydrated:${member.id}`,
        sessionFile: member.sessionFile,
        modelId: "m",
      }),
      now: 200,
    });

    expect(result.missing).toEqual([]);
    expect(result.rehydrated).toContain(memberId);
    expect(result.run.status).toBe("running");
    expect(result.run.members.find((member) => member.id === memberId)?.agentId).toBe(`rehydrated:${memberId}`);
    expect(result.run.members.find((member) => member.id === memberId)?.hydrateState).toBe("rehydrated");
    expect(result.run.hydrate?.rehydratedMemberIds).toContain(memberId);
  });

  it("marks recreate failures as replaced", async () => {
    const run = createInitialAgentTeamRun("hydrate replaced");
    const memberId = run.members.find((member) => member.id !== run.leadAgentId)!.id;
    const prepared = {
      ...run,
      members: run.members.map((member) =>
        member.id === memberId ? { ...member, sessionFile: "/tmp/member.jsonl" } : member
      ),
    };

    const result = await hydrateAgentTeamRun(prepared, {
      recreateIdleTeammates: true,
      sessionExists: () => true,
      recreateMember: async () => {
        throw new Error("boom");
      },
      now: 300,
    });

    expect(result.replaced).toContain(memberId);
    expect(result.run.status).toBe("paused");
    expect(result.run.members.find((member) => member.id === memberId)?.hydrateState).toBe("replaced");
  });

  it("keeps team dispatch from falling back to the lead agent when a teammate is missing", () => {
    const source = readFileSync(
      path.join(process.cwd(), "app/api/agent/[id]/teams/route.ts"),
      "utf8"
    );

    expect(source).toContain('type === "resume"');
    expect(source).toContain("hydrateStoredAgentTeamRun");
    expect(source).not.toContain("getAgent(member.agentId) ?? rec");
  });
});

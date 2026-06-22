import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInitialAgentTeamRun } from "./mock";
import {
  getAgentTeamRun,
  putAgentTeamRun,
  setAgentTeamStoreRootForTests,
} from "./server-store";
import { completeAgentTeamInitialFrame } from "./runtime";
import { __clearAgentTeamCoordinationRateLimitsForTest } from "./coordination-bridge";
import { createAgentTeamCoordinationTools } from "./coordination-tools";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "agent-team-coord-"));
  setAgentTeamStoreRootForTests(tmpDir);
  __clearAgentTeamCoordinationRateLimitsForTest();
});

afterEach(async () => {
  setAgentTeamStoreRootForTests(null);
  __clearAgentTeamCoordinationRateLimitsForTest();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

function makeRunningRun() {
  const base = createInitialAgentTeamRun("audit team", {
    memberScale: "small",
    coordinationProfile: "basic",
  });
  const memberId = base.members.find((member) => member.id !== base.leadAgentId)?.id;
  if (!memberId) throw new Error("missing teammate");
  const framed = completeAgentTeamInitialFrame({
    ...base,
    status: "running",
    members: base.members.map((member) =>
      member.id === memberId
        ? { ...member, agentId: "child-agent-1", sessionFile: "/tmp/child.jsonl" }
        : member
    ),
  });
  const run = putAgentTeamRun(framed);
  return { run, memberId };
}

function toolByName(name: string) {
  const tools = createAgentTeamCoordinationTools({
    getAgentId: () => "child-agent-1",
  }) as unknown as Array<{
    name: string;
    parameters?: { type?: string; anyOf?: unknown; oneOf?: unknown };
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown
    ) => Promise<unknown>;
  }>;
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

function textOf(result: unknown): string {
  return (
    (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ""
  );
}

function detailsOf(result: unknown) {
  return (result as { details?: { ok?: boolean; error?: string } }).details;
}

describe("Agent Team coordination tools", () => {
  it("exposes provider-compatible object schemas", () => {
    const tools = createAgentTeamCoordinationTools({
      getAgentId: () => "child-agent-1",
    }) as unknown as Array<{ name: string; parameters?: { type?: string; anyOf?: unknown; oneOf?: unknown } }>;

    expect(tools.map((tool) => tool.name)).toEqual([
      "team_get_board",
      "team_claim_task",
      "team_submit_result",
      "team_send_message",
      "team_create_challenge",
      "team_request_plan_approval",
      "team_resolve_challenge",
      "team_record_decision",
    ]);
    for (const tool of tools) {
      expect(tool.parameters?.type, tool.name).toBe("object");
      expect(tool.parameters?.anyOf, tool.name).toBeUndefined();
      expect(tool.parameters?.oneOf, tool.name).toBeUndefined();
    }
  });

  it("lets a teammate read the board, claim a task, and submit a structured result", async () => {
    const { run, memberId } = makeRunningRun();
    const board = await toolByName("team_get_board").execute("call-board", {});
    expect(textOf(board)).toContain("runnableTasks");
    expect(textOf(board)).toContain("收集证据");

    const claim = await toolByName("team_claim_task").execute("call-claim", {
      taskId: "evidence",
    });
    expect(detailsOf(claim)?.ok).toBe(true);
    expect(getAgentTeamRun(run.id)?.board.tasks.find((task) => task.id === "evidence")?.ownerAgentId).toBe(memberId);
    expect(getAgentTeamRun(run.id)?.board.tasks.find((task) => task.id === "evidence")?.selfClaimedAt).toBeTypeOf("number");

    const submit = await toolByName("team_submit_result").execute("call-submit", {
      taskId: "evidence",
      rawText: [
        "TEAM_RESULT_JSON:",
        "```json",
        JSON.stringify({
          summary: "Evidence collected.",
          findings: [
            {
              claim: "The feature is wired through Agent Team board state.",
              confidence: "high",
              evidenceRefs: ["file:lib/agent-team/types.ts"],
            },
          ],
          challenges: [],
          needsFollowUp: [],
        }),
        "```",
      ].join("\n"),
    });

    expect(detailsOf(submit)?.ok).toBe(true);
    const updated = getAgentTeamRun(run.id);
    expect(updated?.board.tasks.find((task) => task.id === "evidence")?.status).toBe("completed");
    expect(updated?.board.findings.some((finding) => finding.authorAgentId === memberId)).toBe(true);
    expect(updated?.coordinationAudit?.map((call) => call.toolName)).toEqual([
      "team_get_board",
      "team_claim_task",
      "team_submit_result",
    ]);
  });

  it("rejects tool calls from agents that are not teammates", async () => {
    makeRunningRun();
    const [tool] = createAgentTeamCoordinationTools({
      getAgentId: () => "stranger-agent",
    }) as unknown as Array<{
      execute: (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown
      ) => Promise<unknown>;
    }>;

    const result = await tool.execute("call", {});

    expect(detailsOf(result)?.ok).toBe(false);
    expect(textOf(result)).toContain("not an active teammate");
  });

  it("rejects result submission from a non-owner teammate", async () => {
    makeRunningRun();
    const submit = await toolByName("team_submit_result").execute("call-submit", {
      taskId: "evidence",
      rawText: "{}",
    });

    expect(detailsOf(submit)?.ok).toBe(false);
    expect(textOf(submit)).toContain("only the task owner");
  });

  it("rate limits repeated coordination calls per teammate and tool", async () => {
    makeRunningRun();
    const tool = toolByName("team_get_board");
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await tool.execute(`call-${i}`, {}));
    }

    expect(detailsOf(results[0])?.ok).toBe(true);
    expect(detailsOf(results[5])?.ok).toBe(false);
    expect(textOf(results[5])).toContain("rate-limited");
  });

  it("rejects governance tools unless full coordination is enabled", async () => {
    makeRunningRun();
    const result = await toolByName("team_record_decision").execute("call-decision", {
      title: "Final",
      rationale: "Not allowed in basic profile.",
      acceptedFindingIds: [],
    });

    expect(detailsOf(result)?.ok).toBe(false);
    expect(textOf(result)).toContain("coordinationProfile=full");
  });

  it("is wired into child agent creation path", async () => {
    const source = await readFile(
      path.join(process.cwd(), "lib/agent-registry.ts"),
      "utf8"
    );

    expect(source).toContain("createAgentTeamCoordinationExtension");
    expect(source).toContain("...(opts.parentAgentId");
    expect(source).toContain("getAgentId: () => id");
  });
});

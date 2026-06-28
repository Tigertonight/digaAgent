/**
 * Coordination Integration Test
 *
 * 上一份 docs/plans/2026-06-22-agent-team-final-mile.md 的 Item 1。
 *
 * 现有 `coordination-tools.test.ts` 已经覆盖了「直接构造工具集合」的闭环；本文件
 * 关心 child agent 注册路径：
 *
 *   createAgentTeamCoordinationExtension(opts)(pi) -> pi.registerTool(...)
 *                                                 -> pi.on("before_agent_start", ...)
 *
 * 那一段是 lib/agent-registry.ts:2024 在创建 child agent 时实际走的路径。
 * 之前没有任何测试断言：调用 extension 之后真的会把 8 个 team_* 工具挂上去、
 * before_agent_start hook 真的会注入 prompt contract、以及从这条路径拿到的工具
 * 仍然能完整跑通 claim → submit_result 闭环。
 *
 * 本文件用一个最小 mock 的 ExtensionAPI 复现注入路径，不依赖真实 model，
 * 也不需要走 Next.js 路由层。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInitialAgentTeamRun } from "./initial-run";
import {
  getAgentTeamRun,
  putAgentTeamRun,
  setAgentTeamStoreRootForTests,
} from "./server-store";
import { completeAgentTeamInitialFrame } from "./runtime";
import { __clearAgentTeamCoordinationRateLimitsForTest } from "./coordination-bridge";
import { createAgentTeamCoordinationExtension } from "./coordination-tools";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown
  ) => Promise<unknown>;
};

type BeforeAgentStartHandler = (event: {
  systemPrompt: string;
}) => Promise<{ systemPrompt?: string } | void> | { systemPrompt?: string } | void;

interface MockPi {
  registerTool: (tool: RegisteredTool) => void;
  on: (event: string, handler: unknown) => void;
  registeredTools: RegisteredTool[];
  beforeAgentStart: BeforeAgentStartHandler[];
}

function makeMockPi(): MockPi {
  const registeredTools: RegisteredTool[] = [];
  const beforeAgentStart: BeforeAgentStartHandler[] = [];
  return {
    registeredTools,
    beforeAgentStart,
    registerTool(tool) {
      registeredTools.push(tool);
    },
    on(eventName, handler) {
      if (eventName === "before_agent_start") {
        beforeAgentStart.push(handler as BeforeAgentStartHandler);
      }
    },
  };
}

async function installExtension(opts: { agentId: string }) {
  const pi = makeMockPi();
  const factory = createAgentTeamCoordinationExtension({
    getAgentId: () => opts.agentId,
  });
  await factory(pi as unknown as Parameters<typeof factory>[0]);
  return pi;
}

function makeRunWithTeammate(agentId: string) {
  const base = createInitialAgentTeamRun("integration team", {
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
        ? { ...member, agentId, sessionFile: "/tmp/integration-child.jsonl" }
        : member
    ),
  });
  const run = putAgentTeamRun(framed);
  return { run, memberId };
}

function textOf(result: unknown): string {
  return (
    (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ""
  );
}

function detailsOf(result: unknown) {
  return (result as { details?: { ok?: boolean; error?: string } }).details;
}

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "agent-team-coord-integ-"));
  setAgentTeamStoreRootForTests(tmpDir);
  __clearAgentTeamCoordinationRateLimitsForTest();
});

afterEach(async () => {
  setAgentTeamStoreRootForTests(null);
  __clearAgentTeamCoordinationRateLimitsForTest();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("Agent Team coordination extension wiring", () => {
  it("registers all eight team_* tools when invoked through the extension factory", async () => {
    const pi = await installExtension({ agentId: "child-agent-integ" });

    const names = pi.registeredTools.map((tool) => tool.name);
    expect(names).toEqual([
      "team_get_board",
      "team_claim_task",
      "team_submit_result",
      "team_send_message",
      "team_create_challenge",
      "team_request_plan_approval",
      "team_resolve_challenge",
      "team_record_decision",
    ]);
  });

  it("appends an Agent Team coordination contract to the system prompt", async () => {
    const pi = await installExtension({ agentId: "child-agent-integ" });
    expect(pi.beforeAgentStart).toHaveLength(1);

    const handler = pi.beforeAgentStart[0]!;
    const result = await handler({ systemPrompt: "BASE_PROMPT" });
    const updated =
      (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";

    expect(updated.startsWith("BASE_PROMPT")).toBe(true);
    expect(updated).toContain("Agent Team Coordination");
    expect(updated).toContain("team_get_board");
    expect(updated).toContain("team_claim_task");
    expect(updated).toContain("team_submit_result");
    // teammate must not silently fake completion when a tool is rejected.
    expect(updated.toLowerCase()).toContain("rejected");
  });

  it(
    "lets a teammate complete claim → submit_result via tools obtained from the extension path",
    async () => {
      const agentId = "child-agent-integ-flow";
      const { run, memberId } = makeRunWithTeammate(agentId);
      const pi = await installExtension({ agentId });

      const board = pi.registeredTools.find((tool) => tool.name === "team_get_board")!;
      const claim = pi.registeredTools.find((tool) => tool.name === "team_claim_task")!;
      const submit = pi.registeredTools.find((tool) => tool.name === "team_submit_result")!;

      const boardResult = await board.execute("call-board", {});
      expect(detailsOf(boardResult)?.ok).toBe(true);
      expect(textOf(boardResult)).toContain("runnableTasks");

      const claimResult = await claim.execute("call-claim", { taskId: "evidence" });
      expect(detailsOf(claimResult)?.ok).toBe(true);
      const claimedTask = getAgentTeamRun(run.id)?.board.tasks.find(
        (task) => task.id === "evidence"
      );
      expect(claimedTask?.ownerAgentId).toBe(memberId);
      expect(typeof claimedTask?.selfClaimedAt).toBe("number");

      const submitResult = await submit.execute("call-submit", {
        taskId: "evidence",
        rawText: [
          "TEAM_RESULT_JSON:",
          "```json",
          JSON.stringify({
            summary: "Wired through the extension path.",
            findings: [
              {
                claim: "Coordination tools are reachable from the child agent registry.",
                confidence: "high",
                evidenceRefs: ["file:lib/agent-registry.ts"],
              },
            ],
            challenges: [],
            needsFollowUp: [],
          }),
          "```",
        ].join("\n"),
      });
      expect(detailsOf(submitResult)?.ok).toBe(true);

      const final = getAgentTeamRun(run.id);
      expect(final?.board.tasks.find((task) => task.id === "evidence")?.status).toBe(
        "completed"
      );
      expect(
        final?.board.findings.some((finding) => finding.authorAgentId === memberId)
      ).toBe(true);
      expect(final?.coordinationAudit?.map((call) => call.toolName)).toEqual([
        "team_get_board",
        "team_claim_task",
        "team_submit_result",
      ]);
      expect(
        final?.coordinationAudit?.every((call) => call.outcome === "ok")
      ).toBe(true);
    }
  );

  it("rejects tool calls when the agentId is not a teammate of any active run", async () => {
    makeRunWithTeammate("child-agent-integ-flow");
    const pi = await installExtension({ agentId: "stranger-agent" });
    const board = pi.registeredTools.find((tool) => tool.name === "team_get_board")!;

    const result = await board.execute("call", {});

    expect(detailsOf(result)?.ok).toBe(false);
    expect(textOf(result)).toContain("not an active teammate");
  });
});

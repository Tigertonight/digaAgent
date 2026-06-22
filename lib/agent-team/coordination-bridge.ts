import "server-only";
import { randomUUID } from "node:crypto";
import type {
  AgentTeamCoordinationCall,
  AgentTeamRun,
  AgentTeamTask,
} from "./types";
import {
  claimStoredAgentTeamTask,
  createStoredAgentTeamChallenge,
  getAgentTeamRun,
  patchStoredAgentTeamRun,
  recordStoredAgentTeamDecision,
  recordStoredAgentTeamCoordinationCall,
  resolveStoredAgentTeamMemberByAgentId,
  resolveStoredAgentTeamChallenge,
  sendStoredAgentTeamMessage,
  submitStoredAgentTeamPlan,
  submitStoredAgentTeamResult,
} from "./server-store";

type CoordinationOutcome =
  | { ok: true; teamId: string; memberId: string; run: AgentTeamRun; value: unknown }
  | { ok: false; teamId?: string; memberId?: string; run?: AgentTeamRun; error: string };

const RATE_WINDOW_MS = 1000;
const RATE_LIMIT = 5;
const rateBuckets = new Map<string, number[]>();

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function auditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      out[key] = value.length > 300 ? `${value.slice(0, 300)}...` : value;
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 20);
    } else if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    } else if (value !== undefined) {
      out[key] = "[object]";
    }
  }
  return out;
}

function checkRateLimit(memberId: string, toolName: string, now = Date.now()): string | null {
  const key = `${memberId}:${toolName}`;
  const recent = (rateBuckets.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    rateBuckets.set(key, recent);
    return "coordination rate-limited";
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  return null;
}

function runnableTasks(run: AgentTeamRun): AgentTeamTask[] {
  const completed = new Set(
    run.board.tasks
      .filter((task) => task.status === "completed")
      .map((task) => task.id)
  );
  return run.board.tasks.filter((task) => {
    if (task.status !== "pending" && task.status !== "blocked") return false;
    return (task.dependsOnTaskIds ?? []).every((id) => completed.has(id));
  });
}

function compactRunForMember(run: AgentTeamRun, memberId: string) {
  const self = run.members.find((member) => member.id === memberId);
  return {
    teamId: run.id,
    status: run.status,
    objective: run.objective,
    self,
    runnableTasks: runnableTasks(run).map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      required: task.required,
      expectedOutput: task.expectedOutput,
      acceptanceCriteria: task.acceptanceCriteria ?? [],
      evidenceRequired: task.evidenceRequired ?? false,
      writePaths: task.writePaths ?? [],
      blocker: task.blocker,
    })),
    currentTask: self?.currentTaskId
      ? run.board.tasks.find((task) => task.id === self.currentTaskId)
      : undefined,
    openChallenges: run.board.challenges
      .filter((challenge) => challenge.status === "open" || challenge.status === "needs_evidence")
      .map((challenge) => ({
        id: challenge.id,
        targetFindingId: challenge.targetFindingId,
        reason: challenge.reason,
        severity: challenge.severity,
        requiredEvidenceRefs: challenge.requiredEvidenceRefs ?? [],
      })),
    proposedFindings: run.board.findings
      .filter((finding) => finding.status === "proposed" || finding.status === "challenged")
      .slice(-10)
      .map((finding) => ({
        id: finding.id,
        taskId: finding.taskId,
        claim: finding.claim,
        evidenceRefs: finding.evidenceRefs,
        confidence: finding.confidence,
        status: finding.status,
      })),
    recentMessages: (run.board.messages ?? [])
      .filter((message) => !message.toAgentId || message.toAgentId === memberId || message.fromAgentId === memberId)
      .slice(-10),
  };
}

async function withResolvedMember(
  memberAgentId: string,
  toolName: string,
  args: Record<string, unknown>,
  action: (ctx: { run: AgentTeamRun; teamId: string; memberId: string }) => CoordinationOutcome
): Promise<CoordinationOutcome> {
  const resolved = resolveStoredAgentTeamMemberByAgentId(memberAgentId);
  if (!resolved.run || !resolved.teamId || !resolved.memberId) {
    return { ok: false, error: resolved.error ?? "teammate not found" };
  }
  const profile = resolved.run.settings.coordinationProfile ?? "basic";
  if (profile === "none") {
    return {
      ok: false,
      teamId: resolved.teamId,
      memberId: resolved.memberId,
      run: resolved.run,
      error: "Agent Team coordination tools are disabled for this run",
    };
  }
  const rateError = checkRateLimit(resolved.memberId, toolName);
  if (rateError) {
    const rejected = await recordAudit({
      run: resolved.run,
      teamId: resolved.teamId,
      memberId: resolved.memberId,
      toolName,
      args,
      outcome: "rejected",
      rejectionReason: rateError,
    });
    return {
      ok: false,
      teamId: resolved.teamId,
      memberId: resolved.memberId,
      run: rejected ?? resolved.run,
      error: rateError,
    };
  }

  const result = action({
    run: resolved.run,
    teamId: resolved.teamId,
    memberId: resolved.memberId,
  });
  const audited = await recordAudit({
    run: result.run ?? resolved.run,
    teamId: resolved.teamId,
    memberId: resolved.memberId,
    toolName,
    args,
    outcome: result.ok ? "ok" : "rejected",
    rejectionReason: result.ok ? undefined : result.error,
  });
  if (result.ok) {
    return { ...result, run: audited ?? result.run };
  }
  return { ...result, run: audited ?? result.run };
}

async function recordAudit(input: {
  run: AgentTeamRun;
  teamId: string;
  memberId: string;
  toolName: string;
  args: Record<string, unknown>;
  outcome: AgentTeamCoordinationCall["outcome"];
  rejectionReason?: string;
}): Promise<AgentTeamRun | undefined> {
  const call: AgentTeamCoordinationCall = {
    id: `${input.teamId}:coord:${Date.now()}:${randomUUID()}`,
    at: Date.now(),
    memberId: input.memberId,
    toolName: input.toolName,
    args: auditArgs(input.args),
    outcome: input.outcome,
    ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
  };
  return recordStoredAgentTeamCoordinationCall(input.teamId, call).run;
}

export function getAgentTeamBoardForAgent(memberAgentId: string) {
  const resolved = resolveStoredAgentTeamMemberByAgentId(memberAgentId);
  if (!resolved.run || !resolved.teamId || !resolved.memberId) {
    return { ok: false as const, error: resolved.error ?? "teammate not found" };
  }
  return {
    ok: true as const,
    teamId: resolved.teamId,
    memberId: resolved.memberId,
    board: compactRunForMember(resolved.run, resolved.memberId),
  };
}

export async function callAgentTeamCoordinationTool(
  memberAgentId: string,
  toolName: string,
  args: unknown
): Promise<CoordinationOutcome> {
  const input = jsonObject(args);
  return withResolvedMember(memberAgentId, toolName, input, ({ teamId, memberId, run }) => {
    if (toolName === "team_get_board") {
      return {
        ok: true,
        teamId,
        memberId,
        run,
        value: compactRunForMember(run, memberId),
      };
    }

    if (run.status !== "running") {
      return { ok: false, teamId, memberId, run, error: "team run is not running" };
    }

    if (toolName === "team_claim_task") {
      const taskId = typeof input.taskId === "string" ? input.taskId : "";
      const writePaths = Array.isArray(input.writePaths)
        ? input.writePaths.filter((item): item is string => typeof item === "string")
        : undefined;
      const claimed = claimStoredAgentTeamTask(teamId, taskId, memberId, { writePaths });
      if (!claimed.run || claimed.error) {
        return {
          ok: false,
          teamId,
          memberId,
          run: claimed.run ?? run,
          error: claimed.error ?? "claim failed",
        };
      }
      const patched = {
        ...claimed.run,
        board: {
          ...claimed.run.board,
          tasks: claimed.run.board.tasks.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  selfClaimedAt: Date.now(),
                }
              : task
          ),
        },
      };
      const stored = patchStoredAgentTeamRun(teamId, { board: patched.board }) ?? patched;
      return {
        ok: true,
        teamId,
        memberId,
        run: stored,
        value: { taskId, run: stored },
      };
    }

    if (toolName === "team_submit_result") {
      const taskId = typeof input.taskId === "string" ? input.taskId : "";
      const rawText = typeof input.rawText === "string" ? input.rawText : "";
      const task = run.board.tasks.find((item) => item.id === taskId);
      if (task?.ownerAgentId !== memberId) {
        return {
          ok: false,
          teamId,
          memberId,
          run,
          error: "only the task owner can submit its result",
        };
      }
      const submitted = submitStoredAgentTeamResult(teamId, {
        taskId,
        memberId,
        rawText,
        sessionFile: run.members.find((member) => member.id === memberId)?.sessionFile,
        dispatchMode: "single",
      });
      if (!submitted.run || submitted.error) {
        return {
          ok: false,
          teamId,
          memberId,
          run: submitted.run ?? run,
          error: submitted.error ?? "submit_result failed",
        };
      }
      return { ok: true, teamId, memberId, run: submitted.run, value: submitted.run };
    }

    if (toolName === "team_send_message") {
      const body = typeof input.body === "string" ? input.body : "";
      const sent = sendStoredAgentTeamMessage(teamId, {
        fromAgentId: memberId,
        toAgentId: typeof input.toAgentId === "string" ? input.toAgentId : undefined,
        body,
        taskId: typeof input.taskId === "string" ? input.taskId : undefined,
        findingId: typeof input.findingId === "string" ? input.findingId : undefined,
        challengeId: typeof input.challengeId === "string" ? input.challengeId : undefined,
      });
      if (!sent.run || sent.error) {
        return { ok: false, teamId, memberId, run: sent.run ?? run, error: sent.error ?? "send failed" };
      }
      return { ok: true, teamId, memberId, run: sent.run, value: sent.run.board.messages.at(-1) };
    }

    if (toolName === "team_create_challenge") {
      const created = createStoredAgentTeamChallenge(teamId, {
        targetFindingId: typeof input.targetFindingId === "string" ? input.targetFindingId : "",
        authorAgentId: memberId,
        reason: typeof input.reason === "string" ? input.reason : "",
        severity:
          input.severity === "low" || input.severity === "medium" || input.severity === "high"
            ? input.severity
            : undefined,
        requiredEvidenceRefs: Array.isArray(input.requiredEvidenceRefs)
          ? input.requiredEvidenceRefs.filter((item): item is string => typeof item === "string")
          : undefined,
      });
      if (!created.run || created.error) {
        return { ok: false, teamId, memberId, run: created.run ?? run, error: created.error ?? "challenge failed" };
      }
      return { ok: true, teamId, memberId, run: created.run, value: created.run.board.challenges.at(-1) };
    }

    if (toolName === "team_request_plan_approval") {
      const submitted = submitStoredAgentTeamPlan(teamId, {
        taskId: typeof input.taskId === "string" ? input.taskId : "",
        authorAgentId: memberId,
        body: typeof input.body === "string" ? input.body : "",
        criteria: Array.isArray(input.criteria)
          ? input.criteria.filter((item): item is string => typeof item === "string")
          : undefined,
      });
      if (!submitted.run || submitted.error) {
        return { ok: false, teamId, memberId, run: submitted.run ?? run, error: submitted.error ?? "plan failed" };
      }
      return { ok: true, teamId, memberId, run: submitted.run, value: submitted.run.board.plans.at(-1) };
    }

    if (toolName === "team_resolve_challenge") {
      if ((run.settings.coordinationProfile ?? "basic") !== "full") {
        return {
          ok: false,
          teamId,
          memberId,
          run,
          error: "team_resolve_challenge requires coordinationProfile=full",
        };
      }
      const resolved = resolveStoredAgentTeamChallenge(
        teamId,
        typeof input.challengeId === "string" ? input.challengeId : "",
        memberId,
        typeof input.resolution === "string" ? input.resolution : "",
        Array.isArray(input.resolutionFindingIds)
          ? input.resolutionFindingIds.filter((item): item is string => typeof item === "string")
          : undefined
      );
      if (!resolved.run || resolved.error) {
        return { ok: false, teamId, memberId, run: resolved.run ?? run, error: resolved.error ?? "resolve challenge failed" };
      }
      return { ok: true, teamId, memberId, run: resolved.run, value: resolved.run.board.challenges.at(-1) };
    }

    if (toolName === "team_record_decision") {
      if ((run.settings.coordinationProfile ?? "basic") !== "full") {
        return {
          ok: false,
          teamId,
          memberId,
          run,
          error: "team_record_decision requires coordinationProfile=full",
        };
      }
      if (memberId !== run.leadAgentId) {
        return {
          ok: false,
          teamId,
          memberId,
          run,
          error: "only the Lead member can record a Team decision",
        };
      }
      const recorded = recordStoredAgentTeamDecision(teamId, {
        title: typeof input.title === "string" ? input.title : "",
        rationale: typeof input.rationale === "string" ? input.rationale : "",
        madeByAgentId: memberId,
        acceptedFindingIds: Array.isArray(input.acceptedFindingIds)
          ? input.acceptedFindingIds.filter((item): item is string => typeof item === "string")
          : [],
        rejectedFindingIds: Array.isArray(input.rejectedFindingIds)
          ? input.rejectedFindingIds.filter((item): item is string => typeof item === "string")
          : undefined,
        challengeIds: Array.isArray(input.challengeIds)
          ? input.challengeIds.filter((item): item is string => typeof item === "string")
          : undefined,
        evidenceRefs: Array.isArray(input.evidenceRefs)
          ? input.evidenceRefs.filter((item): item is string => typeof item === "string")
          : undefined,
        sourceResultIds: Array.isArray(input.sourceResultIds)
          ? input.sourceResultIds.filter((item): item is string => typeof item === "string")
          : undefined,
        confidence:
          input.confidence === "low" || input.confidence === "medium" || input.confidence === "high"
            ? input.confidence
            : undefined,
      });
      if (!recorded.run || recorded.error) {
        return { ok: false, teamId, memberId, run: recorded.run ?? run, error: recorded.error ?? "record decision failed" };
      }
      return { ok: true, teamId, memberId, run: recorded.run, value: recorded.run.board.decisions.at(-1) };
    }

    return { ok: false, teamId, memberId, run: getAgentTeamRun(teamId) ?? run, error: `unknown coordination tool: ${toolName}` };
  });
}

export function __clearAgentTeamCoordinationRateLimitsForTest(): void {
  rateBuckets.clear();
}

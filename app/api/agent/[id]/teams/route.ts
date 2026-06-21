import { NextResponse } from "next/server";
import {
  createAgent,
  disposeAgent,
  getAgent,
  isLocalCodingAssistantAgent,
  promptLocalCodingAssistantAgent,
  pushAgentTeamEvent,
} from "@/lib/agent-registry";
import { createInitialAgentTeamRun } from "@/lib/agent-team/mock";
import { createAgentTeamResultPrompt } from "@/lib/agent-team/result-ingestion";
import {
  acceptStoredAgentTeamFinding,
  approveStoredAgentTeamPlan,
  claimStoredAgentTeamTask,
  completeStoredAgentTeamTask,
  createStoredAgentTeamChallenge,
  dismissStoredAgentTeamChallenge,
  failStoredAgentTeamTask,
  followUpStoredAgentTeamMember,
  getAgentTeamRun,
  listAgentTeamRuns,
  markStoredAgentTeamIdle,
  planStoredAgentTeamDispatches,
  planStoredAgentTeamDispatch,
  putAgentTeamRun,
  promoteStoredAgentTeamMember,
  recordStoredAgentTeamDecision,
  rejectStoredAgentTeamFinding,
  rejectStoredAgentTeamPlan,
  replaceStoredAgentTeamMember,
  resolveStoredAgentTeamChallenge,
  retryStoredAgentTeamTask,
  sendStoredAgentTeamMessage,
  submitStoredAgentTeamPlan,
  submitStoredAgentTeamResult,
  transitionStoredAgentTeamRun,
  updateStoredAgentTeamHook,
} from "@/lib/agent-team/server-store";
import type { AgentTeamDispatchPlan } from "@/lib/agent-team/runtime";
import type { AgentTeamRun, AgentTeamRunStatus, AgentTeamSettings } from "@/lib/agent-team/types";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import { invalidateSessionListCache } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AgentRecord = NonNullable<ReturnType<typeof getAgent>>;

interface AgentTeamDispatchResult {
  run: AgentTeamRun;
  dispatched: Array<{ taskId: string; memberId: string; agentId?: string }>;
  errors: string[];
}

interface AgentTeamDispatchRequest {
  rec: AgentRecord;
  teamId: string;
  plans: AgentTeamDispatchPlan[];
  initialRun: AgentTeamRun;
  dispatchMode: "single" | "batch" | "until_idle";
}

export const GET = withRemoteAuth(async function (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rec = getAgent(id);
  if (!rec) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  const url = new URL(req.url);
  const teamId = url.searchParams.get("id") ?? url.searchParams.get("teamId");
  if (teamId) {
    const run = getAgentTeamRun(teamId);
    if (!run || run.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    return NextResponse.json({ run });
  }
  return NextResponse.json({ runs: listAgentTeamRuns(id) });
});

export const POST = withRemoteAuth(async function (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rec = getAgent(id);
  if (!rec) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const type = typeof body.type === "string" ? body.type : "";
  if (type === "start") {
    const objective = typeof body.objective === "string" ? body.objective.trim() : "";
    if (!objective) {
      return NextResponse.json({ error: "objective is required" }, { status: 400 });
    }
    const provisional = createInitialAgentTeamRun(objective);
    const settings = mergeSettings(provisional.settings, body.settings);
    const run = createInitialAgentTeamRun(objective, settings);
    const initial = {
      ...run,
      parentAgentId: id,
      parentSessionPath: rec.session.sessionFile,
      settings,
      members: run.members.map((member) =>
        member.id === run.leadAgentId
          ? {
              ...member,
              agentId: id,
              sessionFile: rec.session.sessionFile,
              modelId: rec.session.model?.id,
              spawnedAt: Date.now(),
              lastActiveAt: Date.now(),
            }
          : member
      ),
    };
    const withTeammates = await spawnInitialTeammates(initial, rec);
    const stored = putAgentTeamRun(withTeammates);
    pushAgentTeamEvent(rec, { type: "agent_team_run_start", run: stored });
    return NextResponse.json({ ok: true, run: stored });
  }

  if (type === "transition") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const status = parseTransitionStatus(body.status);
    if (!teamId || !status) {
      return NextResponse.json(
        { error: "transition requires teamId and valid status" },
        { status: 400 }
      );
    }
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    if (status === "aborted") {
      await shutdownAgentTeamTeammates(existing, rec);
    }
    const result = transitionStoredAgentTeamRun(teamId, status);
    if (!result.run) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    pushAgentTeamEvent(rec, {
      type: status === "completed" && result.blockedReasons.length === 0
        ? "agent_team_run_finalized"
        : "agent_team_run_update",
      run: result.run,
    });
    return NextResponse.json({
      ok: result.blockedReasons.length === 0,
      run: result.run,
      blockedReasons: result.blockedReasons,
    });
  }

  if (type === "claim_task") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const writePaths = Array.isArray(body.writePaths)
      ? body.writePaths.filter((item: unknown): item is string => typeof item === "string")
      : undefined;
    const result = claimStoredAgentTeamTask(teamId, taskId, memberId, { writePaths });
    if (!result.run) {
      return NextResponse.json({ error: result.error ?? "claim failed" }, { status: 400 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json({ ok: !result.error, run: result.run, error: result.error });
  }

  if (type === "complete_task") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const evidenceRefs = Array.isArray(body.evidenceRefs)
      ? body.evidenceRefs.filter((item: unknown): item is string => typeof item === "string")
      : undefined;
    const confidence =
      body.confidence === "low" ||
      body.confidence === "medium" ||
      body.confidence === "high"
        ? body.confidence
        : undefined;
    const result = completeStoredAgentTeamTask(teamId, taskId, memberId, {
      findingClaim:
        typeof body.findingClaim === "string" ? body.findingClaim : undefined,
      evidenceRefs,
      confidence,
    });
    if (!result.run) {
      return NextResponse.json({ error: result.error ?? "complete failed" }, { status: 400 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json({ ok: !result.error, run: result.run, error: result.error });
  }

  if (type === "submit_result") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const rawText = typeof body.rawText === "string" ? body.rawText.trim() : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    if (!rawText) {
      return NextResponse.json({ error: "result text is required" }, { status: 400 });
    }
    const member = existing.members.find((item) => item.id === memberId);
    const result = submitStoredAgentTeamResult(teamId, {
      taskId,
      memberId,
      rawText,
      sessionFile: member?.sessionFile,
      dispatchMode:
        body.dispatchMode === "batch" || body.dispatchMode === "until_idle"
          ? body.dispatchMode
          : "single",
    });
    if (!result.run) {
      return NextResponse.json({ error: result.error ?? "result submit failed" }, { status: 400 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json({ ok: !result.error, run: result.run, error: result.error });
  }

  if (type === "accept_finding" || type === "reject_finding") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const findingId = typeof body.findingId === "string" ? body.findingId : "";
    const actorAgentId = typeof body.actorAgentId === "string" ? body.actorAgentId : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const result =
      type === "accept_finding"
        ? acceptStoredAgentTeamFinding(teamId, findingId, actorAgentId || existing.leadAgentId)
        : rejectStoredAgentTeamFinding(
            teamId,
            findingId,
            actorAgentId || existing.leadAgentId,
            typeof body.reason === "string" ? body.reason : "Rejected by lead review."
          );
    if (!result.run) {
      return NextResponse.json({ error: result.error ?? "finding update failed" }, { status: 400 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json({ ok: !result.error, run: result.run, error: result.error });
  }

  if (type === "create_challenge" || type === "resolve_challenge" || type === "dismiss_challenge") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const actorAgentId =
      typeof body.actorAgentId === "string" && body.actorAgentId
        ? body.actorAgentId
        : existing.leadAgentId;
    const result =
      type === "create_challenge"
        ? createStoredAgentTeamChallenge(teamId, {
            targetFindingId: typeof body.findingId === "string" ? body.findingId : "",
            authorAgentId: actorAgentId,
            reason:
              typeof body.reason === "string" && body.reason.trim()
                ? body.reason.trim()
                : "Needs stronger evidence before acceptance.",
            severity:
              body.severity === "low" || body.severity === "high" ? body.severity : "medium",
            requiredEvidenceRefs: Array.isArray(body.requiredEvidenceRefs)
              ? body.requiredEvidenceRefs.filter((item: unknown): item is string => typeof item === "string")
              : undefined,
          })
        : type === "resolve_challenge"
          ? resolveStoredAgentTeamChallenge(
              teamId,
              typeof body.challengeId === "string" ? body.challengeId : "",
              actorAgentId,
              typeof body.resolution === "string" && body.resolution.trim()
                ? body.resolution.trim()
                : "Resolved by lead review.",
              Array.isArray(body.resolutionFindingIds)
                ? body.resolutionFindingIds.filter((item: unknown): item is string => typeof item === "string")
                : undefined
            )
          : dismissStoredAgentTeamChallenge(
              teamId,
              typeof body.challengeId === "string" ? body.challengeId : "",
              actorAgentId,
              typeof body.reason === "string" && body.reason.trim()
                ? body.reason.trim()
                : "Dismissed by lead review."
            );
    if (!result.run) {
      return NextResponse.json({ error: result.error ?? "challenge update failed" }, { status: 400 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json({ ok: !result.error, run: result.run, error: result.error });
  }

  if (type === "record_decision") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const result = recordStoredAgentTeamDecision(teamId, {
      title:
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim()
          : "Lead synthesis decision",
      rationale:
        typeof body.rationale === "string" && body.rationale.trim()
          ? body.rationale.trim()
          : "Accepted findings and resolved challenges support this synthesis.",
      madeByAgentId:
        typeof body.madeByAgentId === "string" && body.madeByAgentId
          ? body.madeByAgentId
          : existing.leadAgentId,
      acceptedFindingIds: Array.isArray(body.acceptedFindingIds)
        ? body.acceptedFindingIds.filter((item: unknown): item is string => typeof item === "string")
        : [],
      rejectedFindingIds: Array.isArray(body.rejectedFindingIds)
        ? body.rejectedFindingIds.filter((item: unknown): item is string => typeof item === "string")
        : undefined,
      challengeIds: Array.isArray(body.challengeIds)
        ? body.challengeIds.filter((item: unknown): item is string => typeof item === "string")
        : undefined,
      evidenceRefs: Array.isArray(body.evidenceRefs)
        ? body.evidenceRefs.filter((item: unknown): item is string => typeof item === "string")
        : undefined,
      sourceResultIds: Array.isArray(body.sourceResultIds)
        ? body.sourceResultIds.filter((item: unknown): item is string => typeof item === "string")
        : undefined,
      confidence: body.confidence === "low" || body.confidence === "high" ? body.confidence : "medium",
    });
    if (!result.run) {
      return NextResponse.json({ error: result.error ?? "decision failed" }, { status: 400 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json({ ok: !result.error, run: result.run, error: result.error });
  }

  if (type === "submit_plan" || type === "approve_plan" || type === "reject_plan") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const actorAgentId =
      typeof body.actorAgentId === "string" && body.actorAgentId
        ? body.actorAgentId
        : existing.leadAgentId;
    const result =
      type === "submit_plan"
        ? submitStoredAgentTeamPlan(teamId, {
            taskId: typeof body.taskId === "string" ? body.taskId : "",
            authorAgentId: actorAgentId,
            body: typeof body.body === "string" ? body.body : "",
            criteria: Array.isArray(body.criteria)
              ? body.criteria.filter((item: unknown): item is string => typeof item === "string")
              : undefined,
          })
        : type === "approve_plan"
          ? approveStoredAgentTeamPlan(
              teamId,
              typeof body.planId === "string" ? body.planId : "",
              actorAgentId
            )
          : rejectStoredAgentTeamPlan(
              teamId,
              typeof body.planId === "string" ? body.planId : "",
              actorAgentId,
              typeof body.reason === "string" && body.reason.trim()
                ? body.reason.trim()
                : "Plan needs revision."
            );
    if (!result.run) {
      return NextResponse.json({ error: result.error ?? "plan update failed" }, { status: 400 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json({ ok: !result.error, run: result.run, error: result.error });
  }

  if (type === "send_message") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const fromAgentId = typeof body.fromAgentId === "string" ? body.fromAgentId : "";
    const bodyText = typeof body.body === "string" ? body.body.trim() : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    if (!bodyText) {
      return NextResponse.json({ error: "message body is required" }, { status: 400 });
    }
    const result = sendStoredAgentTeamMessage(teamId, {
      fromAgentId,
      toAgentId: typeof body.toAgentId === "string" ? body.toAgentId : undefined,
      body: bodyText,
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      findingId: typeof body.findingId === "string" ? body.findingId : undefined,
      challengeId: typeof body.challengeId === "string" ? body.challengeId : undefined,
    });
    if (!result.run) {
      return NextResponse.json({ error: result.error ?? "message failed" }, { status: 400 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json({ ok: !result.error, run: result.run, error: result.error });
  }

  if (type === "follow_up_member") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const toAgentId = typeof body.memberId === "string" ? body.memberId : "";
    const fromAgentId = typeof body.fromAgentId === "string" ? body.fromAgentId : "";
    const bodyText = typeof body.body === "string" ? body.body.trim() : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    if (!bodyText) {
      return NextResponse.json({ error: "message body is required" }, { status: 400 });
    }
    const member = existing.members.find((item) => item.id === toAgentId);
    if (!member) return NextResponse.json({ error: "member not found" }, { status: 400 });
    const recorded = followUpStoredAgentTeamMember(teamId, {
      fromAgentId,
      toAgentId,
      body: bodyText,
      taskId: typeof body.taskId === "string" ? body.taskId : undefined,
      findingId: typeof body.findingId === "string" ? body.findingId : undefined,
      challengeId: typeof body.challengeId === "string" ? body.challengeId : undefined,
    });
    if (!recorded.run || recorded.error) {
      return NextResponse.json({ error: recorded.error ?? "follow-up failed" }, { status: 400 });
    }
    let latestRun = recorded.run;
    const targetRec = member.agentId ? getAgent(member.agentId) : undefined;
    if (targetRec) {
      try {
        const prompt = [
          "You are a teammate in an Agent Team run.",
          `Team objective: ${existing.objective}`,
          `Your member id: ${member.id}`,
          "The user/lead sent you a direct follow-up from Team Workspace.",
          "",
          bodyText,
          "",
          "Answer in your teammate session. Keep the reply concise and cite evidence when possible.",
        ].join("\n");
        if (isLocalCodingAssistantAgent(targetRec)) {
          await promptLocalCodingAssistantAgent(targetRec, prompt);
        } else {
          await targetRec.session.prompt(prompt);
        }
      } catch (err) {
        const failure = followUpStoredAgentTeamMember(teamId, {
          fromAgentId: existing.leadAgentId,
          toAgentId,
          body: `Follow-up delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        latestRun = failure.run ?? latestRun;
      }
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: latestRun });
    return NextResponse.json({ ok: true, run: latestRun });
  }

  if (type === "promote_member") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const member = existing.members.find((item) => item.id === memberId);
    if (!member) {
      return NextResponse.json({ error: "member not found" }, { status: 400 });
    }
    if (member.agentId) {
      const teammate = getAgent(member.agentId);
      if (teammate) teammate.hidden = false;
    }
    const result = promoteStoredAgentTeamMember(teamId, memberId);
    if (!result.run || result.error) {
      return NextResponse.json({ error: result.error ?? "promote failed" }, { status: 400 });
    }
    invalidateSessionListCache();
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json({
      ok: true,
      run: result.run,
      sessionFile: result.run.members.find((item) => item.id === memberId)?.sessionFile,
    });
  }

  if (type === "configure_hook") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const hookId = typeof body.hookId === "string" ? body.hookId : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const severity =
      body.severity === "info" ||
      body.severity === "warning" ||
      body.severity === "blocking"
        ? body.severity
        : undefined;
    const result = updateStoredAgentTeamHook(teamId, hookId, {
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      severity,
    });
    if (!result.run || result.error) {
      return NextResponse.json({ error: result.error ?? "hook update failed" }, { status: 400 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json({ ok: true, run: result.run });
  }

  if (type === "retry_task") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const result = retryStoredAgentTeamTask(teamId, taskId);
    if (!result.run || result.error) {
      return NextResponse.json({ error: result.error ?? "retry failed" }, { status: 400 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json({ ok: true, run: result.run });
  }

  if (type === "replace_member") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const member = existing.members.find((item) => item.id === memberId);
    if (!member) return NextResponse.json({ error: "member not found" }, { status: 400 });
    const model = rec.session.model;
    let replacement: { agentId?: string; sessionFile?: string; modelId?: string } = {};
    if (model) {
      const created = await createAgent({
        provider: model.provider,
        modelId: model.id,
        cwd: rec.cwd,
        thinkingLevel: rec.session.thinkingLevel,
        parentAgentId: rec.id,
        parentSessionPath: rec.session.sessionFile,
        childRole: teamRoleToSubagentRole(member.role),
        hidden: !member.sidebarVisible,
      });
      replacement = {
        agentId: created.id,
        sessionFile: created.sessionFile,
        modelId: model.id,
      };
    }
    const result = replaceStoredAgentTeamMember(teamId, memberId, replacement);
    if (!result.run || result.error) {
      return NextResponse.json({ error: result.error ?? "replace failed" }, { status: 400 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json({ ok: true, run: result.run });
  }

  if (type === "run_next" || type === "run_batch" || type === "run_until_idle") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const existing = getAgentTeamRun(teamId);
    if (!existing || existing.parentAgentId !== id) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const maxDispatches =
      (type === "run_batch" || type === "run_until_idle") && typeof body.maxDispatches === "number"
        ? Math.max(1, Math.min(8, Math.floor(body.maxDispatches)))
        : 1;
    const maxRounds =
      type === "run_until_idle" && typeof body.maxRounds === "number"
        ? Math.max(1, Math.min(12, Math.floor(body.maxRounds)))
        : 1;
    const dispatched: AgentTeamDispatchResult["dispatched"] = [];
    const errors: string[] = [];
    let latestRun = existing;
    let rounds = 0;

    for (let round = 0; round < maxRounds; round += 1) {
      let plannedRun: AgentTeamRun | undefined;
      let plannedError: string | undefined;
      let plans: AgentTeamDispatchPlan[] = [];
      if (type === "run_next") {
        const planned = planStoredAgentTeamDispatch(teamId);
        plannedRun = planned.run;
        plannedError = planned.error;
        plans = planned.plan ? [planned.plan] : [];
      } else {
        const planned = planStoredAgentTeamDispatches(teamId, maxDispatches);
        plannedRun = planned.run;
        plannedError = planned.error;
        plans = planned.plans ?? [];
      }
      latestRun = plannedRun ?? latestRun;
      if (!plannedRun || plans.length === 0) {
        if (round === 0) {
          return NextResponse.json(
            { ok: false, run: latestRun, error: plannedError ?? "no dispatch plan" },
            { status: 409 }
          );
        }
        const idle = markStoredAgentTeamIdle(teamId);
        latestRun = idle.run ?? latestRun;
        if (idle.run) pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: idle.run });
        break;
      }
      const result = await dispatchAgentTeamPlans({
        rec,
        teamId,
        plans,
        initialRun: plannedRun,
        dispatchMode:
          type === "run_until_idle" ? "until_idle" : type === "run_batch" ? "batch" : "single",
      });
      latestRun = result.run;
      dispatched.push(...result.dispatched);
      errors.push(...result.errors);
      rounds += 1;
      if (type !== "run_until_idle" || result.errors.length > 0) break;
    }

    return NextResponse.json({
      ok: errors.length === 0,
      run: latestRun,
      dispatched,
      errors,
      rounds,
    });
  }

  return NextResponse.json(
    { error: `unknown action: ${type || "(missing)"}` },
    { status: 400 }
  );
});

async function dispatchAgentTeamPlans({
  rec,
  teamId,
  plans,
  initialRun,
  dispatchMode,
}: AgentTeamDispatchRequest): Promise<AgentTeamDispatchResult> {
  const dispatched: AgentTeamDispatchResult["dispatched"] = [];
  const errors: string[] = [];
  let latestRun = initialRun;
  const claimedJobs: Array<{
    plan: AgentTeamDispatchPlan;
    memberName?: string;
    targetRec: AgentRecord;
  }> = [];

  for (const plan of plans) {
    const member = latestRun.members.find((item) => item.id === plan.memberId);
    const targetRec = member?.agentId ? getAgent(member.agentId) ?? rec : rec;
    const claimed = claimStoredAgentTeamTask(teamId, plan.task.id, plan.memberId);
    if (!claimed.run || claimed.error) {
      errors.push(claimed.error ?? `claim failed for ${plan.task.id}`);
      latestRun = claimed.run ?? latestRun;
      continue;
    }
    latestRun = claimed.run;
    claimedJobs.push({ plan, memberName: member?.name, targetRec });
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: latestRun });
  }

  const results = await Promise.all(
    claimedJobs.map(async (job) => {
      try {
        const prompt = createAgentTeamResultPrompt(job.plan.prompt);
        if (isLocalCodingAssistantAgent(job.targetRec)) {
          await promptLocalCodingAssistantAgent(job.targetRec, prompt);
        } else {
          await job.targetRec.session.prompt(prompt);
        }
        return { job };
      } catch (err) {
        return {
          job,
          error: `Dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    })
  );

  for (const result of results) {
    const { job } = result;
    if (result.error) {
      errors.push(result.error);
      const failed = failStoredAgentTeamTask(
        teamId,
        job.plan.task.id,
        job.plan.memberId,
        result.error
      );
      latestRun = failed.run ?? latestRun;
      if (failed.run) pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: failed.run });
      continue;
    }

    dispatched.push({
      taskId: job.plan.task.id,
      memberId: job.plan.memberId,
      agentId: job.targetRec.id,
    });
    const current = getAgentTeamRun(teamId) ?? latestRun;
    latestRun = putAgentTeamRun({
      ...current,
      updatedAt: Date.now(),
      board: {
        ...current.board,
        tasks: current.board.tasks.map((task) =>
          task.id === job.plan.task.id
            ? {
                ...task,
                status: "running" as const,
                completionSource: "teammate_result" as const,
                blocker: "Waiting for structured teammate result.",
              }
            : task
        ),
      },
      members: current.members.map((member) =>
        member.id === job.plan.memberId
          ? {
              ...member,
              status: "working" as const,
              currentTaskId: job.plan.task.id,
              latestOutput: `Dispatched via ${dispatchMode}; waiting for structured teammate result.`,
              lastActiveAt: Date.now(),
            }
          : member
      ),
    });
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: latestRun });
  }

  return { run: latestRun, dispatched, errors };
}

async function shutdownAgentTeamTeammates(run: AgentTeamRun, parentRec: AgentRecord): Promise<void> {
  await Promise.allSettled(
    run.members
      .filter((member) => member.id !== run.leadAgentId && member.agentId)
      .map(async (member) => {
        const teammate = member.agentId ? getAgent(member.agentId) : undefined;
        if (!teammate || teammate.id === parentRec.id) return;
        await teammate.session.abort().catch(() => undefined);
        if (!member.sidebarVisible) {
          await disposeAgent(teammate.id).catch(() => undefined);
        }
      })
  );
}

async function spawnInitialTeammates(
  run: ReturnType<typeof createInitialAgentTeamRun>,
  rec: NonNullable<ReturnType<typeof getAgent>>
): Promise<ReturnType<typeof createInitialAgentTeamRun>> {
  const model = rec.session.model;
  if (!model) return run;
  const now = Date.now();
  const members = [];
  const events = [...run.board.events];
  for (const member of run.members) {
    if (member.id === run.leadAgentId) {
      members.push(member);
      continue;
    }
    try {
      const created = await createAgent({
        provider: model.provider,
        modelId: model.id,
        cwd: rec.cwd,
        thinkingLevel: rec.session.thinkingLevel,
        parentAgentId: rec.id,
        parentSessionPath: rec.session.sessionFile,
        childRole: teamRoleToSubagentRole(member.role),
        hidden: true,
      });
      members.push({
        ...member,
        agentId: created.id,
        sessionFile: created.sessionFile,
        modelId: model.id,
        status: "idle" as const,
        spawnedAt: now,
        lastActiveAt: now,
        latestOutput: "Teammate session 已创建，等待任务认领。",
      });
      events.push({
        id: `${run.id}:event:spawned:${member.id}`,
        type: "member_spawned",
        at: now,
        actorAgentId: run.leadAgentId,
        targetAgentId: member.id,
        message: `${member.name} teammate session created.`,
        data: { agentId: created.id, sessionFile: created.sessionFile },
      });
    } catch (err) {
      members.push({
        ...member,
        status: "blocked" as const,
        latestOutput: `Teammate session 创建失败：${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }
  const spawnedCount = members.filter((member) => member.agentId).length - 1;
  return {
    ...run,
    members,
    updatedAt: now,
    board: {
      ...run.board,
      events,
      capabilityAudit: run.board.capabilityAudit.map((item) =>
        item.id === "independent-teammates"
          ? {
              ...item,
              digaStatus: spawnedCount > 0 ? "partial" : item.digaStatus,
              evidence:
                spawnedCount > 0
                  ? [
                      ...item.evidence,
                      `spawned ${spawnedCount} hidden teammate sessions`,
                    ]
                  : item.evidence,
              gap:
                spawnedCount > 0
                  ? "已能创建独立 teammate session，但尚未实现任务自动 claim 和上下文投递。"
                  : item.gap,
            }
          : item
      ),
    },
  };
}

function teamRoleToSubagentRole(role: string): "general" | "research" | "code-review" {
  if (role.includes("资料") || role.toLowerCase().includes("research")) {
    return "research";
  }
  if (role.includes("挑战") || role.toLowerCase().includes("critic")) {
    return "code-review";
  }
  return "general";
}

function parseTransitionStatus(value: unknown): AgentTeamRunStatus | null {
  if (
    value === "running" ||
    value === "paused" ||
    value === "completed" ||
    value === "aborted"
  ) {
    return value;
  }
  return null;
}

function mergeSettings(
  base: AgentTeamSettings,
  raw: unknown
): AgentTeamSettings {
  if (!raw || typeof raw !== "object") return base;
  const input = raw as Partial<AgentTeamSettings>;
  return {
    ...base,
    memberScale:
      input.memberScale === "small" ||
      input.memberScale === "standard" ||
      input.memberScale === "deep"
        ? input.memberScale
        : base.memberScale,
    allowNetwork:
      typeof input.allowNetwork === "boolean" ? input.allowNetwork : base.allowNetwork,
    allowWrite:
      typeof input.allowWrite === "boolean" ? input.allowWrite : base.allowWrite,
    allowWorktree:
      typeof input.allowWorktree === "boolean" ? input.allowWorktree : base.allowWorktree,
    allowChallenges:
      typeof input.allowChallenges === "boolean"
        ? input.allowChallenges
        : base.allowChallenges,
    requirePlanApproval:
      typeof input.requirePlanApproval === "boolean"
        ? input.requirePlanApproval
        : base.requirePlanApproval,
    displayMode:
      input.displayMode === "workspace" ||
      input.displayMode === "in_process" ||
      input.displayMode === "split_panes"
        ? input.displayMode
        : base.displayMode,
    stopConditions: {
      ...base.stopConditions,
      ...(input.stopConditions && typeof input.stopConditions === "object"
        ? input.stopConditions
        : {}),
    },
    writePolicy:
      input.writePolicy === "read_only" ||
      input.writePolicy === "plan_approval" ||
      input.writePolicy === "write_allowed"
        ? input.writePolicy
        : typeof input.allowWrite === "boolean"
          ? input.allowWrite
            ? input.requirePlanApproval === false
              ? "write_allowed"
              : "plan_approval"
            : "read_only"
          : base.writePolicy,
    networkPolicy:
      input.networkPolicy === "disabled" ||
      input.networkPolicy === "lead_only" ||
      input.networkPolicy === "teammates_allowed"
        ? input.networkPolicy
        : typeof input.allowNetwork === "boolean"
          ? input.allowNetwork
            ? "teammates_allowed"
            : "disabled"
          : base.networkPolicy,
    worktreePolicy:
      input.worktreePolicy === "none" ||
      input.worktreePolicy === "per_member" ||
      input.worktreePolicy === "per_task"
        ? input.worktreePolicy
        : typeof input.allowWorktree === "boolean"
          ? input.allowWorktree
            ? "per_member"
            : "none"
          : base.worktreePolicy,
    resultIngestionMode:
      input.resultIngestionMode === "structured" ||
      input.resultIngestionMode === "transcript_summary"
        ? input.resultIngestionMode
        : base.resultIngestionMode,
  };
}

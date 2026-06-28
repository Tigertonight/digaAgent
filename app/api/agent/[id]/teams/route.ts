import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  abortLocalCodingAssistantAgent,
  claimClientRequest,
  createAgent,
  disposeAgent,
  getAgent,
  isLocalCodingAssistantAgent,
  promptLocalCodingAssistantAgent,
  pushAgentTeamEvent,
} from "@/lib/agent-registry";
import { createInitialAgentTeamRun } from "@/lib/agent-team/initial-run";
import { RUNTIME_LIMITS } from "@/lib/shared/runtime-limits";
import { FEATURE_FLAGS } from "@/lib/shared/feature-flags";
import { shouldAutoKickAgentTeamRun } from "@/lib/agent-team/auto-kick";
import {
  extractSimpleFileExistenceTarget,
  mergeAgentTeamSettings,
  messageContentToText,
  parseTransitionStatus,
  safeProjectRelativePath,
  teamErrorMessage,
  teamObjectivePreview,
  teamRoleToSubagentRole,
} from "@/lib/agent-team/route-helpers";
import { sanitizeAgentTeamObjective } from "@/lib/agent-team/objective";
import { createAgentTeamResultPrompt } from "@/lib/agent-team/result-ingestion";
import { prepareAgentTeamMemberWorktree } from "@/lib/agent-team/worktree-policy";
import {
  acceptStoredAgentTeamFinding,
  approveStoredAgentTeamPlan,
  claimStoredAgentTeamTask,
  cleanupStoredAgentTeamWorktrees,
  completeStoredAgentTeamInitialFrame,
  completeStoredAgentTeamTask,
  createStoredAgentTeamChallenge,
  dismissStoredAgentTeamChallenge,
  failStoredAgentTeamTask,
  followUpStoredAgentTeamMember,
  getAgentTeamRun,
  hydrateStoredAgentTeamRun,
  listAgentTeamRuns,
  listAgentTeamRunsByParentSessionPath,
  markStoredAgentTeamIdle,
  mergeStoredAgentTeamWorktree,
  planStoredAgentTeamDispatches,
  planStoredAgentTeamDispatch,
  putAgentTeamRun,
  promoteStoredAgentTeamMember,
  recordStoredAgentTeamDecision,
  recoverStoredAgentTeamStaleTasks,
  recoverStoredAgentTeamRun,
  rejectStoredAgentTeamFinding,
  rejectStoredAgentTeamPlan,
  replaceStoredAgentTeamMember,
  resolveStoredAgentTeamChallenge,
  retryStoredAgentTeamTask,
  sendStoredAgentTeamMessage,
  settleStoredAgentTeamCompletedSynthesis,
  synthesizeStoredAgentTeamFromAvailableWork,
  submitStoredAgentTeamPlan,
  submitStoredAgentTeamResult,
  transitionStoredAgentTeamRun,
  updateStoredAgentTeamHook,
  validateStoredAgentTeamWorktreePaths,
} from "@/lib/agent-team/server-store";
import {
  attachAgentTeamDiagnostics,
  diagnoseAgentTeamRun,
  recommendedAgentTeamActions,
} from "@/lib/agent-team/diagnostics";
import {
  correctNamedFileReviewVerdict,
  correctSimpleFileExistenceVerdict,
} from "@/lib/agent-team/deterministic-verdict";
import { getAgentTeamFinalSummary } from "@/lib/agent-team/final-summary";
import type { AgentTeamDispatchPlan } from "@/lib/agent-team/runtime";
import type { AgentTeamRun } from "@/lib/agent-team/types";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import { invalidateSessionListCache } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AgentRecord = NonNullable<ReturnType<typeof getAgent>>;

function maybeCompleteSimpleFileExistenceTeamRun(
  rec: AgentRecord,
  teamId: string,
  run: AgentTeamRun,
  reason?: string
): { run?: AgentTeamRun; completed?: boolean } {
  if (run.status !== "running") return {};
  const target = safeProjectRelativePath(extractSimpleFileExistenceTarget(run.objective) ?? "");
  if (!target) return {};
  const hasProviderStreamBlock = (run.blockReasons ?? []).some(
    (item) => item.code === "provider_stream_error"
  );
  const retryExhaustedProviderTask = run.board.tasks.find(
    (task) =>
      task.required &&
      task.status === "blocked" &&
      /stream ended without finish_reason|provider stream|模型调用失败/i.test(
        [task.lastError, task.blocker].filter(Boolean).join(" ")
      ) &&
      (task.retryCount ?? 0) >= 1
  );
  if (!hasProviderStreamBlock && !retryExhaustedProviderTask) return {};

  const absolute = path.resolve(rec.cwd, target);
  const cwdRoot = path.resolve(rec.cwd);
  if (absolute !== cwdRoot && !absolute.startsWith(`${cwdRoot}${path.sep}`)) return {};
  const exists = fs.existsSync(absolute);
  const evidenceTask =
    retryExhaustedProviderTask ??
    run.board.tasks.find((task) => task.required && task.status !== "completed") ??
    run.board.tasks.find((task) => task.id === "frame");
  if (!evidenceTask) return {};
  const memberId = evidenceTask.ownerAgentId || run.leadAgentId;
  const claim = exists
    ? `存在：${target} 在当前项目中。`
    : `不存在：未在当前项目找到 ${target}。`;
  const rawText = [
    claim,
    `证据：file:${target}`,
    "说明：团队负责人使用本地文件检查收束这个简单存在性任务。",
  ].join("\n");
  const submitted = submitStoredAgentTeamResult(teamId, {
    taskId: evidenceTask.id,
    memberId,
    rawText,
    dispatchMode: "until_idle",
  });
  const withFinding = submitted.run ?? run;
  if (submitted.error) {
    logAgentTeamWarn("deterministic simple file check failed", {
      teamId,
      taskId: evidenceTask.id,
      memberId,
      error: submitted.error,
      recommendedAction: "retry_task",
    });
    return { run: withFinding };
  }
  const summarized = synthesizeStoredAgentTeamFromAvailableWork(teamId, {
    actorAgentId: run.leadAgentId,
    reason: "成员模型连续断流；这个任务是简单文件存在性确认，已由负责人用本地文件检查完成。",
  });
  const finalRun = summarized.run ?? withFinding;
  logAgentTeamInfo("deterministic simple file check succeeded", {
    teamId,
    taskId: evidenceTask.id,
    memberId,
    target,
    exists,
    reason: reason ?? null,
    recommendedAction: "finalize_with_deterministic_evidence",
  });
  return { run: finalRun, completed: finalRun.status === "completed" };
}

function maybeCompleteNamedFileReviewTeamRun(
  rec: AgentRecord,
  teamId: string,
  run: AgentTeamRun,
  reason?: string
): { run?: AgentTeamRun; completed?: boolean } {
  const corrected = correctNamedFileReviewVerdict(run, {
    cwd: rec.cwd,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
  });
  if (!corrected.corrected) return {};
  putAgentTeamRun(corrected.run);
  logAgentTeamInfo("deterministic named file review succeeded", {
    teamId,
    targets: corrected.targets,
    reason: reason ?? null,
    recommendedAction: "finalize_with_deterministic_evidence",
  });
  return { run: corrected.run, completed: corrected.run.status === "completed" };
}

function latestAssistantMessage(rec: AgentRecord): {
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
} | null {
  const message = rec.session.agent.state.messages
    .filter((item) => item.role === "assistant")
    .at(-1) as
      | {
          content?: unknown;
          stopReason?: unknown;
          errorMessage?: unknown;
          message?: { stopReason?: unknown; errorMessage?: unknown };
        }
      | undefined;
  if (!message) return null;
  return {
    content: message.content,
    stopReason: message.stopReason ?? message.message?.stopReason,
    errorMessage: message.errorMessage ?? message.message?.errorMessage,
  };
}

function assistantReplyTextOrThrow(rec: AgentRecord): string {
  const latest = latestAssistantMessage(rec);
  const text = messageContentToText(latest?.content).trim();
  const stopReason = typeof latest?.stopReason === "string" ? latest.stopReason : "";
  const errorMessage = typeof latest?.errorMessage === "string" ? latest.errorMessage.trim() : "";
  if (text.length > 0) return text;
  if (stopReason === "error" || errorMessage) {
    throw new Error(errorMessage ? `Member model error: ${errorMessage}` : "Member model error");
  }
  throw new Error("Member returned no content.");
}

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

const TEAM_LOG_PREFIX = "[agent-team]";

function teamDispatchTimeoutMs(): number {
  // 委托给集中配置（RUNTIME_LIMITS 已处理 DIGA_AGENT_TEAM_DISPATCH_TIMEOUT_MS
  // env 覆盖），此处仅额外施加 30s 下限，避免误配出极短超时打断成员。
  return Math.max(30_000, RUNTIME_LIMITS.teamDispatchTimeoutMs());
}

function logAgentTeamInfo(message: string, data: Record<string, unknown>): void {
  console.info(`${TEAM_LOG_PREFIX} ${message}`, data);
}

function logAgentTeamWarn(message: string, data: Record<string, unknown>): void {
  console.warn(`${TEAM_LOG_PREFIX} ${message}`, data);
}

function logAgentTeamError(message: string, data: Record<string, unknown>): void {
  console.error(`${TEAM_LOG_PREFIX} ${message}`, data);
}

function agentTeamResponse(run: AgentTeamRun, extra: Record<string, unknown> = {}) {
  const diagnosed = attachAgentTeamDiagnostics(run);
  const blockReasons = diagnoseAgentTeamRun(diagnosed);
  return {
    ...extra,
    run: {
      ...diagnosed,
      blockReasons,
    },
    blockReasons,
    recommendedActions: recommendedAgentTeamActions(blockReasons),
    recoveryAttempts: diagnosed.recoveryAttempts ?? [],
  };
}

function teamDispatchTimeoutMessage(): string {
  const seconds = Math.round(teamDispatchTimeoutMs() / 1000);
  return `等待成员返回证据已超过 ${seconds} 秒，系统已自动收回任务并准备重派。`;
}

async function withTeamDispatchTimeout<T>(
  promise: Promise<T>,
  onTimeout: () => Promise<void> | void
): Promise<{ ok: true; value: T } | { ok: false; timedOut: true }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ ok: false; timedOut: true }>((resolve) => {
    timeout = setTimeout(async () => {
      await onTimeout();
      resolve({ ok: false, timedOut: true });
    }, teamDispatchTimeoutMs());
  });
  const result = await Promise.race([
    promise.then((value) => ({ ok: true as const, value })),
    timeoutPromise,
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}

function canAccessTeamRun(
  run: AgentTeamRun | undefined,
  agentId: string,
  rec: AgentRecord
): run is AgentTeamRun {
  if (!run) return false;
  if (run.parentAgentId === agentId) return true;
  return Boolean(rec.session.sessionFile && run.parentSessionPath === rec.session.sessionFile);
}

function listAccessibleTeamRuns(agentId: string, rec: AgentRecord): AgentTeamRun[] {
  const seen = new Set<string>();
  const bySession = rec.session.sessionFile
    ? listAgentTeamRunsByParentSessionPath(rec.session.sessionFile)
    : [];
  return [...listAgentTeamRuns(agentId), ...bySession]
    .filter((run) => {
      if (seen.has(run.id)) return false;
      seen.add(run.id);
      return true;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function hasIdleClaimedTeamTask(run: AgentTeamRun): boolean {
  return run.board.tasks.some((task) => {
    if (task.status !== "claimed" && task.status !== "running") return false;
    if (run.board.results.some((result) => result.taskId === task.id)) return false;
    const owner = run.members.find((member) => member.id === task.ownerAgentId);
    const ownerRec = owner?.agentId ? getAgent(owner.agentId) : undefined;
    return !ownerRec || (!ownerRec.isStreaming && !ownerRec.pendingToolCall);
  });
}

const DEFAULT_AGENT_TEAM_BATCH_DISPATCHES = 4;
const DEFAULT_AGENT_TEAM_UNTIL_IDLE_ROUNDS = 8;
const SERVER_AGENT_TEAM_AUTO_ADVANCE_COOLDOWN_MS = 60_000;
const serverAgentTeamAutoAdvanceAttempts = new Map<string, number>();

function scheduleAgentTeamAutoAdvance(
  req: Request,
  agentId: string,
  teamId: string,
  plannedMembers: number
): void {
  const url = new URL(req.url);
  url.pathname = `/api/agent/${encodeURIComponent(agentId)}/teams`;
  url.search = "";
  const headers = new Headers();
  headers.set("content-type", "application/json");
  for (const name of [
    "authorization",
    "cookie",
    "x-diga-agent-local-secret",
  ]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const maxDispatches = Math.min(
    5,
    Math.max(1, plannedMembers > 1 ? plannedMembers - 1 : DEFAULT_AGENT_TEAM_BATCH_DISPATCHES)
  );
  windowlessSetTimeout(async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "run_until_idle",
          teamId,
          maxDispatches,
          maxRounds: DEFAULT_AGENT_TEAM_UNTIL_IDLE_ROUNDS,
        }),
      });
      if (!res.ok) {
        logAgentTeamWarn("background auto advance failed", {
          teamId,
          status: res.status,
          recommendedAction: "manual_retry_auto_process",
        });
      }
    } catch (err) {
      logAgentTeamWarn("background auto advance failed", {
        teamId,
        error: teamErrorMessage(err),
        recommendedAction: "manual_retry_auto_process",
      });
    }
  }, 120);
}

function maybeScheduleStaleAgentTeamAutoAdvance(
  req: Request,
  agentId: string,
  run: AgentTeamRun
): void {
  const now = Date.now();
  if (!shouldAutoKickAgentTeamRun(run, now)) return;
  const previous = serverAgentTeamAutoAdvanceAttempts.get(run.id) ?? 0;
  if (now - previous < SERVER_AGENT_TEAM_AUTO_ADVANCE_COOLDOWN_MS) return;
  serverAgentTeamAutoAdvanceAttempts.set(run.id, now);
  logAgentTeamInfo("backend auto advance scheduled", {
    teamId: run.id,
    recommendedAction: "run_until_idle",
  });
  scheduleAgentTeamAutoAdvance(req, agentId, run.id, run.members.length);
}

function windowlessSetTimeout(
  callback: () => void,
  delayMs: number
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, delayMs);
}

function persistAgentTeamStartInSession(rec: AgentRecord, objective: string): void {
  const messages = (rec.session.agent?.state?.messages ?? []) as Array<{
    role?: string;
    content?: unknown;
  }>;
  const lastMessage = messages.at(-1);
  const alreadyLast =
    lastMessage?.role === "user" &&
    typeof lastMessage.content === "string" &&
    lastMessage.content.trim() === objective;
  if (!alreadyLast) {
    const message = {
      role: "user" as const,
      content: objective,
      timestamp: Date.now(),
    };
    rec.session.agent?.state?.messages?.push(message);
    appendAgentTeamSessionMessage(rec, message);
  }
  if (!rec.session.sessionManager.getSessionName?.()) {
    const title =
      objective.length > 40 ? `${objective.slice(0, 40)}...` : objective;
    rec.session.setSessionName?.(`团队协作：${title}`);
  }
  flushAgentTeamSessionFile(rec);
}

function agentTeamMemberSessionTitle(member: { name?: string; role?: string }, taskTitle?: string): string {
  const memberName =
    member.name === "Research"
      ? "资料员"
      : member.name === "Critic"
        ? "质疑者"
        : member.name === "Synthesis"
          ? "整理者"
          : member.name === "Validation"
            ? "验收员"
            : member.name || member.role || "团队成员";
  const suffix = taskTitle?.trim() || "团队协作记录";
  return `${memberName}：${suffix}`;
}

function persistAgentTeamMemberSessionTitle(
  agentId: string | undefined,
  title: string
): void {
  if (!agentId) return;
  const memberRec = getAgent(agentId);
  if (!memberRec) return;
  memberRec.session.setSessionName?.(title);
  flushAgentTeamSessionFile(memberRec);
}

function persistAgentTeamFinalSummaryInSession(rec: AgentRecord, run: AgentTeamRun): void {
  if (run.status !== "completed") return;
  const marker = `agent-team-final:${run.id}`;
  const contentText = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : ""
    )
      .join("");
  };
  const messages = (rec.session.agent?.state?.messages ?? []) as Array<{
    role?: string;
    content?: unknown;
  }>;
  const alreadyPersisted = messages.some(
    (record) =>
      record.role === "assistant" && contentText(record.content).includes(marker)
  );
  if (alreadyPersisted) return;
  const decision = run.board.decisions.at(-1);
  const finalSummary = getAgentTeamFinalSummary(run);
  const summaryLines = finalSummary
    ? finalSummary.concise
      ? [finalSummary.verdict].filter(Boolean)
      : [
          finalSummary.verdict,
          ...finalSummary.bullets.map((bullet) => `- ${bullet}`),
          finalSummary.risk ? `风险：${finalSummary.risk}` : "",
        ].filter(Boolean)
    : [];
  const rationale = summaryLines.join("\n").trim() || decision?.rationale?.trim();
  if (!rationale) return;
  const text = [
    "结论",
    "",
    rationale,
    "",
    `<!-- ${marker} -->`,
  ].join("\n");
  const modelId = rec.session.model?.id ?? "team";
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message = {
    role: "assistant" as const,
    provider: rec.session.model?.provider ?? "team",
    model: modelId,
    api: (rec.session.model as { api?: string } | undefined)?.api ?? "agent-team",
    content: [{ type: "text" as const, text }],
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  rec.session.agent?.state?.messages?.push(message as never);
  appendAgentTeamSessionMessage(rec, message as never);
  flushAgentTeamSessionFile(rec);
}

function appendAgentTeamSessionMessage(rec: AgentRecord, message: unknown): void {
  const sessionManager = rec.session.sessionManager as unknown as {
    appendMessage?: (message: unknown) => void;
  };
  sessionManager.appendMessage?.(message);
}

function pushAgentTeamRunEvent(rec: AgentRecord, run: AgentTeamRun): void {
  const corrected = correctSimpleFileExistenceVerdict(run, {
    cwd: rec.cwd,
    existsSync: fs.existsSync,
  });
  const namedReviewCorrected = correctNamedFileReviewVerdict(corrected.run, {
    cwd: rec.cwd,
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
  });
  const eventRun = namedReviewCorrected.run;
  if (corrected.corrected) {
    putAgentTeamRun(corrected.run);
    logAgentTeamInfo("deterministic file existence verdict corrected", {
      teamId: corrected.run.id,
      target: corrected.target,
      exists: corrected.exists,
      recommendedAction: "use_deterministic_verdict",
    });
  }
  if (namedReviewCorrected.corrected) {
    putAgentTeamRun(eventRun);
    logAgentTeamInfo("deterministic named file review corrected", {
      teamId: eventRun.id,
      targets: namedReviewCorrected.targets,
      recommendedAction: "use_deterministic_verdict",
    });
  }
  persistAgentTeamFinalSummaryInSession(rec, eventRun);
  pushAgentTeamEvent(rec, {
    type: eventRun.status === "completed" ? "agent_team_run_finalized" : "agent_team_run_update",
    run: eventRun,
  });
}

function flushAgentTeamSessionFile(rec: AgentRecord): void {
  const sessionManager = rec.session.sessionManager as unknown as {
    _rewriteFile?: () => void;
    flushed?: boolean;
  };
  sessionManager._rewriteFile?.();
  sessionManager.flushed = true;
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
    if (!canAccessTeamRun(run, id, rec)) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    maybeScheduleStaleAgentTeamAutoAdvance(req, id, run);
    return NextResponse.json(agentTeamResponse(run, { ok: true }));
  }
  const runs = listAccessibleTeamRuns(id, rec);
  for (const run of runs) {
    maybeScheduleStaleAgentTeamAutoAdvance(req, id, run);
  }
  return NextResponse.json({
    runs: runs.map((run) => attachAgentTeamDiagnostics(run)),
  });
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
    // Feature flag：关闭时仅禁止新建 team；既有 team 的查看/恢复/dispatch 仍放行。
    if (!FEATURE_FLAGS.agentTeamEnabled()) {
      return NextResponse.json(
        { error: "agent_team_disabled" },
        { status: 403 }
      );
    }
    const clientRequestId =
      typeof body.clientRequestId === "string"
        ? body.clientRequestId.trim().slice(0, 128)
        : "";
    if (clientRequestId && !claimClientRequest(rec.id, `team:${clientRequestId}`)) {
      return NextResponse.json({ ok: true, deduped: true });
    }
    const objective =
      typeof body.objective === "string"
        ? sanitizeAgentTeamObjective(body.objective)
        : "";
    if (!objective) {
      return NextResponse.json({ error: "objective is required" }, { status: 400 });
    }
    try {
      persistAgentTeamStartInSession(rec, objective);
      invalidateSessionListCache();
      const provisional = createInitialAgentTeamRun(objective);
      const settings = mergeAgentTeamSettings(provisional.settings, body.settings);
      const run = createInitialAgentTeamRun(objective, settings);
      logAgentTeamInfo("planner selected team", {
        teamId: run.id,
        parentAgentId: id,
        modelId: rec.session.model?.id ?? null,
        provider: rec.session.model?.provider ?? null,
        memberScale: settings.memberScale,
        allowWrite: settings.allowWrite,
        allowNetwork: settings.allowNetwork,
        allowChallenges: settings.allowChallenges,
        tags: run.plannerInputs?.tags ?? [],
        plannedMembers: run.members.length,
        plannedTeammates: Math.max(0, run.members.length - 1),
        plannedTasks: run.board.tasks.length,
        objectivePreview: teamObjectivePreview(objective),
      });
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
      const framed = completeStoredAgentTeamInitialFrame(stored.id);
      const readyRun = framed.run ?? stored;
      pushAgentTeamEvent(rec, { type: "agent_team_run_start", run: readyRun });
      scheduleAgentTeamAutoAdvance(req, id, readyRun.id, readyRun.members.length);
      return NextResponse.json(agentTeamResponse(readyRun, { ok: true }));
    } catch (err) {
      const message = teamErrorMessage(err);
      logAgentTeamError("team start failed", {
        parentAgentId: id,
        modelId: rec.session.model?.id ?? null,
        provider: rec.session.model?.provider ?? null,
        objectivePreview: teamObjectivePreview(objective),
        error: message,
      });
      return NextResponse.json(
        {
          ok: false,
          error: `团队启动失败：${message}`,
          recommendedAction: "请换一个可用模型后重试，或先用普通对话确认模型能正常回复。",
        },
        { status: 500 }
      );
    }
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
    if (!canAccessTeamRun(existing, id, rec)) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const result = transitionStoredAgentTeamRun(teamId, status);
    if (!result.run) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const namedReview =
      status === "aborted"
        ? { run: result.run }
        : maybeCompleteNamedFileReviewTeamRun(
            rec,
            teamId,
            result.run,
            "manual transition"
          );
    const transitionRun = namedReview.run ?? result.run;
    persistAgentTeamFinalSummaryInSession(rec, transitionRun);
    pushAgentTeamEvent(rec, {
      type: status === "completed" && result.blockedReasons.length === 0
        ? "agent_team_run_finalized"
        : "agent_team_run_update",
      run: transitionRun,
    });
    if (status === "aborted") {
      void (async () => {
        await shutdownAgentTeamTeammates(existing, rec);
        const cleaned = await cleanupStoredAgentTeamWorktrees(teamId, { cwd: rec.cwd });
        if (cleaned.run) pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: cleaned.run });
      })().catch((err) => {
        logAgentTeamWarn("team stop cleanup failed", {
          teamId,
          error: teamErrorMessage(err),
        });
      });
    }
    return NextResponse.json(agentTeamResponse(transitionRun, {
      ok: result.blockedReasons.length === 0,
      blockedReasons: result.blockedReasons,
    }));
  }

  if (type === "resume") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const model = rec.session.model;
    if (!model) {
      return NextResponse.json({ error: "current agent has no model for teammate resume" }, { status: 400 });
    }
    const hydrated = await hydrateStoredAgentTeamRun(teamId, {
      recreateIdleTeammates: true,
      sessionExists: (sessionFile) => fs.existsSync(sessionFile),
      recreateMember: async (member) => {
        if (!member.sessionFile) throw new Error("missing teammate session file");
        const created = await createAgent({
          provider: model.provider,
          modelId: model.id,
          cwd: rec.cwd,
          sessionPath: member.sessionFile,
          thinkingLevel: rec.session.thinkingLevel,
          parentAgentId: rec.id,
          parentSessionPath: rec.session.sessionFile,
          childRole: teamRoleToSubagentRole(member.role),
          hidden: true,
        });
        return {
          agentId: created.id,
          sessionFile: created.sessionFile,
          modelId: model.id,
        };
      },
    });
    if (!hydrated.run) {
      return NextResponse.json({ error: hydrated.error ?? "team run not found" }, { status: 404 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: hydrated.run });
    return NextResponse.json(agentTeamResponse(hydrated.run, {
      ok: hydrated.missing.length === 0 && hydrated.replaced.length === 0,
      rehydrated: hydrated.rehydrated,
      missing: hydrated.missing,
      replaced: hydrated.replaced,
    }));
  }

  if (type === "merge_worktree") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const strategy =
      body.strategy === "accept" ||
      body.strategy === "discard" ||
      body.strategy === "keep_branch"
        ? body.strategy
        : null;
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    if (!memberId || !strategy) {
      return NextResponse.json(
        { error: "merge_worktree requires memberId and strategy" },
        { status: 400 }
      );
    }
    const result = await mergeStoredAgentTeamWorktree(teamId, memberId, strategy, {
      cwd: rec.cwd,
    });
    if (!result.run) {
      return NextResponse.json({ error: result.error ?? "team run not found" }, { status: 404 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json(agentTeamResponse(result.run, {
      ok: !result.error,
      error: result.error,
    }));
  }

  if (type === "claim_task") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
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
    return NextResponse.json(agentTeamResponse(result.run, { ok: !result.error, error: result.error }));
  }

  if (type === "complete_task") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
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
    return NextResponse.json(agentTeamResponse(result.run, { ok: !result.error, error: result.error }));
  }

  if (type === "submit_result") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const rawText = typeof body.rawText === "string" ? body.rawText.trim() : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
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
    return NextResponse.json(agentTeamResponse(result.run, { ok: !result.error, error: result.error }));
  }

  if (type === "accept_finding" || type === "reject_finding") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const findingId = typeof body.findingId === "string" ? body.findingId : "";
    const actorAgentId = typeof body.actorAgentId === "string" ? body.actorAgentId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
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
    return NextResponse.json(agentTeamResponse(result.run, { ok: !result.error, error: result.error }));
  }

  if (type === "create_challenge" || type === "resolve_challenge" || type === "dismiss_challenge") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
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
    return NextResponse.json(agentTeamResponse(result.run, { ok: !result.error, error: result.error }));
  }

  if (type === "record_decision") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
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
    return NextResponse.json(agentTeamResponse(result.run, { ok: !result.error, error: result.error }));
  }

  if (type === "submit_plan" || type === "approve_plan" || type === "reject_plan") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
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
    return NextResponse.json(agentTeamResponse(result.run, { ok: !result.error, error: result.error }));
  }

  if (type === "send_message") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const fromAgentId = typeof body.fromAgentId === "string" ? body.fromAgentId : "";
    const bodyText = typeof body.body === "string" ? body.body.trim() : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
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
    return NextResponse.json(agentTeamResponse(result.run, { ok: !result.error, error: result.error }));
  }

  if (type === "follow_up_member") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const toAgentId = typeof body.memberId === "string" ? body.memberId : "";
    const fromAgentId = typeof body.fromAgentId === "string" ? body.fromAgentId : "";
    const bodyText = typeof body.body === "string" ? body.body.trim() : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
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
          await targetRec.session.prompt(prompt, { streamingBehavior: "followUp" });
        }
        const replyText = messageContentToText(targetRec.session.agent.state.messages
          .filter((message) => message.role === "assistant")
          .at(-1)?.content).trim();
        if (replyText) {
          const reply = followUpStoredAgentTeamMember(teamId, {
            fromAgentId: member.id,
            toAgentId: existing.leadAgentId,
            body: replyText.slice(0, 1200),
            taskId: typeof body.taskId === "string" ? body.taskId : member.currentTaskId,
            findingId: typeof body.findingId === "string" ? body.findingId : undefined,
            challengeId: typeof body.challengeId === "string" ? body.challengeId : undefined,
          });
          latestRun = reply.run ?? latestRun;
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
    return NextResponse.json(agentTeamResponse(latestRun, { ok: true }));
  }

  if (type === "promote_member") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
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
    return NextResponse.json(agentTeamResponse(result.run, {
      ok: true,
      sessionFile: result.run.members.find((item) => item.id === memberId)?.sessionFile,
    }));
  }

  if (type === "configure_hook") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const hookId = typeof body.hookId === "string" ? body.hookId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
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
    return NextResponse.json(agentTeamResponse(result.run, { ok: true }));
  }

  if (type === "retry_task") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const result = retryStoredAgentTeamTask(teamId, taskId);
    if (!result.run || result.error) {
      return NextResponse.json({ error: result.error ?? "retry failed" }, { status: 400 });
    }
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json(agentTeamResponse(result.run, { ok: true }));
  }

  if (type === "diagnose_team") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    return NextResponse.json(agentTeamResponse(existing, { ok: true }));
  }

  if (type === "recover_team") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const result = recoverStoredAgentTeamRun(teamId, { maxAttempts: 2 });
    if (!result.run || result.error) {
      return NextResponse.json({ error: result.error ?? "recover failed" }, { status: 400 });
    }
    logAgentTeamInfo("recovery attempted", {
      teamId,
      recoveredTaskIds: result.recoveredTaskIds,
      adapterAttempts: result.attempts.filter((attempt) => attempt.action === "adapt_result").map((attempt) => attempt.status),
      recommendedAction: result.recoveredTaskIds.length > 0 ? "result adapter succeeded" : "run_until_idle",
    });
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json(agentTeamResponse(result.run, {
      ok: true,
      recoveredTaskIds: result.recoveredTaskIds,
    }));
  }

  if (type === "manual_submit_finding") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const claim = typeof body.claim === "string" ? body.claim.trim() : "";
    const evidenceRefs = Array.isArray(body.evidenceRefs)
      ? body.evidenceRefs.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    if (!taskId || !memberId || !claim) {
      return NextResponse.json({ error: "manual_submit_finding requires taskId, memberId and claim" }, { status: 400 });
    }
    const result = submitStoredAgentTeamResult(teamId, {
      taskId,
      memberId,
      rawText: [
        "TEAM_RESULT_JSON:",
        "```json",
        JSON.stringify({
          summary: claim,
          findings: [{ claim, confidence: body.confidence ?? "medium", evidenceRefs }],
          challenges: [],
          needsFollowUp: [],
        }),
        "```",
      ].join("\n"),
      dispatchMode: "single",
    });
    if (!result.run || result.error) {
      return NextResponse.json({ error: result.error ?? "manual finding failed" }, { status: 400 });
    }
    logAgentTeamInfo("manual intervention applied", {
      teamId,
      taskId,
      memberId,
      recommendedAction: "manual_submit_finding",
    });
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: result.run });
    return NextResponse.json(agentTeamResponse(result.run, { ok: true }));
  }

  if (type === "skip_task_with_reason" || type === "finalize_with_risks") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const reason = typeof body.reason === "string"
      ? body.reason
      : type === "finalize_with_risks"
        ? "基于当前已有结果给出阶段性结论，并保留未完成部分的风险。"
        : "跳过当前阻塞项，基于已有结果给出阶段性结论。";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const result = synthesizeStoredAgentTeamFromAvailableWork(teamId, {
      actorAgentId: existing.leadAgentId,
      reason: taskId ? `${reason} 跳过任务：${taskId}` : reason,
    });
    if (!result.run || result.error) {
      return NextResponse.json({ error: result.error ?? "finalize with risks failed" }, { status: 400 });
    }
    logAgentTeamInfo("manual intervention applied", {
      teamId,
      taskId: taskId || undefined,
      recommendedAction: type,
      forcedTaskIds: result.forcedTaskIds,
    });
    pushAgentTeamRunEvent(rec, result.run);
    return NextResponse.json(agentTeamResponse(result.run, {
      ok: result.blockedReasons.length === 0,
      forcedTaskIds: result.forcedTaskIds,
    }));
  }

  if (type === "repair_result") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const resultId = typeof body.resultId === "string" ? body.resultId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const target = existing.board.results.find((item) => item.id === resultId);
    if (!target) return NextResponse.json({ error: "result not found" }, { status: 404 });
    const retried = retryStoredAgentTeamTask(teamId, target.taskId);
    if (!retried.run || retried.error) {
      return NextResponse.json({ error: retried.error ?? "repair failed" }, { status: 400 });
    }
    logAgentTeamInfo("recovery attempted", {
      teamId,
      taskId: target.taskId,
      resultId,
      reasonCode: "invalid_result_json",
      recommendedAction: "retry_task",
    });
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: retried.run });
    return NextResponse.json(agentTeamResponse(retried.run, { ok: true, repairedResultId: resultId }));
  }

  if (type === "summarize_available") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const result = synthesizeStoredAgentTeamFromAvailableWork(teamId, {
      actorAgentId: existing.leadAgentId,
      reason,
    });
    if (!result.run || result.error) {
      return NextResponse.json({ error: result.error ?? "summarize failed" }, { status: 400 });
    }
    pushAgentTeamRunEvent(rec, result.run);
    return NextResponse.json(agentTeamResponse(result.run, {
      ok: result.blockedReasons.length === 0,
      blockedReasons: result.blockedReasons,
      forcedTaskIds: result.forcedTaskIds,
    }));
  }

  if (type === "replace_member") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const memberId = typeof body.memberId === "string" ? body.memberId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
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
    return NextResponse.json(agentTeamResponse(result.run, { ok: true }));
  }

  if (type === "run_next" || type === "run_batch" || type === "run_until_idle") {
    const teamId = typeof body.teamId === "string" ? body.teamId : "";
    const existing = getAgentTeamRun(teamId);
    if (!canAccessTeamRun(existing, id, rec)) {
      return NextResponse.json({ error: "team run not found" }, { status: 404 });
    }
    const maxDispatches =
      type === "run_next"
        ? 1
        : typeof body.maxDispatches === "number"
          ? Math.max(1, Math.min(8, Math.floor(body.maxDispatches)))
          : DEFAULT_AGENT_TEAM_BATCH_DISPATCHES;
    const maxRounds =
      type === "run_until_idle"
        ? typeof body.maxRounds === "number"
          ? Math.max(1, Math.min(12, Math.floor(body.maxRounds)))
          : DEFAULT_AGENT_TEAM_UNTIL_IDLE_ROUNDS
        : 1;
    const framed = completeStoredAgentTeamInitialFrame(teamId);
    let latestRun = framed.run ?? existing;
    if (framed.run && framed.completed) {
      pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: framed.run });
    }
    const blockedRecovery = recoverStoredAgentTeamRun(teamId, { maxAttempts: 2 });
    if (blockedRecovery.run && blockedRecovery.recoveredTaskIds.length > 0) {
      latestRun = blockedRecovery.run;
      logAgentTeamInfo("recovery attempted", {
        teamId,
        recoveredTaskIds: blockedRecovery.recoveredTaskIds,
        recommendedAction: "run_until_idle",
      });
      pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: blockedRecovery.run });
    }
    const recovered = recoverStoredAgentTeamStaleTasks(teamId, { staleMs: teamDispatchTimeoutMs() });
    latestRun = recovered.run ?? latestRun;
    if (recovered.run && recovered.recoveredTaskIds.length > 0) {
      pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: recovered.run });
    }
    const dispatched: AgentTeamDispatchResult["dispatched"] = [];
    const errors: string[] = [];
    let rounds = 0;
    const stopIfAborted = (): boolean => {
      const current = getAgentTeamRun(teamId);
      if (current?.status !== "aborted") return false;
      latestRun = current;
      return true;
    };

    for (let round = 0; round < maxRounds; round += 1) {
      let plannedRun: AgentTeamRun | undefined;
      let plannedError: string | undefined;
      let plans: AgentTeamDispatchPlan[] = [];
      const currentBeforePlan = getAgentTeamRun(teamId) ?? latestRun;
      if (stopIfAborted()) break;
      const framedRound = completeStoredAgentTeamInitialFrame(teamId);
      if (framedRound.run && framedRound.completed) {
        latestRun = framedRound.run;
        pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: framedRound.run });
      }
      const recoveredRound = recoverStoredAgentTeamStaleTasks(teamId, { staleMs: teamDispatchTimeoutMs() });
      latestRun = recoveredRound.run ?? latestRun ?? currentBeforePlan;
      if (recoveredRound.run && recoveredRound.recoveredTaskIds.length > 0) {
        pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: recoveredRound.run });
      }
      if (stopIfAborted()) break;
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
      if (plans.length > 0) {
        logAgentTeamInfo("dispatch planned", {
          teamId,
          dispatchMode: type,
          round: round + 1,
          planned: plans.map((plan) => ({ taskId: plan.task.id, memberId: plan.memberId })),
        });
      }
      if (!plannedRun || plans.length === 0) {
        if (type === "run_until_idle" && hasIdleClaimedTeamTask(latestRun)) {
          const recoveredNoPlan = recoverStoredAgentTeamStaleTasks(teamId, { staleMs: 1 });
          if (recoveredNoPlan.run && recoveredNoPlan.recoveredTaskIds.length > 0) {
            latestRun = recoveredNoPlan.run;
            pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: recoveredNoPlan.run });
            continue;
          }
        }
        const settled = settleStoredAgentTeamCompletedSynthesis(teamId);
        if (settled.run) {
          latestRun = settled.run;
          pushAgentTeamRunEvent(rec, settled.run);
          if (settled.settled || settled.run.status === "completed") break;
        }
        if (stopIfAborted()) break;
        const deterministic = maybeCompleteSimpleFileExistenceTeamRun(
          rec,
          teamId,
          getAgentTeamRun(teamId) ?? latestRun,
          plannedError ?? "no dispatch plan"
        );
        if (deterministic.run) {
          latestRun = deterministic.run;
          pushAgentTeamRunEvent(rec, deterministic.run);
          if (deterministic.completed) break;
        }
        const namedReview = maybeCompleteNamedFileReviewTeamRun(
          rec,
          teamId,
          getAgentTeamRun(teamId) ?? latestRun,
          plannedError ?? "no dispatch plan"
        );
        if (namedReview.run) {
          latestRun = namedReview.run;
          pushAgentTeamRunEvent(rec, namedReview.run);
          if (namedReview.completed) break;
        }
        if (round === 0) {
          return NextResponse.json(
            agentTeamResponse(latestRun, { ok: false, error: plannedError ?? "no dispatch plan" }),
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
      if (stopIfAborted()) break;
      dispatched.push(...result.dispatched);
      errors.push(...result.errors);
      rounds += 1;
      if (latestRun.status === "completed") pushAgentTeamRunEvent(rec, latestRun);
      if (type !== "run_until_idle") break;
      if (result.errors.length > 0) {
        const recoveredAfterError = recoverStoredAgentTeamRun(teamId, { maxAttempts: 2 });
        latestRun = recoveredAfterError.run ?? latestRun;
        if (recoveredAfterError.run && recoveredAfterError.recoveredTaskIds.length > 0) {
          pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: recoveredAfterError.run });
        }
        const deterministic = maybeCompleteSimpleFileExistenceTeamRun(
          rec,
          teamId,
          getAgentTeamRun(teamId) ?? latestRun,
          result.errors.join("; ")
        );
        if (deterministic.run) {
          latestRun = deterministic.run;
          pushAgentTeamRunEvent(rec, deterministic.run);
          if (deterministic.completed) break;
        }
        const namedReview = maybeCompleteNamedFileReviewTeamRun(
          rec,
          teamId,
          getAgentTeamRun(teamId) ?? latestRun,
          result.errors.join("; ")
        );
        if (namedReview.run) {
          latestRun = namedReview.run;
          pushAgentTeamRunEvent(rec, namedReview.run);
          if (namedReview.completed) break;
        }
        const nextPlan = planStoredAgentTeamDispatches(teamId, maxDispatches);
        if (!nextPlan.plans?.length) {
          const currentAfterRecovery = getAgentTeamRun(teamId) ?? latestRun;
          if ((currentAfterRecovery.settings.mode ?? "collaboration") === "collaboration") {
            const summarized = synthesizeStoredAgentTeamFromAvailableWork(teamId, {
              actorAgentId: currentAfterRecovery.leadAgentId,
              reason: "自动恢复次数已用完；团队基于已有结果给出带风险总结。",
            });
            latestRun = summarized.run ?? currentAfterRecovery;
            if (summarized.run) {
              pushAgentTeamRunEvent(rec, summarized.run);
              const namedReviewAfterSummary = maybeCompleteNamedFileReviewTeamRun(
                rec,
                teamId,
                getAgentTeamRun(teamId) ?? summarized.run,
                "summarized after recovery exhausted"
              );
              if (namedReviewAfterSummary.run) {
                latestRun = namedReviewAfterSummary.run;
                pushAgentTeamRunEvent(rec, namedReviewAfterSummary.run);
              }
            }
          } else {
            const idle = markStoredAgentTeamIdle(teamId);
            latestRun = idle.run ?? currentAfterRecovery;
            if (idle.run) pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: idle.run });
          }
          break;
        }
      }
    }

    let finalRun = getAgentTeamRun(teamId) ?? latestRun;
    const namedReview = maybeCompleteNamedFileReviewTeamRun(
      rec,
      teamId,
      finalRun,
      "final response preparation"
    );
    if (namedReview.run) {
      finalRun = namedReview.run;
    }
    if (finalRun.status === "completed") {
      persistAgentTeamFinalSummaryInSession(rec, finalRun);
    }
    return NextResponse.json(agentTeamResponse(finalRun, {
      ok: errors.length === 0,
      dispatched,
      errors,
      rounds,
    }));
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
    const targetRec = member?.agentId ? getAgent(member.agentId) : undefined;
    if (!member || !targetRec) {
      const reason = !member
        ? `Team member missing for ${plan.memberId}`
        : "Teammate session is not available; resume or replace this member before dispatch.";
      errors.push(reason);
      const failed = failStoredAgentTeamTask(teamId, plan.task.id, plan.memberId, reason);
      latestRun = failed.run ?? latestRun;
      if (failed.run) {
        const patched = putAgentTeamRun({
          ...failed.run,
          members: failed.run.members.map((item) =>
            item.id === plan.memberId
              ? {
                  ...item,
                  agentId: undefined,
                  hydrateState: "missing" as const,
                  status: "blocked" as const,
                  latestOutput: reason,
                  lastActiveAt: Date.now(),
                }
              : item
          ),
        });
        latestRun = patched;
        pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: patched });
      }
      continue;
    }
    const checkedWorktrees = validateStoredAgentTeamWorktreePaths(teamId, (worktreePath) =>
      fs.existsSync(worktreePath)
    );
    latestRun = checkedWorktrees.run ?? latestRun;
    if (checkedWorktrees.missingMemberIds.includes(plan.memberId)) {
      const reason = "Teammate worktree path is missing; merge, discard, or replace this member before dispatch.";
      errors.push(reason);
      const failed = failStoredAgentTeamTask(teamId, plan.task.id, plan.memberId, reason);
      latestRun = failed.run ?? latestRun;
      if (failed.run) pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: failed.run });
      continue;
    }
    const claimed = claimStoredAgentTeamTask(teamId, plan.task.id, plan.memberId);
    if (!claimed.run || claimed.error) {
      errors.push(claimed.error ?? `claim failed for ${plan.task.id}`);
      latestRun = claimed.run ?? latestRun;
      continue;
    }
    latestRun = claimed.run;
    persistAgentTeamMemberSessionTitle(
      targetRec.id,
      agentTeamMemberSessionTitle(member, plan.task.title)
    );
    claimedJobs.push({ plan, memberName: member?.name, targetRec });
    logAgentTeamInfo("task claimed", {
      teamId,
      taskId: plan.task.id,
      memberId: plan.memberId,
      agentId: targetRec.id,
    });
    pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: latestRun });
  }

  const results = await Promise.all(
    claimedJobs.map(async (job) => {
      const startedAt = Date.now();
      try {
        const prompt = createAgentTeamResultPrompt(job.plan.prompt, {
          mode: latestRun.settings.mode ?? "collaboration",
          evidenceRequired: job.plan.task.evidenceRequired,
        });
        const runPrompt = async (): Promise<string> => {
          logAgentTeamInfo("member prompt started", {
            teamId,
            taskId: job.plan.task.id,
            memberId: job.plan.memberId,
            agentId: job.targetRec.id,
            modelId: job.targetRec.session.model?.id ?? null,
            provider: job.targetRec.session.model?.provider ?? null,
          });
          if (isLocalCodingAssistantAgent(job.targetRec)) {
            return await promptLocalCodingAssistantAgent(job.targetRec, prompt);
          }
          await job.targetRec.session.prompt(prompt, { streamingBehavior: "followUp" });
          return assistantReplyTextOrThrow(job.targetRec);
        };
        const result = await withTeamDispatchTimeout(runPrompt(), async () => {
          if (isLocalCodingAssistantAgent(job.targetRec)) {
            await abortLocalCodingAssistantAgent(job.targetRec).catch(() => undefined);
          } else {
            await job.targetRec.session.abort().catch(() => undefined);
          }
        });
        if (!result.ok) {
          logAgentTeamWarn("member prompt ended", {
            teamId,
            taskId: job.plan.task.id,
            memberId: job.plan.memberId,
            agentId: job.targetRec.id,
            durationMs: Date.now() - startedAt,
            reasonCode: "member_timeout",
            error: teamDispatchTimeoutMessage(),
          });
          return {
            job,
            timedOut: true,
            error: teamDispatchTimeoutMessage(),
          };
        }
        logAgentTeamInfo("member prompt ended", {
          teamId,
          taskId: job.plan.task.id,
          memberId: job.plan.memberId,
          agentId: job.targetRec.id,
          durationMs: Date.now() - startedAt,
        });
        const rawText = result.value.trim();
        if (!rawText) {
          throw new Error("Member returned no content.");
        }
        return { job, rawText };
      } catch (err) {
        logAgentTeamError("member prompt ended", {
          teamId,
          taskId: job.plan.task.id,
          memberId: job.plan.memberId,
          agentId: job.targetRec.id,
          durationMs: Date.now() - startedAt,
          error: teamErrorMessage(err),
        });
        return {
          job,
          error: `Dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    })
  );

  for (const result of results) {
    const { job } = result;
    if ("timedOut" in result && result.timedOut) {
      const recovered = recoverStoredAgentTeamStaleTasks(teamId, { staleMs: 1 });
      latestRun = recovered.run ?? latestRun;
      if (recovered.run) pushAgentTeamEvent(rec, { type: "agent_team_run_update", run: recovered.run });
      continue;
    }
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
    if (!result.rawText) {
      const error = "Dispatch failed: Member returned no content.";
      errors.push(error);
      const failed = failStoredAgentTeamTask(
        teamId,
        job.plan.task.id,
        job.plan.memberId,
        error
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
    const currentRun = getAgentTeamRun(teamId);
    if (currentRun?.status !== "running") {
      latestRun = currentRun ?? latestRun;
      logAgentTeamInfo("result ingestion skipped after team finished", {
        teamId,
        taskId: job.plan.task.id,
        memberId: job.plan.memberId,
        agentId: job.targetRec.id,
        status: currentRun?.status,
      });
      continue;
    }
    const submitted = submitStoredAgentTeamResult(teamId, {
      taskId: job.plan.task.id,
      memberId: job.plan.memberId,
      rawText: result.rawText,
      sessionFile: currentRun.members.find((member) => member.id === job.plan.memberId)?.sessionFile,
      dispatchMode,
    });
    latestRun = submitted.run ?? latestRun;
    if (submitted.error) errors.push(submitted.error);
    logAgentTeamInfo(submitted.error ? "result ingestion needs_review" : "result ingestion succeeded", {
      teamId,
      taskId: job.plan.task.id,
      memberId: job.plan.memberId,
      agentId: job.targetRec.id,
      source: submitted.run?.board.results.at(-1)?.source,
      adaptedFromNaturalLanguage: submitted.run?.board.results.at(-1)?.adaptedFromNaturalLanguage,
      error: submitted.error,
    });
    if (submitted.run) pushAgentTeamRunEvent(rec, submitted.run);
  }

  return { run: getAgentTeamRun(teamId) ?? latestRun, dispatched, errors };
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
  if (!model) {
    logAgentTeamWarn("teammate spawn skipped because parent model is missing", {
      teamId: run.id,
      parentAgentId: rec.id,
      plannedMembers: run.members.length,
      objectivePreview: teamObjectivePreview(run.objective),
    });
    return run;
  }
  const now = Date.now();
  const members = [];
  const events = [...run.board.events];
  let worktreeRoot = run.worktreeRoot;
  logAgentTeamInfo("spawning initial teammates", {
    teamId: run.id,
    parentAgentId: rec.id,
    modelId: model.id,
    provider: model.provider,
    memberScale: run.settings.memberScale,
    plannedMembers: run.members.length,
    plannedTeammates: Math.max(0, run.members.length - 1),
    tags: run.plannerInputs?.tags ?? [],
  });
  for (const member of run.members) {
    if (member.id === run.leadAgentId) {
      members.push(member);
      continue;
    }
    try {
      const prepared = await prepareAgentTeamMemberWorktree({
        run,
        member,
        cwd: rec.cwd,
        now,
      });
      if (prepared.event) events.push(prepared.event);
      worktreeRoot = worktreeRoot ?? prepared.worktreeRoot;
      if (prepared.member.worktree?.status === "failed") {
        logAgentTeamWarn("teammate worktree preparation failed", {
          teamId: run.id,
          memberId: member.id,
          memberName: member.name,
          role: member.role,
          worktreeStatus: prepared.member.worktree.status,
          worktreeError: prepared.member.worktree.failureReason ?? null,
        });
        members.push(prepared.member);
        continue;
      }
      const created = await createAgent({
        provider: model.provider,
        modelId: model.id,
        cwd: prepared.cwd,
        thinkingLevel: rec.session.thinkingLevel,
        parentAgentId: rec.id,
        parentSessionPath: rec.session.sessionFile,
        childRole: teamRoleToSubagentRole(member.role),
        hidden: true,
      });
      persistAgentTeamMemberSessionTitle(
        created.id,
        agentTeamMemberSessionTitle(prepared.member)
      );
      members.push({
        ...prepared.member,
        agentId: created.id,
        sessionFile: created.sessionFile,
        modelId: model.id,
        status: "idle" as const,
        spawnedAt: now,
        lastActiveAt: now,
        latestOutput: "成员记录已准备好，等待任务认领。",
      });
      events.push({
        id: `${run.id}:event:spawned:${member.id}`,
        type: "member_spawned",
        at: now,
        actorAgentId: run.leadAgentId,
        targetAgentId: member.id,
        message: "成员记录已准备好。",
        data: {
          agentId: created.id,
          sessionFile: created.sessionFile,
          cwd: prepared.cwd,
          worktreeId: prepared.member.worktree?.id,
        },
      });
    } catch (err) {
      logAgentTeamError("teammate spawn failed", {
        teamId: run.id,
        memberId: member.id,
        memberName: member.name,
        role: member.role,
        modelId: model.id,
        provider: model.provider,
        error: teamErrorMessage(err),
      });
      members.push({
        ...member,
        status: "blocked" as const,
        latestOutput: `Teammate session 创建失败：${teamErrorMessage(err)}`,
      });
    }
  }
  const spawnedCount = members.filter((member) => member.agentId).length - 1;
  const blockedMembers = members.filter((member) => member.status === "blocked");
  logAgentTeamInfo("initial teammate spawn summary", {
    teamId: run.id,
    parentAgentId: rec.id,
    modelId: model.id,
    provider: model.provider,
    memberScale: run.settings.memberScale,
    plannedMembers: run.members.length,
    plannedTeammates: Math.max(0, run.members.length - 1),
    spawnedTeammates: Math.max(0, spawnedCount),
    blockedMembers: blockedMembers.map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
      latestOutput: member.latestOutput,
    })),
  });
  return {
    ...run,
    members,
    worktreeRoot,
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

/* teamRoleToSubagentRole / parseTransitionStatus / mergeAgentTeamSettings
 * 已下沉到 lib/agent-team/route-helpers.ts（带独立单测）。 */

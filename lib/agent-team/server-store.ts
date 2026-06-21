import "server-only";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AgentTeamRun } from "./types";
import {
  acceptAgentTeamFinding,
  claimAgentTeamTask,
  completeAgentTeamInitialFrame,
  completeAgentTeamTask,
  createAgentTeamChallenge,
  createAgentTeamDispatchPlan,
  createAgentTeamDispatchPlans,
  dismissAgentTeamChallenge,
  failAgentTeamTask,
  markAgentTeamTeammateIdle,
  patchAgentTeamRun,
  promoteAgentTeamMember,
  approveAgentTeamPlan,
  recordAgentTeamDecision,
  replaceAgentTeamMember,
  recordAgentTeamToolWrite,
  rejectAgentTeamPlan,
  rejectAgentTeamFinding,
  recoverStaleAgentTeamTasks,
  resolveAgentTeamChallenge,
  retryAgentTeamTask,
  sendAgentTeamMessage,
  settleAgentTeamCompletedSynthesis,
  submitAgentTeamPlan,
  submitAgentTeamResult,
  transitionAgentTeamRun,
  updateAgentTeamHook,
} from "./runtime";
import type { AgentTeamDispatchPlan } from "./runtime";

const AGENT_TEAM_STORE_SCHEMA_VERSION = 1;

interface PersistedAgentTeamRun {
  schemaVersion: 1;
  kind: "agent-team-run";
  run: AgentTeamRun;
  persistedAt: number;
}

interface AgentTeamStore {
  runs: Map<string, AgentTeamRun>;
  byParentAgentId: Map<string, Set<string>>;
  loadedFromDisk: boolean;
  rootOverride?: string | null;
}

const g = globalThis as unknown as { __digaAgentTeams?: AgentTeamStore };
if (!g.__digaAgentTeams) {
  g.__digaAgentTeams = {
    runs: new Map(),
    byParentAgentId: new Map(),
    loadedFromDisk: false,
    rootOverride: null,
  };
}

const store = g.__digaAgentTeams;

function defaultRoot(): string {
  return path.join(os.homedir(), ".diga-agent");
}

function getRoot(): string {
  return store.rootOverride ?? defaultRoot();
}

function runsDir(): string {
  return path.join(getRoot(), "agent-teams", "runs");
}

function runFilePath(id: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid agent team id: ${id}`);
  }
  return path.join(runsDir(), `${id}.json`);
}

function cloneRun(run: AgentTeamRun): AgentTeamRun {
  return JSON.parse(JSON.stringify(run)) as AgentTeamRun;
}

function isAgentTeamRun(value: unknown): value is AgentTeamRun {
  if (!value || typeof value !== "object") return false;
  const rec = value as Partial<AgentTeamRun>;
  return (
    typeof rec.id === "string" &&
    typeof rec.objective === "string" &&
    typeof rec.status === "string" &&
    typeof rec.leadAgentId === "string" &&
    Array.isArray(rec.members) &&
    !!rec.board &&
    Array.isArray(rec.board.tasks) &&
    Array.isArray(rec.board.findings) &&
    Array.isArray(rec.board.challenges) &&
    Array.isArray(rec.board.decisions) &&
    typeof rec.createdAt === "number"
  );
}

function normalizeRun(run: AgentTeamRun): AgentTeamRun {
  return {
    ...run,
    board: {
      ...run.board,
      results: run.board.results ?? [],
      plans: run.board.plans ?? [],
      messages: run.board.messages ?? [],
      fileLocks: run.board.fileLocks ?? [],
      hooks: run.board.hooks ?? [],
      qualityGates: run.board.qualityGates ?? [],
      capabilityAudit: run.board.capabilityAudit ?? [],
      events: run.board.events ?? [],
    },
    settings: run.settings ?? {
      memberScale: "standard",
      allowNetwork: false,
      allowWrite: false,
      allowWorktree: false,
      allowChallenges: true,
      requirePlanApproval: true,
      displayMode: "workspace",
      writePolicy: "plan_approval",
      networkPolicy: "disabled",
      worktreePolicy: "none",
      resultIngestionMode: "structured",
      stopConditions: {
        requiredTasksComplete: true,
        noOpenBlockingChallenges: true,
        leadFinalSynthesis: true,
      },
    },
  };
}

function parsePersisted(value: unknown): AgentTeamRun | null {
  if (isAgentTeamRun(value)) return normalizeRun(value);
  if (!value || typeof value !== "object") return null;
  const rec = value as Partial<PersistedAgentTeamRun>;
  if (rec.kind !== "agent-team-run" || rec.schemaVersion !== 1) return null;
  if (!isAgentTeamRun(rec.run)) return null;
  return normalizeRun(rec.run);
}

function indexRun(run: AgentTeamRun): void {
  if (!run.parentAgentId) return;
  let ids = store.byParentAgentId.get(run.parentAgentId);
  if (!ids) {
    ids = new Set();
    store.byParentAgentId.set(run.parentAgentId, ids);
  }
  ids.add(run.id);
}

function persistRun(run: AgentTeamRun): void {
  let tmp: string | null = null;
  let fd: number | null = null;
  try {
    fs.mkdirSync(runsDir(), { recursive: true });
    const file = runFilePath(run.id);
    tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
    const persisted: PersistedAgentTeamRun = {
      schemaVersion: AGENT_TEAM_STORE_SCHEMA_VERSION,
      kind: "agent-team-run",
      run,
      persistedAt: Date.now(),
    };
    fd = fs.openSync(tmp, "wx");
    fs.writeSync(fd, JSON.stringify(persisted, null, 2), 0, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    tmp = null;
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    if (tmp) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOSPC") throw err;
    console.warn("[agent-team-store] persist failed", {
      id: run.id,
      code,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function loadPersistedRuns(): void {
  if (store.loadedFromDisk) return;
  store.loadedFromDisk = true;
  let files: string[];
  try {
    files = fs.readdirSync(runsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn("[agent-team-store] list failed", err);
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(runsDir(), file), "utf8"));
      const run = parsePersisted(parsed);
      if (!run) continue;
      const normalized =
        run.status === "running" || run.status === "finalizing"
          ? {
              ...run,
              status: "paused" as const,
              updatedAt: Date.now(),
              board: {
                ...run.board,
                events: [
                  ...run.board.events,
                  {
                    id: `${run.id}:event:hydrate-paused`,
                    type: "team_paused" as const,
                    at: Date.now(),
                    actorAgentId: run.leadAgentId,
                    message:
                      "Team was paused during process restart; resume wakes only unfinished work.",
                  },
                ],
              },
            }
          : run;
      store.runs.set(normalized.id, cloneRun(normalized));
      indexRun(normalized);
      if (normalized !== run) persistRun(normalized);
    } catch (err) {
      console.warn("[agent-team-store] read failed", file, err);
    }
  }
}

export function putAgentTeamRun(run: AgentTeamRun): AgentTeamRun {
  loadPersistedRuns();
  const next = normalizeRun(cloneRun(run));
  store.runs.set(next.id, next);
  indexRun(next);
  persistRun(next);
  return cloneRun(next);
}

export function getAgentTeamRun(id: string): AgentTeamRun | undefined {
  loadPersistedRuns();
  const run = store.runs.get(id);
  return run ? cloneRun(run) : undefined;
}

export function listAgentTeamRuns(parentAgentId?: string): AgentTeamRun[] {
  loadPersistedRuns();
  if (!parentAgentId) {
    return Array.from(store.runs.values())
      .map(cloneRun)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const ids = store.byParentAgentId.get(parentAgentId);
  if (!ids) return [];
  return Array.from(ids)
    .map((id) => store.runs.get(id))
    .filter((run): run is AgentTeamRun => !!run)
    .map(cloneRun)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function listAgentTeamRunsByParentSessionPath(
  parentSessionPath: string
): AgentTeamRun[] {
  loadPersistedRuns();
  return Array.from(store.runs.values())
    .filter((run) => run.parentSessionPath === parentSessionPath)
    .map(cloneRun)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function patchStoredAgentTeamRun(
  id: string,
  patch: Partial<AgentTeamRun>
): AgentTeamRun | undefined {
  const run = getAgentTeamRun(id);
  if (!run) return undefined;
  return putAgentTeamRun(patchAgentTeamRun(run, patch));
}

export function transitionStoredAgentTeamRun(
  id: string,
  status: AgentTeamRun["status"]
): { run?: AgentTeamRun; blockedReasons: string[] } {
  const run = getAgentTeamRun(id);
  if (!run) return { blockedReasons: ["team run not found"] };
  const result = transitionAgentTeamRun(run, status);
  return {
    run: putAgentTeamRun(result.run),
    blockedReasons: result.blockedReasons,
  };
}

export function claimStoredAgentTeamTask(
  id: string,
  taskId: string,
  memberId: string,
  opts?: {
    writePaths?: string[];
  }
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = claimAgentTeamTask(run, taskId, memberId, opts);
  return {
    run: putAgentTeamRun(result.run),
    error: result.error,
  };
}

export function recordStoredAgentTeamToolWrite(
  memberAgentId: string,
  paths: string[]
): { run?: AgentTeamRun; error?: string; teamId?: string } {
  loadPersistedRuns();
  for (const run of store.runs.values()) {
    const member = run.members.find((item) => item.agentId === memberAgentId);
    if (!member) continue;
    if (run.status !== "running") {
      return { run: cloneRun(run), teamId: run.id, error: "team run is not running" };
    }
    if (run.settings.writePolicy === "read_only" || run.settings.allowWrite === false) {
      return { run: cloneRun(run), teamId: run.id, error: "Team write policy is read-only" };
    }
    if (run.settings.writePolicy === "plan_approval" || run.settings.requirePlanApproval) {
      const taskId = member.currentTaskId;
      const task = taskId ? run.board.tasks.find((item) => item.id === taskId) : undefined;
      const approvedPlan = task?.planId
        ? (run.board.plans ?? []).find(
            (plan) => plan.id === task.planId && plan.status === "approved"
          )
        : undefined;
      if (!approvedPlan) {
        return {
          run: cloneRun(run),
          teamId: run.id,
          error: "Team write policy requires an approved plan",
        };
      }
    }
    const result = recordAgentTeamToolWrite(cloneRun(run), member.id, paths);
    return {
      run: putAgentTeamRun(result.run),
      error: result.error,
      teamId: run.id,
    };
  }
  return {};
}

export function validateStoredAgentTeamToolPolicy(
  memberAgentId: string,
  opts: { toolName: string; isWrite?: boolean; isNetwork?: boolean }
): { run?: AgentTeamRun; error?: string; teamId?: string } {
  loadPersistedRuns();
  for (const run of store.runs.values()) {
    const member = run.members.find((item) => item.agentId === memberAgentId);
    if (!member) continue;
    if (run.status !== "running") return { run: cloneRun(run), teamId: run.id };
    if (opts.isNetwork && (run.settings.networkPolicy === "disabled" || run.settings.allowNetwork === false)) {
      return {
        run: cloneRun(run),
        teamId: run.id,
        error: `Team network policy blocks ${opts.toolName}`,
      };
    }
    if (opts.isWrite && (run.settings.writePolicy === "read_only" || run.settings.allowWrite === false)) {
      return {
        run: cloneRun(run),
        teamId: run.id,
        error: `Team write policy blocks ${opts.toolName}`,
      };
    }
    return { run: cloneRun(run), teamId: run.id };
  }
  return {};
}

export function completeStoredAgentTeamTask(
  id: string,
  taskId: string,
  memberId: string,
  opts?: {
    findingClaim?: string;
    evidenceRefs?: string[];
    confidence?: "low" | "medium" | "high";
    autoDispatched?: boolean;
    dispatchMode?: "single" | "batch" | "until_idle";
  }
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = completeAgentTeamTask(run, taskId, memberId, opts);
  return {
    run: putAgentTeamRun(result.run),
    error: result.error,
  };
}

export function submitStoredAgentTeamResult(
  id: string,
  opts: {
    taskId: string;
    memberId: string;
    rawText: string;
    sessionFile?: string;
    dispatchMode?: "single" | "batch" | "until_idle";
  }
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = submitAgentTeamResult(run, opts);
  return {
    run: putAgentTeamRun(result.run),
    error: result.error,
  };
}

export function failStoredAgentTeamTask(
  id: string,
  taskId: string,
  memberId: string,
  error: string
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = failAgentTeamTask(run, taskId, memberId, error);
  return {
    run: putAgentTeamRun(result.run),
    error: result.error,
  };
}

export function retryStoredAgentTeamTask(
  id: string,
  taskId: string
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = retryAgentTeamTask(run, taskId);
  return {
    run: putAgentTeamRun(result.run),
    error: result.error,
  };
}

export function recoverStoredAgentTeamStaleTasks(
  id: string,
  opts?: { now?: number; staleMs?: number }
): { run?: AgentTeamRun; recoveredTaskIds: string[]; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { recoveredTaskIds: [], error: "team run not found" };
  const result = recoverStaleAgentTeamTasks(run, opts);
  return {
    run: putAgentTeamRun(result.run),
    recoveredTaskIds: result.recoveredTaskIds,
  };
}

export function completeStoredAgentTeamInitialFrame(
  id: string
): { run?: AgentTeamRun; completed: boolean; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { completed: false, error: "team run not found" };
  const result = completeAgentTeamInitialFrame(run);
  return {
    run: putAgentTeamRun(result),
    completed:
      run.board.tasks.find((task) => task.id === "frame")?.status !== "completed" &&
      result.board.tasks.find((task) => task.id === "frame")?.status === "completed",
  };
}

export function settleStoredAgentTeamCompletedSynthesis(
  id: string
): { run?: AgentTeamRun; settled: boolean; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { settled: false, error: "team run not found" };
  const result = settleAgentTeamCompletedSynthesis(run);
  return {
    run: putAgentTeamRun(result),
    settled: result.status === "completed" && run.status !== "completed",
  };
}

export function replaceStoredAgentTeamMember(
  id: string,
  memberId: string,
  replacement: {
    agentId?: string;
    sessionFile?: string;
    modelId?: string;
  }
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = replaceAgentTeamMember(run, memberId, replacement);
  return {
    run: putAgentTeamRun(result.run),
    error: result.error,
  };
}

export function sendStoredAgentTeamMessage(
  id: string,
  message: {
    fromAgentId: string;
    toAgentId?: string;
    body: string;
    taskId?: string;
    findingId?: string;
    challengeId?: string;
  }
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = sendAgentTeamMessage(run, message);
  return {
    run: putAgentTeamRun(result.run),
    error: result.error,
  };
}

export function acceptStoredAgentTeamFinding(
  id: string,
  findingId: string,
  actorAgentId: string
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = acceptAgentTeamFinding(run, findingId, actorAgentId);
  return { run: putAgentTeamRun(result.run), error: result.error };
}

export function rejectStoredAgentTeamFinding(
  id: string,
  findingId: string,
  actorAgentId: string,
  reason: string
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = rejectAgentTeamFinding(run, findingId, actorAgentId, reason);
  return { run: putAgentTeamRun(result.run), error: result.error };
}

export function createStoredAgentTeamChallenge(
  id: string,
  opts: {
    targetFindingId: string;
    authorAgentId: string;
    reason: string;
    severity?: "low" | "medium" | "high";
    requiredEvidenceRefs?: string[];
  }
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = createAgentTeamChallenge(run, opts);
  return { run: putAgentTeamRun(result.run), error: result.error };
}

export function resolveStoredAgentTeamChallenge(
  id: string,
  challengeId: string,
  actorAgentId: string,
  resolution: string,
  resolutionFindingIds?: string[]
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = resolveAgentTeamChallenge(
    run,
    challengeId,
    actorAgentId,
    resolution,
    resolutionFindingIds
  );
  return { run: putAgentTeamRun(result.run), error: result.error };
}

export function dismissStoredAgentTeamChallenge(
  id: string,
  challengeId: string,
  actorAgentId: string,
  reason: string
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = dismissAgentTeamChallenge(run, challengeId, actorAgentId, reason);
  return { run: putAgentTeamRun(result.run), error: result.error };
}

export function recordStoredAgentTeamDecision(
  id: string,
  opts: {
    title: string;
    rationale: string;
    madeByAgentId: string;
    acceptedFindingIds: string[];
    rejectedFindingIds?: string[];
    challengeIds?: string[];
    evidenceRefs?: string[];
    sourceResultIds?: string[];
    confidence?: "low" | "medium" | "high";
  }
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = recordAgentTeamDecision(run, opts);
  return { run: putAgentTeamRun(result.run), error: result.error };
}

export function submitStoredAgentTeamPlan(
  id: string,
  opts: {
    taskId: string;
    authorAgentId: string;
    body: string;
    criteria?: string[];
  }
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = submitAgentTeamPlan(run, opts);
  return { run: putAgentTeamRun(result.run), error: result.error };
}

export function approveStoredAgentTeamPlan(
  id: string,
  planId: string,
  reviewerAgentId: string
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = approveAgentTeamPlan(run, planId, reviewerAgentId);
  return { run: putAgentTeamRun(result.run), error: result.error };
}

export function rejectStoredAgentTeamPlan(
  id: string,
  planId: string,
  reviewerAgentId: string,
  reason: string
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = rejectAgentTeamPlan(run, planId, reviewerAgentId, reason);
  return { run: putAgentTeamRun(result.run), error: result.error };
}

export function followUpStoredAgentTeamMember(
  id: string,
  message: {
    fromAgentId: string;
    toAgentId: string;
    body: string;
    taskId?: string;
    findingId?: string;
    challengeId?: string;
  }
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = sendAgentTeamMessage(run, message, { directFollowUp: true });
  return {
    run: putAgentTeamRun(result.run),
    error: result.error,
  };
}

export function promoteStoredAgentTeamMember(
  id: string,
  memberId: string
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = promoteAgentTeamMember(run, memberId);
  return {
    run: putAgentTeamRun(result.run),
    error: result.error,
  };
}

export function markStoredAgentTeamIdle(
  id: string
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  return { run: putAgentTeamRun(markAgentTeamTeammateIdle(run)) };
}

export function updateStoredAgentTeamHook(
  id: string,
  hookId: string,
  patch: {
    enabled?: boolean;
    severity?: "info" | "warning" | "blocking";
  }
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = updateAgentTeamHook(run, hookId, patch);
  return {
    run: putAgentTeamRun(result.run),
    error: result.error,
  };
}

export function planStoredAgentTeamDispatch(
  id: string
): { run?: AgentTeamRun; plan?: AgentTeamDispatchPlan; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  if (run.status !== "running") {
    return { run, error: "team run is not running" };
  }
  const plan = createAgentTeamDispatchPlan(run);
  if (!plan) return { run, error: "no runnable task or teammate" };
  return { run, plan };
}

export function planStoredAgentTeamDispatches(
  id: string,
  limit: number
): { run?: AgentTeamRun; plans?: AgentTeamDispatchPlan[]; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  if (run.status !== "running") {
    return { run, error: "team run is not running" };
  }
  const plans = createAgentTeamDispatchPlans(run, limit);
  if (plans.length === 0) return { run, error: "no runnable task or teammate" };
  return { run, plans };
}

export function setAgentTeamStoreRootForTests(root: string | null): void {
  store.rootOverride = root;
  store.runs.clear();
  store.byParentAgentId.clear();
  store.loadedFromDisk = false;
}

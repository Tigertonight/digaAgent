import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFileSync } from "@/lib/shared/atomic-json-store";
import type { AgentTeamCoordinationCall, AgentTeamRun } from "./types";
import {
  cleanupAgentTeamWorktrees,
  mergeAgentTeamMemberWorktree,
  markMissingAgentTeamWorktrees,
  type AgentTeamWorktreeMergeStrategy,
} from "./worktree-policy";
import type { WorkflowWorktreeManager } from "@/lib/workflows/types";
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
  recoverBlockedAgentTeamRun,
  resolveAgentTeamChallenge,
  retryAgentTeamTask,
  sendAgentTeamMessage,
  settleAgentTeamCompletedSynthesis,
  synthesizeAgentTeamFromAvailableWork,
  submitAgentTeamPlan,
  submitAgentTeamResult,
  transitionAgentTeamRun,
  updateAgentTeamHook,
} from "./runtime";
import type { AgentTeamDispatchPlan } from "./runtime";
import { hydrateAgentTeamRun, type HydrateAgentTeamOptions } from "./hydrate";

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
  const defaultSettings: AgentTeamRun["settings"] = {
    memberScale: "standard",
    allowNetwork: false,
    allowWrite: false,
    allowWorktree: false,
    allowChallenges: true,
    requirePlanApproval: true,
    displayMode: "workspace",
    writePolicy: "read_only",
    networkPolicy: "disabled",
    worktreePolicy: "none",
    resultIngestionMode: "structured",
    coordinationProfile: "basic",
    stopConditions: {
      requiredTasksComplete: true,
      noOpenBlockingChallenges: true,
      leadFinalSynthesis: true,
    },
  };
  const normalized: AgentTeamRun = {
    ...run,
    coordinationAudit: run.coordinationAudit ?? [],
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
    settings: (() => {
      const merged = {
      ...defaultSettings,
      ...(run.settings ?? {}),
      coordinationProfile: run.settings?.coordinationProfile ?? "basic",
      stopConditions: {
        ...defaultSettings.stopConditions,
        ...(run.settings?.stopConditions ?? {}),
      },
      };
      return {
        ...merged,
        writePolicy:
          merged.allowWrite === false
            ? "read_only"
            : merged.writePolicy === "write_allowed" || merged.writePolicy === "plan_approval"
              ? merged.writePolicy
              : merged.requirePlanApproval
                ? "plan_approval"
                : "write_allowed",
        networkPolicy:
          merged.allowNetwork === false
            ? "disabled"
            : merged.networkPolicy === "teammates_allowed" || merged.networkPolicy === "lead_only"
              ? merged.networkPolicy
              : "lead_only",
        worktreePolicy:
          merged.allowWorktree === false
            ? "none"
            : merged.worktreePolicy === "per_task" || merged.worktreePolicy === "per_member"
              ? merged.worktreePolicy
              : "per_member",
      };
    })(),
  };
  if (normalized.status !== "completed") return normalized;
  const archivedTaskIds = new Set(
    normalized.board.tasks
      .filter((task) => task.status !== "completed" && task.status !== "skipped")
      .map((task) => task.id)
  );
  if (archivedTaskIds.size === 0) return normalized;
  return {
    ...normalized,
    board: {
      ...normalized.board,
      tasks: normalized.board.tasks.map((task) =>
        archivedTaskIds.has(task.id)
          ? {
              ...task,
              status: "skipped" as const,
              ownerAgentId: task.ownerAgentId ?? normalized.leadAgentId,
              completedAt: task.completedAt ?? normalized.endedAt ?? normalized.updatedAt,
              completionSource: "lead_override" as const,
              blocker: undefined,
              lastError: undefined,
            }
          : task
      ),
      fileLocks: (normalized.board.fileLocks ?? []).map((lock) =>
        lock.status === "active"
          ? { ...lock, status: "released" as const, releasedAt: normalized.endedAt ?? normalized.updatedAt }
          : lock
      ),
    },
    members: normalized.members.map((member) =>
      member.currentTaskId && archivedTaskIds.has(member.currentTaskId)
        ? {
            ...member,
            status: "done" as const,
            currentTaskId: undefined,
            latestOutput: member.latestOutput ?? "最终总结已生成，剩余任务已随本次结论归档。",
          }
        : member
    ),
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
  const persisted: PersistedAgentTeamRun = {
    schemaVersion: AGENT_TEAM_STORE_SCHEMA_VERSION,
    kind: "agent-team-run",
    run,
    persistedAt: Date.now(),
  };
  atomicWriteFileSync(
    runFilePath(run.id),
    JSON.stringify(persisted, null, 2),
    "agent-team-store"
  );
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
              hydrate: {
                lastHydratedAt: Date.now(),
                rehydratedMemberIds: [],
                missingMemberIds: run.members
                  .filter((member) => member.id !== run.leadAgentId && !member.agentId)
                  .map((member) => member.id),
                notes: "Team was paused during process restart.",
              },
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
  const current = store.runs.get(next.id);
  if (current?.status === "aborted" && next.status !== "aborted") {
    return cloneRun(current);
  }
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

export function resolveStoredAgentTeamMemberByAgentId(
  memberAgentId: string
): {
  run?: AgentTeamRun;
  teamId?: string;
  memberId?: string;
  error?: string;
} {
  loadPersistedRuns();
  for (const run of store.runs.values()) {
    const member = run.members.find((item) => item.agentId === memberAgentId);
    if (!member) continue;
    return {
      run: cloneRun(run),
      teamId: run.id,
      memberId: member.id,
    };
  }
  return { error: "agent is not an active teammate in any Agent Team" };
}

export function recordStoredAgentTeamCoordinationCall(
  id: string,
  call: AgentTeamCoordinationCall
): { run?: AgentTeamRun; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  return {
    run: putAgentTeamRun({
      ...run,
      coordinationAudit: [...(run.coordinationAudit ?? []), call].slice(-200),
      updatedAt: Date.now(),
    }),
  };
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

export function synthesizeStoredAgentTeamFromAvailableWork(
  id: string,
  opts?: { actorAgentId?: string; reason?: string }
): { run?: AgentTeamRun; blockedReasons: string[]; forcedTaskIds: string[]; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) {
    return {
      blockedReasons: ["team run not found"],
      forcedTaskIds: [],
      error: "team run not found",
    };
  }
  const result = synthesizeAgentTeamFromAvailableWork(run, opts);
  return {
    run: putAgentTeamRun(result.run),
    blockedReasons: result.blockedReasons,
    forcedTaskIds: result.forcedTaskIds,
  };
}

export async function mergeStoredAgentTeamWorktree(
  id: string,
  memberId: string,
  strategy: AgentTeamWorktreeMergeStrategy,
  opts: {
    cwd: string;
    manager?: WorkflowWorktreeManager;
  }
): Promise<{ run?: AgentTeamRun; error?: string }> {
  const run = getAgentTeamRun(id);
  if (!run) return { error: "team run not found" };
  const result = await mergeAgentTeamMemberWorktree({
    run,
    memberId,
    strategy,
    cwd: opts.cwd,
    manager: opts.manager,
  });
  return {
    run: putAgentTeamRun(result.run),
    error: result.error,
  };
}

export async function cleanupStoredAgentTeamWorktrees(
  id: string,
  opts: {
    cwd: string;
    manager?: WorkflowWorktreeManager;
  }
): Promise<{ run?: AgentTeamRun; cleanedMemberIds: string[]; failedMemberIds: string[]; error?: string }> {
  const run = getAgentTeamRun(id);
  if (!run) {
    return { cleanedMemberIds: [], failedMemberIds: [], error: "team run not found" };
  }
  const result = await cleanupAgentTeamWorktrees({
    run,
    cwd: opts.cwd,
    manager: opts.manager,
  });
  return {
    run: putAgentTeamRun(result.run),
    cleanedMemberIds: result.cleanedMemberIds,
    failedMemberIds: result.failedMemberIds,
  };
}

export function validateStoredAgentTeamWorktreePaths(
  id: string,
  pathExists: (path: string) => boolean
): { run?: AgentTeamRun; missingMemberIds: string[]; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { missingMemberIds: [], error: "team run not found" };
  const result = markMissingAgentTeamWorktrees(run, pathExists);
  return {
    run: result.missingMemberIds.length > 0 ? putAgentTeamRun(result.run) : result.run,
    missingMemberIds: result.missingMemberIds,
  };
}

export async function hydrateStoredAgentTeamRun(
  id: string,
  opts?: HydrateAgentTeamOptions
): Promise<{ run?: AgentTeamRun; rehydrated: string[]; missing: string[]; replaced: string[]; error?: string }> {
  const run = getAgentTeamRun(id);
  if (!run) return { rehydrated: [], missing: [], replaced: [], error: "team run not found" };
  const result = await hydrateAgentTeamRun(run, opts);
  return {
    run: putAgentTeamRun(result.run),
    rehydrated: result.rehydrated,
    missing: result.missing,
    replaced: result.replaced,
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

export function recoverStoredAgentTeamRun(
  id: string,
  opts?: { now?: number; maxAttempts?: number }
): { run?: AgentTeamRun; recoveredTaskIds: string[]; attempts: ReturnType<typeof recoverBlockedAgentTeamRun>["attempts"]; error?: string } {
  const run = getAgentTeamRun(id);
  if (!run) return { recoveredTaskIds: [], attempts: [], error: "team run not found" };
  const result = recoverBlockedAgentTeamRun(run, opts);
  return {
    run: putAgentTeamRun(result.run),
    recoveredTaskIds: result.recoveredTaskIds,
    attempts: result.attempts,
  };
}

/**
 * 进程启动自检：扫描所有非终态 team run，对其卡住的 stale task 跑一次恢复。
 *
 * 背景：recovery 此前只在 dispatch API 被调用时被动触发。进程重启后，成员的
 * child agent session 已丢失（hydrate 标记 hydrateState=missing），若用户不再
 * 交互，team 会永久停在 running/working 态。启动时主动跑一次，把 stale task
 * 解阻塞、成员标记 missing，使下次打开 UI 呈现“可恢复”而非“永久转圈”。
 *
 * 幂等：基于 hydrate 后的状态与 staleMs 判定，重复调用不会重复 spawn。
 * 仅改 store 状态，不在此处真正 spawn agent（spawn 仍由 dispatch 路径负责）。
 */
export function runAgentTeamStartupRecovery(
  opts?: { now?: number; staleMs?: number }
): { scannedRuns: number; recoveredRuns: number; recoveredTaskIds: string[] } {
  loadPersistedRuns();
  const staleMs = opts?.staleMs ?? 1; // 重启后所有进行中 task 一律视为 stale
  const now = opts?.now ?? Date.now();
  const nonTerminal = listAgentTeamRuns().filter(
    (run) =>
      run.status === "running" ||
      run.status === "paused" ||
      run.status === "finalizing"
  );
  const recoveredTaskIds: string[] = [];
  let recoveredRuns = 0;
  for (const run of nonTerminal) {
    try {
      const result = recoverStoredAgentTeamStaleTasks(run.id, { now, staleMs });
      if (result.recoveredTaskIds.length > 0) {
        recoveredRuns += 1;
        recoveredTaskIds.push(...result.recoveredTaskIds);
      }
    } catch {
      // 单个 run 恢复失败不应阻塞其它 run 的启动自检。
    }
  }
  return {
    scannedRuns: nonTerminal.length,
    recoveredRuns,
    recoveredTaskIds,
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

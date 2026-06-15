import "server-only";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentGoal,
  GoalEvidence,
  GoalStatus,
  GoalTurn,
} from "./types";

const MAX_OBJECTIVE_CHARS = 4000;
const CURRENT_VERSION = 1 as const;

/**
 * On-disk (and in-memory) record for a single agent's goal. turn/evidence
 * history lives at the top level alongside `goal` (M1 修正 2) so it is never
 * double-written into AgentGoal.
 *
 * G2：envelope 额外记录该 goal 所属 session 的 sessionId/sessionFile，
 * 以便重启后能将 goal 复原到新 agentId。
 */
export interface GoalStoreEnvelope {
  version: number;
  goal: AgentGoal;
  turns?: GoalTurn[];
  evidence?: GoalEvidence[];
  /** 指向 SDK Session。重启后仅靠 agentId 会丢，所以以 sessionId 作为可恢复锪。 */
  sessionId?: string;
  sessionFile?: string;
}

interface GoalStore {
  /** agentId -> envelope */
  envelopes: Map<string, GoalStoreEnvelope>;
  /** sessionId -> agentId（最后一个拥有该 session goal 的 agentId）。仅作反查加速。 */
  sessionIndex: Map<string, string>;
}

const g = globalThis as unknown as { __digaAgentGoalsV2?: GoalStore };
if (!g.__digaAgentGoalsV2) {
  g.__digaAgentGoalsV2 = {
    envelopes: new Map(),
    sessionIndex: new Map(),
  };
}
const store = g.__digaAgentGoalsV2;
if (!store.sessionIndex) store.sessionIndex = new Map();

let activeRoot: string | null = null;
let hydrated = false;

function now(): number {
  return Date.now();
}

function getRoot(): string {
  return activeRoot ?? path.join(os.homedir(), ".diga-agent");
}

function goalsDir(): string {
  return path.join(getRoot(), "goals");
}

function assertSafeAgentId(agentId: string): void {
  if (
    !agentId ||
    agentId.includes("/") ||
    agentId.includes("\\") ||
    agentId.includes("..")
  ) {
    throw new Error(`invalid goal agent id: ${agentId}`);
  }
}

function goalFilePath(agentId: string): string {
  assertSafeAgentId(agentId);
  return path.join(goalsDir(), `${agentId}.json`);
}

export function normalizeObjective(objective: unknown): string {
  if (typeof objective !== "string") return "";
  return objective.trim().slice(0, MAX_OBJECTIVE_CHARS);
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return (
    value === "active" ||
    value === "paused" ||
    value === "complete" ||
    value === "blocked"
  );
}

/**
 * Strictly validate a raw goal object loaded from disk. Returns null when the
 * minimum required shape is missing so a corrupt file can be skipped.
 */
function sanitizeGoal(raw: unknown): AgentGoal | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.objective !== "string" || !src.objective) return null;
  if (!isGoalStatus(src.status)) return null;
  if (typeof src.turns !== "number") return null;
  if (typeof src.createdAt !== "number") return null;
  return {
    ...(src as unknown as AgentGoal),
    objective: src.objective,
    status: src.status,
    turns: src.turns,
    blockedStreak:
      typeof src.blockedStreak === "number" ? src.blockedStreak : 0,
    createdAt: src.createdAt,
    updatedAt: typeof src.updatedAt === "number" ? src.updatedAt : src.createdAt,
  };
}

function sanitizeEnvelope(raw: unknown): GoalStoreEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const goal = sanitizeGoal(src.goal);
  if (!goal) return null;
  return {
    version: typeof src.version === "number" ? src.version : CURRENT_VERSION,
    goal,
    turns: Array.isArray(src.turns)
      ? (src.turns as GoalTurn[])
      : undefined,
    evidence: Array.isArray(src.evidence)
      ? (src.evidence as GoalEvidence[])
      : undefined,
    sessionId:
      typeof src.sessionId === "string" && src.sessionId.length > 0
        ? src.sessionId
        : undefined,
    sessionFile:
      typeof src.sessionFile === "string" && src.sessionFile.length > 0
        ? src.sessionFile
        : undefined,
  };
}

function persistEnvelope(agentId: string, envelope: GoalStoreEnvelope): void {
  try {
    mkdirSync(goalsDir(), { recursive: true });
    const fp = goalFilePath(agentId);
    const tmp = `${fp}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(envelope, null, 2), "utf8");
    renameSync(tmp, fp);
  } catch {
    // Persistence is best-effort. Runtime execution must not fail because the
    // local metadata directory is temporarily unavailable.
  }
}

function hydrateFromDisk(): void {
  if (hydrated) return;
  hydrated = true;
  const dir = goalsDir();
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const agentId = name.slice(0, -".json".length);
    try {
      const envelope = sanitizeEnvelope(
        JSON.parse(readFileSync(path.join(dir, name), "utf8"))
      );
      if (!envelope) continue;
      store.envelopes.set(agentId, envelope);
      if (envelope.sessionId) {
        store.sessionIndex.set(envelope.sessionId, agentId);
      }
    } catch {
      // Ignore corrupt metadata files; they must not block other goals.
    }
  }
}

function getEnvelope(agentId: string): GoalStoreEnvelope | undefined {
  hydrateFromDisk();
  return store.envelopes.get(agentId);
}

function setEnvelope(agentId: string, envelope: GoalStoreEnvelope): void {
  // Validate before touching memory so an unsafe id fails fast instead of being
  // silently swallowed by the best-effort persist try/catch.
  assertSafeAgentId(agentId);
  store.envelopes.set(agentId, envelope);
  if (envelope.sessionId) {
    store.sessionIndex.set(envelope.sessionId, agentId);
  }
  persistEnvelope(agentId, envelope);
}

/**
 * G2：把当前 agent 的 goal 与 session 绑定。agent-registry 在创建 session
 * 后调一次；如果该 agent 还没 envelope·换言之该 agent 还没 setGoal，这里
 * 不会凄生出 empty envelope —— 仅作 session 绑定记录在内存中。
 */
export function bindGoalSession(
  agentId: string,
  sessionId: string | undefined,
  sessionFile: string | undefined
): void {
  if (!sessionId) return;
  hydrateFromDisk();
  store.sessionIndex.set(sessionId, agentId);
  const envelope = store.envelopes.get(agentId);
  if (!envelope) return; // 没有 goal，不必落盘
  if (
    envelope.sessionId === sessionId &&
    envelope.sessionFile === (sessionFile ?? envelope.sessionFile)
  ) {
    return;
  }
  setEnvelope(agentId, {
    ...envelope,
    sessionId,
    sessionFile: sessionFile ?? envelope.sessionFile,
  });
}

/**
 * G2：按 sessionId 反查 agentId。重启后 UI 拿到新 agentId，变项能通过
 * sessionId 找到老 envelope。返回仅供服务端使用。
 */
export function findAgentIdBySessionId(sessionId: string): string | null {
  hydrateFromDisk();
  return store.sessionIndex.get(sessionId) ?? null;
}

// ---------------------------------------------------------------------------
// Public API (mirrors the legacy server-store signatures 1:1).
// ---------------------------------------------------------------------------

export function getGoal(agentId: string): AgentGoal | null {
  return getEnvelope(agentId)?.goal ?? null;
}

export function setGoal(
  agentId: string,
  objective: string,
  tokenBudget?: number
): AgentGoal {
  hydrateFromDisk();
  const t = now();
  const goal: AgentGoal = {
    objective: normalizeObjective(objective),
    status: "active",
    tokenBudget:
      typeof tokenBudget === "number" &&
      Number.isFinite(tokenBudget) &&
      tokenBudget > 0
        ? tokenBudget
        : undefined,
    turns: 0,
    blockedStreak: 0,
    createdAt: t,
    updatedAt: t,
  };
  if (!goal.objective) throw new Error("goal objective required");
  setEnvelope(agentId, { version: CURRENT_VERSION, goal });
  return goal;
}

export function patchGoal(
  agentId: string,
  patch: Partial<Omit<AgentGoal, "createdAt" | "objective">> & {
    objective?: string;
  }
): AgentGoal | null {
  const envelope = getEnvelope(agentId);
  if (!envelope) return null;
  const current = envelope.goal;
  const next: AgentGoal = {
    ...current,
    ...patch,
    objective:
      patch.objective !== undefined
        ? normalizeObjective(patch.objective)
        : current.objective,
    updatedAt: now(),
  };
  if (!next.objective) throw new Error("goal objective required");
  setEnvelope(agentId, { ...envelope, goal: next });
  return next;
}

export function setGoalStatus(
  agentId: string,
  status: GoalStatus,
  details?: { blockedReason?: string; pauseReason?: string }
): AgentGoal | null {
  const envelope = getEnvelope(agentId);
  if (!envelope) return null;
  const current = envelope.goal;
  const t = now();
  const next: AgentGoal = {
    ...current,
    status,
    updatedAt: t,
    ...(status === "complete" ? { completedAt: t } : {}),
    ...(details?.blockedReason
      ? { blockedReason: details.blockedReason.slice(0, 500) }
      : {}),
    ...(details?.pauseReason
      ? { pauseReason: details.pauseReason.slice(0, 200) }
      : {}),
  };
  setEnvelope(agentId, { ...envelope, goal: next });
  return next;
}

export function clearGoal(agentId: string): null {
  hydrateFromDisk();
  store.envelopes.delete(agentId);
  try {
    unlinkSync(goalFilePath(agentId));
  } catch {
    // File may not exist yet; deletion is best-effort.
  }
  return null;
}

export function noteGoalContinuation(agentId: string): AgentGoal | null {
  const envelope = getEnvelope(agentId);
  if (!envelope) return null;
  const current = envelope.goal;
  const t = now();
  const next: AgentGoal = {
    ...current,
    turns: current.turns + 1,
    lastRunAt: t,
    updatedAt: t,
  };
  setEnvelope(agentId, { ...envelope, goal: next });
  return next;
}

// ---------------------------------------------------------------------------
// M2 turn / evidence lifecycle. turn/evidence are persisted at the envelope
// top level (修正 2) so they survive restart alongside the goal.
// ---------------------------------------------------------------------------

const MAX_TURNS = 200;
const MAX_EVIDENCE = 200;

/**
 * Append a fully-formed turn record. Lower-level than start/finish; kept for
 * callers (and tests) that build a turn in one shot.
 */
export function addGoalTurn(agentId: string, turn: GoalTurn): AgentGoal | null {
  const envelope = getEnvelope(agentId);
  if (!envelope) return null;
  const turns = [...(envelope.turns ?? []), turn].slice(-MAX_TURNS);
  setEnvelope(agentId, { ...envelope, turns });
  return envelope.goal;
}

/**
 * Begin a new running turn. The turn number is derived from existing history so
 * it stays monotonic across restarts. Returns the created turn (or null when no
 * goal exists for the agent).
 */
export function startGoalTurn(
  agentId: string,
  fields?: { summary?: string }
): GoalTurn | null {
  const envelope = getEnvelope(agentId);
  if (!envelope) return null;
  const existing = envelope.turns ?? [];
  const turnNumber =
    existing.reduce((max, t) => Math.max(max, t.turnNumber), 0) + 1;
  const turn: GoalTurn = {
    turnNumber,
    startedAt: now(),
    status: "running",
    ...(fields?.summary ? { summary: fields.summary.slice(0, 500) } : {}),
  };
  const turns = [...existing, turn].slice(-MAX_TURNS);
  setEnvelope(agentId, { ...envelope, turns });
  return turn;
}

/**
 * Finish the most recent running turn (or a specific turnNumber). Merges the
 * provided patch and stamps endedAt. No-op when there is no matching open turn.
 */
export function finishGoalTurn(
  agentId: string,
  patch: {
    turnNumber?: number;
    status?: GoalTurn["status"];
    summary?: string;
    tokenUsed?: number;
    blockedReason?: string;
    evidenceIds?: string[];
  } = {}
): GoalTurn | null {
  const envelope = getEnvelope(agentId);
  if (!envelope) return null;
  const turns = [...(envelope.turns ?? [])];
  let idx = -1;
  if (typeof patch.turnNumber === "number") {
    idx = turns.findIndex((t) => t.turnNumber === patch.turnNumber);
  } else {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].status === "running") {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0) return null;
  const prev = turns[idx];
  const next: GoalTurn = {
    ...prev,
    endedAt: now(),
    status: patch.status ?? (prev.status === "running" ? "completed" : prev.status),
    ...(patch.summary !== undefined
      ? { summary: patch.summary.slice(0, 500) }
      : {}),
    ...(patch.tokenUsed !== undefined ? { tokenUsed: patch.tokenUsed } : {}),
    ...(patch.blockedReason !== undefined
      ? { blockedReason: patch.blockedReason.slice(0, 500) }
      : {}),
    ...(patch.evidenceIds !== undefined
      ? { evidenceIds: patch.evidenceIds.slice(0, 50) }
      : {}),
  };
  turns[idx] = next;
  setEnvelope(agentId, { ...envelope, turns });
  return next;
}

export function listGoalTurns(agentId: string): GoalTurn[] {
  return getEnvelope(agentId)?.turns ?? [];
}

export function addGoalEvidence(
  agentId: string,
  evidence: GoalEvidence
): AgentGoal | null {
  const envelope = getEnvelope(agentId);
  if (!envelope) return null;
  // De-duplicate by id so a re-emitted progress artifact does not pile up.
  const existing = envelope.evidence ?? [];
  const filtered = existing.filter((e) => e.id !== evidence.id);
  const list = [...filtered, evidence].slice(-MAX_EVIDENCE);
  setEnvelope(agentId, { ...envelope, evidence: list });
  return envelope.goal;
}

export function listGoalEvidence(agentId: string): GoalEvidence[] {
  return getEnvelope(agentId)?.evidence ?? [];
}

/**
 * Compact, structured recap of the most recent turns and evidence for injection
 * into the goal continuation prompt. Kept short and bounded.
 */
export function buildGoalRecap(
  agentId: string,
  opts?: { maxTurns?: number; maxEvidence?: number }
): string {
  const envelope = getEnvelope(agentId);
  if (!envelope) return "";
  const maxTurns = opts?.maxTurns ?? 3;
  const maxEvidence = opts?.maxEvidence ?? 5;
  const turns = (envelope.turns ?? []).slice(-maxTurns);
  const evidence = (envelope.evidence ?? []).slice(-maxEvidence);

  const lines: string[] = [];
  if (turns.length > 0) {
    lines.push("Recent turns:");
    for (const t of turns) {
      const bits = [`#${t.turnNumber} ${t.status}`];
      if (t.summary) bits.push(t.summary);
      else if (t.blockedReason) bits.push(`blocked: ${t.blockedReason}`);
      lines.push(`- ${bits.join(" — ")}`);
    }
  }
  if (evidence.length > 0) {
    lines.push("Evidence so far:");
    for (const e of evidence) {
      const ref = e.href ? ` (${e.href})` : "";
      lines.push(`- [${e.kind}] ${e.title}${ref}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Test support.
// ---------------------------------------------------------------------------

/**
 * Point the store at a temporary root and clear in-memory state. Disk files
 * under the previous root are left untouched; tests own their temp dirs.
 */
export function __setGoalStoreRootForTest(root: string | null): void {
  activeRoot = root;
  hydrated = false;
  store.envelopes.clear();
}

/**
 * Clear in-memory state and force a re-hydrate on next access. Does NOT delete
 * disk files, so "restart resume" tests can verify recovery from disk.
 */
export function __resetGoalStoreForTest(): void {
  store.envelopes.clear();
  hydrated = false;
}

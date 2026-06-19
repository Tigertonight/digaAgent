import "server-only";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

export type SubagentMemoryScope = "user" | "project" | "local";

/**
 * Compact, structured, auditable long-term experience for a specialist. Kept
 * short on purpose — this is injected into the child prompt, not the full
 * history. Mirrors the goal/file-store persistence范式.
 */
export interface SubagentMemory {
  agentId: string;
  scope: SubagentMemoryScope;
  facts: string[];
  decisions: string[];
  recurringRisks: string[];
  preferredFiles: string[];
  updatedAt: number;
}

const MAX_ITEMS = 20;
const MAX_ITEM_CHARS = 300;
const CURRENT_VERSION = 1 as const;

interface MemoryEnvelope {
  version: number;
  memory: SubagentMemory;
}

interface MemoryStore {
  /** `${scope}/${agentId}` -> memory */
  cache: Map<string, SubagentMemory>;
}

const g = globalThis as unknown as { __digaAgentSubagentMemory?: MemoryStore };
if (!g.__digaAgentSubagentMemory) {
  g.__digaAgentSubagentMemory = { cache: new Map() };
}
const store = g.__digaAgentSubagentMemory;

let rootOverride: string | null = null;

function getRoot(): string {
  return rootOverride ?? path.join(os.homedir(), ".diga-agent");
}

function memoryDir(scope: SubagentMemoryScope): string {
  return path.join(getRoot(), "subagents", "memory", scope);
}

function assertSafe(id: string): void {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid subagent memory id: ${id}`);
  }
}

function memoryFile(scope: SubagentMemoryScope, agentId: string): string {
  assertSafe(agentId);
  return path.join(memoryDir(scope), `${agentId}.json`);
}

function cacheKey(scope: SubagentMemoryScope, agentId: string): string {
  return `${scope}/${agentId}`;
}

function emptyMemory(
  agentId: string,
  scope: SubagentMemoryScope
): SubagentMemory {
  return {
    agentId,
    scope,
    facts: [],
    decisions: [],
    recurringRisks: [],
    preferredFiles: [],
    updatedAt: Date.now(),
  };
}

function cleanList(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim().slice(0, MAX_ITEM_CHARS))
    .filter(Boolean)
    .slice(-MAX_ITEMS);
}

function sanitize(
  raw: unknown,
  agentId: string,
  scope: SubagentMemoryScope
): SubagentMemory | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  return {
    agentId,
    scope,
    facts: cleanList(src.facts),
    decisions: cleanList(src.decisions),
    recurringRisks: cleanList(src.recurringRisks),
    preferredFiles: cleanList(src.preferredFiles),
    updatedAt: typeof src.updatedAt === "number" ? src.updatedAt : Date.now(),
  };
}

// T2.8: 同步原子写 + ENOSPC 重抣 + 其他 errno warn。
function persist(memory: SubagentMemory): void {
  let tmp: string | null = null;
  let fd: number | null = null;
  try {
    mkdirSync(memoryDir(memory.scope), { recursive: true });
    const fp = memoryFile(memory.scope, memory.agentId);
    tmp = `${fp}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
    const envelope: MemoryEnvelope = { version: CURRENT_VERSION, memory };
    fd = openSync(tmp, "wx");
    writeSync(fd, JSON.stringify(envelope, null, 2), 0, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, fp);
    tmp = null;
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    if (tmp) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOSPC") {
      console.warn("[subagent-memory] persist failed (no space)", {
        agentId: memory.agentId,
        code,
      });
      throw err;
    }
    console.warn("[subagent-memory] persist failed", {
      agentId: memory.agentId,
      code,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function getSubagentMemory(
  agentId: string,
  scope: SubagentMemoryScope = "project"
): SubagentMemory | null {
  const key = cacheKey(scope, agentId);
  if (store.cache.has(key)) return store.cache.get(key)!;
  const fp = memoryFile(scope, agentId);
  if (!existsSync(fp)) return null;
  try {
    const env = JSON.parse(readFileSync(fp, "utf8")) as MemoryEnvelope;
    const mem = sanitize(env.memory, agentId, scope);
    if (mem) store.cache.set(key, mem);
    return mem;
  } catch {
    return null;
  }
}

export function updateSubagentMemory(
  agentId: string,
  scope: SubagentMemoryScope,
  patch: Partial<Omit<SubagentMemory, "agentId" | "scope" | "updatedAt">>
): SubagentMemory {
  const current =
    getSubagentMemory(agentId, scope) ?? emptyMemory(agentId, scope);
  const next: SubagentMemory = {
    ...current,
    ...(patch.facts ? { facts: cleanList(patch.facts) } : {}),
    ...(patch.decisions ? { decisions: cleanList(patch.decisions) } : {}),
    ...(patch.recurringRisks
      ? { recurringRisks: cleanList(patch.recurringRisks) }
      : {}),
    ...(patch.preferredFiles
      ? { preferredFiles: cleanList(patch.preferredFiles) }
      : {}),
    updatedAt: Date.now(),
  };
  store.cache.set(cacheKey(scope, agentId), next);
  persist(next);
  return next;
}

export function clearSubagentMemory(
  agentId: string,
  scope: SubagentMemoryScope = "project"
): void {
  store.cache.delete(cacheKey(scope, agentId));
  // Disk file left in place is acceptable; overwrite on next update. For an
  // explicit wipe we persist an empty memory.
  persist(emptyMemory(agentId, scope));
}

/**
 * Render a compact memory block for injection into the child prompt. Returns ""
 * when there is nothing useful, so callers can skip injection.
 */
export function renderMemoryForPrompt(memory: SubagentMemory | null): string {
  if (!memory) return "";
  const sections: string[] = [];
  if (memory.facts.length) {
    sections.push("Known facts:", ...memory.facts.map((f) => `- ${f}`));
  }
  if (memory.decisions.length) {
    sections.push("Past decisions:", ...memory.decisions.map((d) => `- ${d}`));
  }
  if (memory.recurringRisks.length) {
    sections.push(
      "Recurring risks:",
      ...memory.recurringRisks.map((r) => `- ${r}`)
    );
  }
  if (memory.preferredFiles.length) {
    sections.push(
      "Relevant files:",
      ...memory.preferredFiles.map((p) => `- ${p}`)
    );
  }
  return sections.join("\n");
}

export function __setSubagentMemoryRootForTest(root: string | null): void {
  rootOverride = root;
  store.cache.clear();
}

export function __resetSubagentMemoryForTest(): void {
  store.cache.clear();
}

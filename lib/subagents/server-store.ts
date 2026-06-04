import "server-only";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  SubagentBatch,
  SubagentBatchStatus,
  SubagentTaskRuntime,
  SubagentTaskStatus,
} from "./types";

interface SubagentStore {
  batches: Map<string, SubagentBatch>;
  byParentAgentId: Map<string, Set<string>>;
}

const g = globalThis as unknown as { __miniPiSubagents?: SubagentStore };
if (!g.__miniPiSubagents) {
  g.__miniPiSubagents = {
    batches: new Map(),
    byParentAgentId: new Map(),
  };
}
const store = g.__miniPiSubagents!;
let activeRoot: string | null = null;
let hydrated = false;

function getRoot(): string {
  return activeRoot ?? path.join(os.homedir(), ".mini-pi");
}

function batchDir(): string {
  return path.join(getRoot(), "subagents", "batches");
}

function assertSafeBatchId(batchId: string): void {
  if (
    !batchId ||
    batchId.includes("/") ||
    batchId.includes("\\") ||
    batchId.includes("..")
  ) {
    throw new Error(`invalid subagent batch id: ${batchId}`);
  }
}

function batchFilePath(batchId: string): string {
  assertSafeBatchId(batchId);
  return path.join(batchDir(), `${batchId}.json`);
}

function indexBatch(batch: SubagentBatch): void {
  let ids = store.byParentAgentId.get(batch.parentAgentId);
  if (!ids) {
    ids = new Set();
    store.byParentAgentId.set(batch.parentAgentId, ids);
  }
  ids.add(batch.id);
}

function isBatchStatus(value: unknown): value is SubagentBatchStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "aborted"
  );
}

function isTaskStatus(value: unknown): value is SubagentTaskStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "aborted" ||
    value === "timeout"
  );
}

function sanitizeBatch(raw: unknown): SubagentBatch | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.id !== "string") return null;
  if (typeof src.parentAgentId !== "string") return null;
  if (typeof src.reason !== "string") return null;
  if (!isBatchStatus(src.status)) return null;
  if (!Array.isArray(src.tasks)) return null;
  const tasks: SubagentTaskRuntime[] = [];
  for (const rawTask of src.tasks) {
    if (!rawTask || typeof rawTask !== "object") return null;
    const task = rawTask as Record<string, unknown>;
    if (typeof task.id !== "string") return null;
    if (typeof task.title !== "string") return null;
    if (typeof task.prompt !== "string") return null;
    if (!isTaskStatus(task.status)) return null;
    tasks.push(task as unknown as SubagentTaskRuntime);
  }
  return {
    ...(src as unknown as SubagentBatch),
    id: src.id,
    parentAgentId: src.parentAgentId,
    parentSessionPath:
      typeof src.parentSessionPath === "string" ? src.parentSessionPath : undefined,
    status: src.status,
    reason: src.reason,
    synthesisInstructions:
      typeof src.synthesisInstructions === "string"
        ? src.synthesisInstructions
        : undefined,
    planning:
      src.planning && typeof src.planning === "object"
        ? (src.planning as SubagentBatch["planning"])
        : undefined,
    tasks,
    createdAt: typeof src.createdAt === "number" ? src.createdAt : Date.now(),
    endedAt: typeof src.endedAt === "number" ? src.endedAt : undefined,
  };
}

function persistBatch(batch: SubagentBatch): void {
  try {
    mkdirSync(batchDir(), { recursive: true });
    const fp = batchFilePath(batch.id);
    const tmp = `${fp}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(batch, null, 2), "utf8");
    renameSync(tmp, fp);
  } catch {
    // Persistence is audit support. Runtime execution should not fail because
    // the local metadata directory is temporarily unavailable.
  }
}

function hydrateFromDisk(): void {
  if (hydrated) return;
  hydrated = true;
  const dir = batchDir();
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const batch = sanitizeBatch(
        JSON.parse(readFileSync(path.join(dir, name), "utf8"))
      );
      if (!batch) continue;
      store.batches.set(batch.id, batch);
      indexBatch(batch);
    } catch {
      // Ignore corrupt metadata files. They should not block other batches.
    }
  }
}

export function putBatch(batch: SubagentBatch): void {
  hydrateFromDisk();
  store.batches.set(batch.id, batch);
  indexBatch(batch);
  persistBatch(batch);
}

export function getBatch(batchId: string): SubagentBatch | undefined {
  hydrateFromDisk();
  return store.batches.get(batchId);
}

export function listBatches(parentAgentId?: string): SubagentBatch[] {
  hydrateFromDisk();
  if (!parentAgentId) return Array.from(store.batches.values());
  const ids = store.byParentAgentId.get(parentAgentId);
  if (!ids) return [];
  return Array.from(ids)
    .map((id) => store.batches.get(id))
    .filter((batch): batch is SubagentBatch => !!batch);
}

export function listBatchesByParentSessionPath(
  parentSessionPath: string
): SubagentBatch[] {
  hydrateFromDisk();
  return Array.from(store.batches.values()).filter(
    (batch) => batch.parentSessionPath === parentSessionPath
  );
}

export function updateBatchStatus(
  batchId: string,
  status: SubagentBatchStatus,
  endedAt?: number
): void {
  const batch = store.batches.get(batchId);
  if (!batch) return;
  batch.status = status;
  if (endedAt !== undefined) batch.endedAt = endedAt;
  persistBatch(batch);
}

export function updateBatch(
  batchId: string,
  patch: Partial<SubagentBatch>
): void {
  const batch = store.batches.get(batchId);
  if (!batch) return;
  store.batches.set(batchId, { ...batch, ...patch, id: batch.id });
  persistBatch(store.batches.get(batchId)!);
}

export function updateTask(
  batchId: string,
  taskId: string,
  patch: Partial<SubagentTaskRuntime>
): void {
  const batch = store.batches.get(batchId);
  if (!batch) return;
  const idx = batch.tasks.findIndex((task) => task.id === taskId);
  if (idx < 0) return;
  batch.tasks[idx] = { ...batch.tasks[idx], ...patch };
  persistBatch(batch);
}

export function listRunningBatches(parentAgentId: string): SubagentBatch[] {
  return listBatches(parentAgentId).filter(
    (batch) => batch.status === "pending" || batch.status === "running"
  );
}

export function getTaskStatus(
  batchId: string,
  taskId: string
): SubagentTaskStatus | undefined {
  return getBatch(batchId)?.tasks.find((task) => task.id === taskId)?.status;
}

export function clearBatchesForParent(parentAgentId: string): void {
  hydrateFromDisk();
  const ids = store.byParentAgentId.get(parentAgentId);
  if (!ids) return;
  for (const id of ids) {
    store.batches.delete(id);
    try {
      unlinkSync(batchFilePath(id));
    } catch {
      // ignore
    }
  }
  store.byParentAgentId.delete(parentAgentId);
}

export function __setSubagentStoreRootForTest(root: string | null): void {
  activeRoot = root;
  hydrated = false;
  store.batches.clear();
  store.byParentAgentId.clear();
}

export function __resetSubagentStoreForTest(): void {
  store.batches.clear();
  store.byParentAgentId.clear();
  hydrated = false;
}

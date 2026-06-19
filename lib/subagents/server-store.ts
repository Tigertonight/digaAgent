import "server-only";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
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

const g = globalThis as unknown as { __digaAgentSubagents?: SubagentStore };
if (!g.__digaAgentSubagents) {
  g.__digaAgentSubagents = {
    batches: new Map(),
    byParentAgentId: new Map(),
  };
}
const store = g.__digaAgentSubagents!;
let activeRoot: string | null = null;
let hydrated = false;

function getRoot(): string {
  return activeRoot ?? path.join(os.homedir(), ".diga-agent");
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
  // S4：detached 也是有效状态。丢了后台运行的 batch 在重启后会被跳过，
  // 导致恢复/审计入口丢。hydrate 后仅作为“历史 detached”，是否允许 resume 由上层决定。
  return (
    value === "pending" ||
    value === "running" ||
    value === "detached" ||
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

/**
 * T2.4: 同步原子写（UUID tmp + open(wx) + fsync + rename）+ 错误可观察。
 * 为什么仍同步：subagents store 被大量同步调用路径依赖。
 */
function persistBatch(batch: SubagentBatch): void {
  let tmp: string | null = null;
  let fd: number | null = null;
  try {
    mkdirSync(batchDir(), { recursive: true });
    const fp = batchFilePath(batch.id);
    tmp = `${fp}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
    fd = openSync(tmp, "wx");
    writeSync(fd, JSON.stringify(batch, null, 2), 0, "utf8");
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
      console.warn("[subagent-store] persist failed (no space)", { id: batch.id, code });
      throw err;
    }
    console.warn("[subagent-store] persist failed", {
      id: batch.id,
      code,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function hydrateFromDisk(): void {
  if (hydrated) return;
  hydrated = true;
  const dir = batchDir();
  if (!existsSync(dir)) return;
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const batch = sanitizeBatch(
        JSON.parse(readFileSync(path.join(dir, name), "utf8"))
      );
      if (!batch) continue;
      // C9-1: 重启后的 "running" 是虚假的——进程已丢，runtime controller 不存在。
      // 降级为 detached（保留可 resume 语义）、未终态 task 降为 aborted 并补 endedAt。
      // 不调 persistBatch（活跃请求会在后续 putBatch 重写）。
      if (batch.status === "running" || batch.status === "pending") {
        batch.status = "detached";
        if (!batch.endedAt) batch.endedAt = now;
      }
      for (const task of batch.tasks) {
        if (task.status === "running" || task.status === "pending") {
          task.status = "aborted";
          task.error =
            task.error ?? "Process restarted before this task finished.";
          task.endedAt = task.endedAt ?? now;
        }
      }
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

/**
 * M1：删除某父 session 下的所有 subagent batch（内存 + 索引 + 磁盘文件）。
 * 父 session 被删除时调用，避免遗留孤儿 batch——否则 context 路由仍会按
 * parentSessionPath 把它们返回，UI 上出现“父没了、子还在”的幽灵记录。
 * 返回删除的 batch 数。
 */
export function removeBatchesByParentSessionPath(
  parentSessionPath: string
): number {
  hydrateFromDisk();
  let removed = 0;
  for (const batch of Array.from(store.batches.values())) {
    if (batch.parentSessionPath !== parentSessionPath) continue;
    store.batches.delete(batch.id);
    const ids = store.byParentAgentId.get(batch.parentAgentId);
    if (ids) {
      ids.delete(batch.id);
      if (ids.size === 0) store.byParentAgentId.delete(batch.parentAgentId);
    }
    try {
      unlinkSync(batchFilePath(batch.id));
    } catch {
      // 文件不存在 / IO 错误忽略——内存已清，磁盘清理是 best-effort。
    }
    removed += 1;
  }
  return removed;
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

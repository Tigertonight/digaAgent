import "server-only";
import { createAtomicJsonStore } from "@/lib/shared/atomic-json-store";
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
let hydrated = false;

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
 * C9-1: 重启后的 "running" 是虚假的——进程已丢，runtime controller 不存在。
 * 降级为 detached（保留可 resume 语义）、未终态 task 降为 aborted 并补 endedAt。
 */
function hydrateBatch(batch: SubagentBatch, now: number): SubagentBatch {
  if (batch.status === "running" || batch.status === "pending") {
    batch.status = "detached";
    if (!batch.endedAt) batch.endedAt = now;
  }
  for (const task of batch.tasks) {
    if (task.status === "running" || task.status === "pending") {
      task.status = "aborted";
      task.error = task.error ?? "Process restarted before this task finished.";
      task.endedAt = task.endedAt ?? now;
    }
  }
  return batch;
}

const fileStore = createAtomicJsonStore<SubagentBatch>({
  segments: ["subagents", "batches"],
  idOf: (batch) => batch.id,
  sanitize: sanitizeBatch,
  onHydrate: hydrateBatch,
});

function indexBatch(batch: SubagentBatch): void {
  let ids = store.byParentAgentId.get(batch.parentAgentId);
  if (!ids) {
    ids = new Set();
    store.byParentAgentId.set(batch.parentAgentId, ids);
  }
  ids.add(batch.id);
}

function hydrateFromDisk(): void {
  if (hydrated) return;
  hydrated = true;
  for (const batch of fileStore.hydrateAll()) {
    // hydrate 期不重写磁盘（活跃请求会在后续 putBatch 重写）。
    store.batches.set(batch.id, batch);
    indexBatch(batch);
  }
}

export function putBatch(batch: SubagentBatch): void {
  hydrateFromDisk();
  store.batches.set(batch.id, batch);
  indexBatch(batch);
  fileStore.persist(batch);
}

/** flush 时用于取某 batch 最新内存快照（避免 debounce 落盘到过期对象）。 */
function resolveBatchForFlush(batchId: string): SubagentBatch | undefined {
  return store.batches.get(batchId);
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
    fileStore.remove(batch.id);
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
  // 状态变更（含终态）必须同步落盘，并 flush 掉该 batch 的待写 task 更新，
  // 避免崩溃窗口内丢失终态。
  fileStore.persist(batch);
  fileStore.flush(batchId);
}

export function updateBatch(
  batchId: string,
  patch: Partial<SubagentBatch>
): void {
  const batch = store.batches.get(batchId);
  if (!batch) return;
  store.batches.set(batchId, { ...batch, ...patch, id: batch.id });
  // updateBatch 常携带 verification/synthesis/审计等终态产物，同步落盘。
  fileStore.persist(store.batches.get(batchId)!);
  fileStore.flush(batchId);
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
  // task 进度更新是高频写（并行 worker 的 answerPreview 流式刷新等），
  // 用合并写缓解写放大。task 终态由其后紧跟的 updateBatchStatus 同步 flush。
  fileStore.persistDebounced(batch, resolveBatchForFlush);
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
    fileStore.remove(id);
  }
  store.byParentAgentId.delete(parentAgentId);
}

/**
 * 立即落盘所有 debounced 的待写 batch。
 * 进程退出钩子 / 测试在直接读盘断言前调用，确保合并写已 flush。
 */
export function flushSubagentStore(): void {
  fileStore.flush();
}

export function __setSubagentStoreRootForTest(root: string | null): void {
  fileStore.__setRootForTest(root);
  hydrated = false;
  store.batches.clear();
  store.byParentAgentId.clear();
}

export function __resetSubagentStoreForTest(): void {
  fileStore.flush();
  store.batches.clear();
  store.byParentAgentId.clear();
  hydrated = false;
}

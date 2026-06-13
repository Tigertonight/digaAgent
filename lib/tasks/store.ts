import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  LongTaskCadence,
  LongTaskCreateInput,
  LongTaskCheckpoint,
  LongTaskCheckpointKind,
  LongTaskDashboard,
  LongTaskDefinition,
  LongTaskRun,
  LongTaskRunStatus,
  LongTaskStatus,
  LongTaskUpdateInput,
  TaskFinding,
  TaskFindingSeverity,
  TaskFindingStatus,
  TaskPermissionPolicy,
} from "./types";

const TASK_STORE_SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

interface PersistedTaskStore {
  schemaVersion: 1;
  kind: "long-task-store";
  tasks: LongTaskDefinition[];
  runs: LongTaskRun[];
  findings: TaskFinding[];
  persistedAt: number;
}

interface TaskStoreState {
  loaded: boolean;
  tasks: Map<string, LongTaskDefinition>;
  runs: Map<string, LongTaskRun>;
  findings: Map<string, TaskFinding>;
  rootOverride?: string | null;
}

const g = globalThis as unknown as { __digaAgentLongTasks?: TaskStoreState };
if (!g.__digaAgentLongTasks) {
  g.__digaAgentLongTasks = {
    loaded: false,
    tasks: new Map(),
    runs: new Map(),
    findings: new Map(),
    rootOverride: null,
  };
}
const store = g.__digaAgentLongTasks;

const DEFAULT_PERMISSION_POLICY: TaskPermissionPolicy = {
  requireApprovalBeforeWrite: true,
  requireApprovalBeforeNetwork: true,
  maxDurationMinutes: 60,
};

function defaultRoot(): string {
  return path.join(os.homedir(), ".diga-agent");
}

function getRoot(): string {
  return store.rootOverride ?? defaultRoot();
}

function storeDir(): string {
  return path.join(getRoot(), "tasks");
}

function storeFile(): string {
  return path.join(storeDir(), "tasks.json");
}

function cloneTask(task: LongTaskDefinition): LongTaskDefinition {
  return {
    ...task,
    skillIds: task.skillIds.slice(),
    permissionPolicy: { ...task.permissionPolicy },
  };
}

function cloneRun(run: LongTaskRun): LongTaskRun {
  return {
    ...run,
    checkpoints: (run.checkpoints ?? []).map((checkpoint) => ({ ...checkpoint })),
    findingIds: run.findingIds.slice(),
  };
}

function cloneFinding(finding: TaskFinding): TaskFinding {
  return { ...finding };
}

function safeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function checkpoint(
  kind: LongTaskCheckpointKind,
  title: string,
  detail?: string,
  now = Date.now()
): LongTaskCheckpoint {
  return {
    id: safeId("checkpoint"),
    kind,
    title: cleanText(title, 160) || "任务状态更新",
    detail: detail ? cleanText(detail, 500) : undefined,
    createdAt: now,
  };
}

function normalizeRun(raw: LongTaskRun): LongTaskRun {
  return {
    ...raw,
    checkpoints: Array.isArray(raw.checkpoints)
      ? raw.checkpoints.map((item) => ({ ...item }))
      : [],
    findingIds: Array.isArray(raw.findingIds) ? raw.findingIds.slice() : [],
  };
}

function cleanText(raw: unknown, limit: number): string {
  return (typeof raw === "string" ? raw.trim() : "").slice(0, limit);
}

function isCadence(value: unknown): value is LongTaskCadence {
  return value === "manual" || value === "daily" || value === "weekly";
}

function isTaskStatus(value: unknown): value is LongTaskStatus {
  return (
    value === "idle" ||
    value === "scheduled" ||
    value === "running" ||
    value === "waiting_user" ||
    value === "completed" ||
    value === "failed" ||
    value === "paused" ||
    value === "archived"
  );
}

function normalizePolicy(raw?: Partial<TaskPermissionPolicy>): TaskPermissionPolicy {
  return {
    requireApprovalBeforeWrite:
      typeof raw?.requireApprovalBeforeWrite === "boolean"
        ? raw.requireApprovalBeforeWrite
        : DEFAULT_PERMISSION_POLICY.requireApprovalBeforeWrite,
    requireApprovalBeforeNetwork:
      typeof raw?.requireApprovalBeforeNetwork === "boolean"
        ? raw.requireApprovalBeforeNetwork
        : DEFAULT_PERMISSION_POLICY.requireApprovalBeforeNetwork,
    maxDurationMinutes:
      typeof raw?.maxDurationMinutes === "number" &&
      Number.isFinite(raw.maxDurationMinutes)
        ? Math.max(5, Math.min(24 * 60, Math.floor(raw.maxDurationMinutes)))
        : DEFAULT_PERMISSION_POLICY.maxDurationMinutes,
  };
}

function nextRunFrom(cadence: LongTaskCadence, from: number): number | undefined {
  if (cadence === "daily") return from + DAY_MS;
  if (cadence === "weekly") return from + WEEK_MS;
  return undefined;
}

function normalizeTask(
  raw: LongTaskCreateInput & Partial<Omit<LongTaskDefinition, "permissionPolicy">>,
  now = Date.now(),
  existing?: LongTaskDefinition
): LongTaskDefinition {
  const title = cleanText(raw.title, 160);
  const prompt = cleanText(raw.prompt, 20_000);
  const projectPath = cleanText(raw.projectPath, 2000);
  const provider = cleanText(raw.provider, 120);
  const modelId = cleanText(raw.modelId, 160);
  if (!title) throw new Error("任务名称不能为空");
  if (!prompt) throw new Error("任务目标不能为空");
  if (!projectPath) throw new Error("项目路径不能为空");
  if (!provider || !modelId) throw new Error("模型配置不能为空");

  const cadence = isCadence(raw.cadence) ? raw.cadence : "manual";
  const enabled = raw.enabled !== false;
  const status =
    existing?.status === "running" || existing?.status === "waiting_user"
      ? existing.status
      : enabled && cadence !== "manual"
        ? "scheduled"
        : "idle";
  const createdAt = existing?.createdAt ?? now;
  const lastRunAt = existing?.lastRunAt;
  return {
    id: existing?.id ?? safeId("task"),
    title,
    prompt,
    projectPath,
    provider,
    modelId,
    cadence,
    enabled,
    skillIds: Array.isArray(raw.skillIds)
      ? raw.skillIds.map((item) => cleanText(item, 120)).filter(Boolean).slice(0, 20)
      : existing?.skillIds ?? [],
    permissionPolicy: normalizePolicy(
      raw.permissionPolicy ?? existing?.permissionPolicy
    ),
    status,
    createdAt,
    updatedAt: now,
    lastRunAt,
    nextRunAt:
      enabled && cadence !== "manual"
        ? existing?.nextRunAt ?? nextRunFrom(cadence, lastRunAt ?? now)
        : undefined,
    lastRunId: existing?.lastRunId,
    lastSummary: existing?.lastSummary,
    failureReason: existing?.failureReason,
  };
}

function nextCheckpoints(
  current: LongTaskRun,
  patch: Partial<Omit<LongTaskRun, "id" | "taskId" | "findingIds">> & {
    status?: LongTaskRunStatus;
  },
  now: number
): LongTaskCheckpoint[] {
  const checkpoints = (current.checkpoints ?? []).map((item) => ({ ...item }));
  if (!patch.status || patch.status === current.status) return checkpoints;
  if (patch.status === "running") {
    const wasWaiting = current.status === "waiting_user";
    checkpoints.push(
      checkpoint(
        wasWaiting ? "resumed" : "started",
        wasWaiting ? "已收到决策，继续执行" : "任务开始执行",
        patch.summary,
        now
      )
    );
  } else if (patch.status === "waiting_user") {
    checkpoints.push(
      checkpoint(
        "waiting_user",
        "等待你决策",
        patch.waitingReason ?? patch.summary,
        now
      )
    );
  } else if (
    patch.status === "completed_empty" ||
    patch.status === "completed_with_findings"
  ) {
    checkpoints.push(
      checkpoint(
        "completed",
        patch.status === "completed_with_findings"
          ? "任务完成，发现需要处理的事项"
          : "任务完成，没有新事项",
        patch.summary,
        now
      )
    );
  } else if (patch.status === "failed" || patch.status === "aborted") {
    checkpoints.push(
      checkpoint(
        "failed",
        patch.status === "aborted" ? "任务已中止" : "任务执行失败",
        patch.error ?? patch.summary,
        now
      )
    );
  }
  return checkpoints.slice(-40);
}

function parsePersisted(value: unknown): PersistedTaskStore | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Partial<PersistedTaskStore>;
  if (
    rec.kind !== "long-task-store" ||
    rec.schemaVersion !== TASK_STORE_SCHEMA_VERSION ||
    !Array.isArray(rec.tasks) ||
    !Array.isArray(rec.runs) ||
    !Array.isArray(rec.findings)
  ) {
    return null;
  }
  return rec as PersistedTaskStore;
}

function load(): void {
  if (store.loaded) return;
  store.loaded = true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[tasks-store] read failed:", err);
    }
    return;
  }
  const persisted = parsePersisted(parsed);
  if (!persisted) return;
  store.tasks.clear();
  store.runs.clear();
  store.findings.clear();
  for (const task of persisted.tasks) store.tasks.set(task.id, cloneTask(task));
  for (const run of persisted.runs) {
    const normalized = normalizeRun(run);
    store.runs.set(normalized.id, normalized);
  }
  for (const finding of persisted.findings) {
    store.findings.set(finding.id, cloneFinding(finding));
  }
}

function persist(): void {
  fs.mkdirSync(storeDir(), { recursive: true });
  const file = storeFile();
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  const payload: PersistedTaskStore = {
    schemaVersion: TASK_STORE_SCHEMA_VERSION,
    kind: "long-task-store",
    tasks: Array.from(store.tasks.values()).map(cloneTask),
    runs: Array.from(store.runs.values()).map(cloneRun),
    findings: Array.from(store.findings.values()).map(cloneFinding),
    persistedAt: Date.now(),
  };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function listLongTasksDashboard(now = Date.now()): LongTaskDashboard {
  load();
  const tasks = Array.from(store.tasks.values())
    .map(cloneTask)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const runs = Array.from(store.runs.values())
    .map(cloneRun)
    .sort((a, b) => b.startedAt - a.startedAt);
  const findings = Array.from(store.findings.values())
    .map(cloneFinding)
    .sort((a, b) => b.createdAt - a.createdAt);
  return {
    tasks,
    runs,
    findings,
    dueTasks: tasks.filter(
      (task) =>
        task.enabled &&
        task.status !== "paused" &&
        task.status !== "archived" &&
        task.cadence !== "manual" &&
        typeof task.nextRunAt === "number" &&
        task.nextRunAt <= now
    ),
    inboxCount: findings.filter((finding) => finding.status === "unread").length,
  };
}

export function getLongTask(id: string): LongTaskDefinition | undefined {
  load();
  const task = store.tasks.get(id);
  return task ? cloneTask(task) : undefined;
}

export function createLongTask(input: LongTaskCreateInput): LongTaskDefinition {
  load();
  const task = normalizeTask(input);
  store.tasks.set(task.id, task);
  persist();
  return cloneTask(task);
}

export function updateLongTask(
  id: string,
  input: LongTaskUpdateInput
): LongTaskDefinition {
  load();
  const existing = store.tasks.get(id);
  if (!existing) throw new Error("任务不存在");
  const next = normalizeTask(
    {
      ...existing,
      ...input,
      permissionPolicy: {
        ...existing.permissionPolicy,
        ...input.permissionPolicy,
      },
    },
    Date.now(),
    existing
  );
  if (input.status && isTaskStatus(input.status)) next.status = input.status;
  store.tasks.set(id, next);
  persist();
  return cloneTask(next);
}

export function deleteLongTask(id: string): boolean {
  load();
  const existed = store.tasks.delete(id);
  for (const [runId, run] of store.runs.entries()) {
    if (run.taskId === id) store.runs.delete(runId);
  }
  for (const [findingId, finding] of store.findings.entries()) {
    if (finding.taskId === id) store.findings.delete(findingId);
  }
  if (existed) persist();
  return existed;
}

export function createTaskRun(taskId: string): LongTaskRun {
  load();
  const task = store.tasks.get(taskId);
  if (!task) throw new Error("任务不存在");
  const now = Date.now();
  const run: LongTaskRun = {
    id: safeId("run"),
    taskId,
    status: "queued",
    startedAt: now,
    updatedAt: now,
    checkpoints: [
      checkpoint(
        "queued",
        "任务已排队",
        "Diga 已接收长期任务运行请求。",
        now
      ),
    ],
    findingIds: [],
  };
  store.runs.set(run.id, run);
  store.tasks.set(taskId, {
    ...task,
    status: "running",
    lastRunAt: now,
    lastRunId: run.id,
    updatedAt: now,
    failureReason: undefined,
  });
  persist();
  return cloneRun(run);
}

export function updateTaskRun(
  runId: string,
  patch: Partial<Omit<LongTaskRun, "id" | "taskId" | "findingIds">> & {
    status?: LongTaskRunStatus;
    findingIds?: string[];
  }
): LongTaskRun {
  load();
  const current = store.runs.get(runId);
  if (!current) throw new Error("运行记录不存在");
  const now = Date.now();
  const next: LongTaskRun = {
    ...current,
    ...patch,
    checkpoints: nextCheckpoints(current, patch, now),
    findingIds: patch.findingIds ?? current.findingIds,
    updatedAt: now,
  };
  store.runs.set(runId, next);
  const task = store.tasks.get(current.taskId);
  if (task) {
    const terminal =
      next.status === "completed_empty" ||
      next.status === "completed_with_findings" ||
      next.status === "failed" ||
      next.status === "aborted";
    const nextTaskStatus: LongTaskStatus =
      next.status === "waiting_user"
        ? "waiting_user"
        : next.status === "running" || next.status === "queued"
          ? "running"
          : next.status === "failed" || next.status === "aborted"
            ? "failed"
            : terminal
              ? "completed"
              : task.status;
    store.tasks.set(task.id, {
      ...task,
      status: nextTaskStatus,
      lastRunAt: next.startedAt,
      lastRunId: next.id,
      lastSummary: next.summary ?? task.lastSummary,
      failureReason: next.error,
      nextRunAt:
        terminal && task.enabled
          ? nextRunFrom(task.cadence, next.endedAt ?? now)
          : task.nextRunAt,
      updatedAt: now,
    });
  }
  persist();
  return cloneRun(next);
}

export function createTaskFinding(input: {
  taskId: string;
  runId: string;
  title: string;
  body: string;
  severity?: TaskFindingSeverity;
  status?: TaskFindingStatus;
}): TaskFinding {
  load();
  const now = Date.now();
  const finding: TaskFinding = {
    id: safeId("finding"),
    taskId: input.taskId,
    runId: input.runId,
    title: cleanText(input.title, 200) || "任务运行报告",
    body: cleanText(input.body, 20_000) || "本次运行已结束，但没有生成详细报告。",
    severity: input.severity ?? "info",
    status: input.status ?? "unread",
    createdAt: now,
    updatedAt: now,
  };
  store.findings.set(finding.id, finding);
  const run = store.runs.get(input.runId);
  if (run && !run.findingIds.includes(finding.id)) {
    store.runs.set(run.id, {
      ...run,
      findingIds: [...run.findingIds, finding.id],
      updatedAt: now,
    });
  }
  persist();
  return cloneFinding(finding);
}

export function updateTaskFinding(
  id: string,
  patch: { status?: TaskFindingStatus }
): TaskFinding {
  load();
  const finding = store.findings.get(id);
  if (!finding) throw new Error("事项不存在");
  const next: TaskFinding = {
    ...finding,
    status: patch.status ?? finding.status,
    updatedAt: Date.now(),
  };
  store.findings.set(id, next);
  persist();
  return cloneFinding(next);
}

export function __setLongTaskStoreRootForTest(root: string | null): void {
  store.rootOverride = root;
  store.loaded = false;
  store.tasks.clear();
  store.runs.clear();
  store.findings.clear();
}

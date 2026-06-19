import "server-only";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type {
  WorkflowArtifact,
  WorkflowCheckpoint,
  WorkflowResumeEntrySummary,
  WorkflowResumeSnapshot,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowScriptLog,
  WorkflowTraceEvent,
} from "./types";

const WORKFLOW_STORE_SCHEMA_VERSION = 2;
const DEFAULT_MAX_RUNS_PER_PARENT = 200;
const DEFAULT_MAX_RUN_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_ARTIFACT_COMPRESSION_THRESHOLD_BYTES = 16 * 1024;

interface WorkflowArtifactIndexEntry {
  name: string;
  createdAt: number;
  jsonBytes: number;
  compressed: boolean;
}

interface CompressedWorkflowArtifactValue {
  __digaAgentWorkflowCompressedArtifact: true;
  encoding: "gzip+base64+json";
  data: string;
  originalBytes: number;
}

interface PersistedWorkflowRunV1 {
  schemaVersion: 1;
  kind: "workflow-run";
  run: WorkflowRun;
  persistedAt: number;
}

interface PersistedWorkflowRunV2 {
  schemaVersion: 2;
  kind: "workflow-run";
  run: WorkflowRun;
  persistedAt: number;
  artifactIndex: WorkflowArtifactIndexEntry[];
  migrationHistory: string[];
}

interface WorkflowStore {
  runs: Map<string, WorkflowRun>;
  runningByParent: Map<string, Set<string>>;
  controllers: Map<string, AbortController>;
  loadedFromDisk: boolean;
  rootOverride?: string | null;
}

const g = globalThis as unknown as { __digaAgentWorkflows?: WorkflowStore };
if (!g.__digaAgentWorkflows) {
  g.__digaAgentWorkflows = {
    runs: new Map(),
    runningByParent: new Map(),
    controllers: new Map(),
    loadedFromDisk: false,
    rootOverride: null,
  };
}

const store = g.__digaAgentWorkflows;
if (store.loadedFromDisk === undefined) store.loadedFromDisk = false;
if (!("rootOverride" in store)) store.rootOverride = null;

function defaultRoot(): string {
  return path.join(os.homedir(), ".diga-agent");
}

function getRoot(): string {
  return store.rootOverride ?? defaultRoot();
}

function runsDir(): string {
  return path.join(getRoot(), "workflows", "runs");
}

function configuredMaxRunsPerParent(): number {
  const raw = Number(process.env.DIGA_AGENT_WORKFLOW_MAX_RUNS_PER_PARENT);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_MAX_RUNS_PER_PARENT;
}

function configuredMaxRunAgeMs(): number {
  const days = Number(process.env.DIGA_AGENT_WORKFLOW_MAX_RUN_AGE_DAYS);
  return Number.isFinite(days) && days >= 0
    ? Math.floor(days * 24 * 60 * 60 * 1000)
    : DEFAULT_MAX_RUN_AGE_MS;
}

function configuredArtifactCompressionThresholdBytes(): number {
  const raw = Number(process.env.DIGA_AGENT_WORKFLOW_ARTIFACT_COMPRESSION_BYTES);
  return Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_ARTIFACT_COMPRESSION_THRESHOLD_BYTES;
}

function runFilePath(id: string): string {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid workflow id: ${id}`);
  }
  return path.join(runsDir(), `${id}.json`);
}

/**
 * T2.5: 同步原子写（UUID tmp + open(wx) + fsync + rename）。
 * 原实现已有 console.error，但未區分 ENOSPC 与临时错。
 */
function persistRun(run: WorkflowRun): void {
  let tmp: string | null = null;
  let fd: number | null = null;
  try {
    fs.mkdirSync(runsDir(), { recursive: true });
    const file = runFilePath(run.id);
    tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
    const encoded = encodeRunForPersistence(run);
    const persisted: PersistedWorkflowRunV2 = {
      schemaVersion: WORKFLOW_STORE_SCHEMA_VERSION,
      kind: "workflow-run",
      run: encoded.run,
      persistedAt: Date.now(),
      artifactIndex: encoded.artifactIndex,
      migrationHistory: ["workflow-run:v2"],
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
    if (code === "ENOSPC") {
      console.warn("[workflow-store] persist failed (no space)", {
        id: run.id,
        code,
      });
      throw err;
    }
    console.warn("[workflow-store] persist failed", {
      id: run.id,
      code,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function isWorkflowRun(value: unknown): value is WorkflowRun {
  if (!value || typeof value !== "object") return false;
  const rec = value as Partial<WorkflowRun>;
  return (
    typeof rec.id === "string" &&
    typeof rec.parentAgentId === "string" &&
    typeof rec.objective === "string" &&
    typeof rec.rationale === "string" &&
    typeof rec.script === "string" &&
    Array.isArray(rec.artifacts) &&
    Array.isArray(rec.checkpoints) &&
    Array.isArray(rec.logs) &&
    typeof rec.createdAt === "number"
  );
}

function parsePersistedWorkflowRun(value: unknown): {
  run: WorkflowRun;
  needsMigration: boolean;
} | null {
  if (isWorkflowRun(value)) {
    return { run: value, needsMigration: true };
  }
  if (!value || typeof value !== "object") return null;
  const rec = value as Partial<PersistedWorkflowRunV1 | PersistedWorkflowRunV2>;
  if (rec.kind !== "workflow-run" || !isWorkflowRun(rec.run)) return null;
  if (rec.schemaVersion === 2) {
    return {
      run: decodeRunFromPersistence(rec.run),
      needsMigration: false,
    };
  }
  if (rec.schemaVersion === 1) {
    return {
      run: rec.run,
      needsMigration: true,
    };
  }
  return null;
}

function loadPersistedRuns(): void {
  if (store.loadedFromDisk) return;
  store.loadedFromDisk = true;
  let files: string[];
  try {
    files = fs.readdirSync(runsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.error("[workflow-store] list failed:", err);
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(runsDir(), file), "utf8")
      );
      const persisted = parsePersistedWorkflowRun(parsed);
      if (!persisted) continue;
      const run: WorkflowRun =
        persisted.run.status === "running"
          ? {
              ...persisted.run,
              status: "aborted",
              endedAt: Date.now(),
              error:
                persisted.run.error ??
                "Workflow was interrupted before this process loaded it.",
            }
          : persisted.run;
      store.runs.set(run.id, cloneRun(run));
      if (persisted.needsMigration || run !== persisted.run) persistRun(run);
    } catch (err) {
      console.error("[workflow-store] read failed:", file, err);
    }
  }
  pruneWorkflowRuns();
}

function cloneRun(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    artifacts: run.artifacts.slice(),
    checkpoints: run.checkpoints.slice(),
    logs: run.logs.slice(),
    traceEvents: (run.traceEvents ?? []).slice(),
  };
}

export function putWorkflowRun(run: WorkflowRun, controller?: AbortController): void {
  loadPersistedRuns();
  store.runs.set(run.id, cloneRun(run));
  persistRun(run);
  if (run.status === "running") {
    let ids = store.runningByParent.get(run.parentAgentId);
    if (!ids) {
      ids = new Set();
      store.runningByParent.set(run.parentAgentId, ids);
    }
    ids.add(run.id);
    if (controller) store.controllers.set(run.id, controller);
  }
}

export function getWorkflowRun(id: string): WorkflowRun | undefined {
  loadPersistedRuns();
  const run = store.runs.get(id);
  return run ? cloneRun(run) : undefined;
}

export function listWorkflowRuns(parentAgentId?: string): WorkflowRun[] {
  loadPersistedRuns();
  const runs = Array.from(store.runs.values());
  return runs
    .filter((run) => !parentAgentId || run.parentAgentId === parentAgentId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(cloneRun);
}

export function listRunningWorkflowRuns(parentAgentId: string): WorkflowRun[] {
  loadPersistedRuns();
  const ids = store.runningByParent.get(parentAgentId);
  if (!ids) return [];
  return Array.from(ids)
    .map((id) => store.runs.get(id))
    .filter((run): run is WorkflowRun => Boolean(run))
    .map(cloneRun);
}

export function appendWorkflowLog(workflowId: string, log: WorkflowScriptLog): void {
  loadPersistedRuns();
  const run = store.runs.get(workflowId);
  if (!run) return;
  run.logs = [...run.logs, log];
  persistRun(run);
}

export function appendWorkflowCheckpoint(
  workflowId: string,
  checkpoint: WorkflowCheckpoint
): void {
  loadPersistedRuns();
  const run = store.runs.get(workflowId);
  if (!run) return;
  run.checkpoints = [...run.checkpoints, checkpoint];
  persistRun(run);
}

export function putWorkflowArtifact(
  workflowId: string,
  artifact: WorkflowArtifact
): void {
  loadPersistedRuns();
  const run = store.runs.get(workflowId);
  if (!run) return;
  run.artifacts = [
    ...run.artifacts.filter((item) => item.name !== artifact.name),
    artifact,
  ];
  persistRun(run);
}

export function appendWorkflowTraceEvent(
  workflowId: string,
  trace: WorkflowTraceEvent
): void {
  loadPersistedRuns();
  const run = store.runs.get(workflowId);
  if (!run) return;
  run.traceEvents = [...(run.traceEvents ?? []), trace];
  persistRun(run);
}

export function finishWorkflowRun(
  workflowId: string,
  patch: {
    status: Exclude<WorkflowRunStatus, "pending" | "running">;
    endedAt: number;
    artifacts?: WorkflowArtifact[];
    checkpoints?: WorkflowCheckpoint[];
    logs?: WorkflowScriptLog[];
    traceEvents?: WorkflowTraceEvent[];
    returnValue?: unknown;
    error?: string;
    warnings?: string[];
  }
): void {
  loadPersistedRuns();
  const run = store.runs.get(workflowId);
  if (!run) return;
  const next: WorkflowRun = {
    ...run,
    status: patch.status,
    endedAt: patch.endedAt,
    artifacts: patch.artifacts ?? run.artifacts,
    checkpoints: patch.checkpoints ?? run.checkpoints,
    logs: patch.logs ?? run.logs,
    traceEvents: patch.traceEvents ?? run.traceEvents ?? [],
    returnValue: patch.returnValue,
    error: patch.error,
    warnings: patch.warnings,
  };
  store.runs.set(workflowId, next);
  persistRun(next);
  store.controllers.delete(workflowId);
  const ids = store.runningByParent.get(run.parentAgentId);
  if (ids) {
    ids.delete(workflowId);
    if (ids.size === 0) store.runningByParent.delete(run.parentAgentId);
  }
  pruneWorkflowRuns();
}

export async function abortRunningWorkflows(parentAgentId: string): Promise<void> {
  loadPersistedRuns();
  const ids = store.runningByParent.get(parentAgentId);
  if (!ids) return;
  for (const id of Array.from(ids)) {
    store.controllers.get(id)?.abort();
  }
}

export function pruneWorkflowRuns(
  opts: {
    maxRunsPerParent?: number;
    maxAgeMs?: number;
    now?: number;
  } = {}
): { deleted: number; kept: number } {
  loadPersistedRuns();
  const maxRunsPerParent = Math.max(
    1,
    Math.floor(opts.maxRunsPerParent ?? configuredMaxRunsPerParent())
  );
  const maxAgeMs = Math.max(0, Math.floor(opts.maxAgeMs ?? configuredMaxRunAgeMs()));
  const nowMs = opts.now ?? Date.now();
  const byParent = new Map<string, WorkflowRun[]>();
  for (const run of store.runs.values()) {
    const runs = byParent.get(run.parentAgentId) ?? [];
    runs.push(run);
    byParent.set(run.parentAgentId, runs);
  }

  const deleteIds = new Set<string>();
  for (const runs of byParent.values()) {
    const completed = runs
      .filter((run) => run.status !== "running")
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const run of completed) {
      if (maxAgeMs > 0 && nowMs - run.createdAt > maxAgeMs) {
        deleteIds.add(run.id);
      }
    }
    completed.slice(maxRunsPerParent).forEach((run) => deleteIds.add(run.id));
  }

  for (const id of deleteIds) {
    const run = store.runs.get(id);
    if (!run || run.status === "running") continue;
    store.runs.delete(id);
    try {
      fs.rmSync(runFilePath(id), { force: true });
    } catch (err) {
      console.error("[workflow-store] prune failed:", id, err);
    }
  }
  return {
    deleted: deleteIds.size,
    kept: store.runs.size,
  };
}

function encodeRunForPersistence(run: WorkflowRun): {
  run: WorkflowRun;
  artifactIndex: WorkflowArtifactIndexEntry[];
} {
  const threshold = configuredArtifactCompressionThresholdBytes();
  const artifactIndex: WorkflowArtifactIndexEntry[] = [];
  const artifacts = run.artifacts.map((artifact) => {
    const json = stringifyArtifactValue(artifact.value);
    const jsonBytes = Buffer.byteLength(json, "utf8");
    const compressed = threshold >= 0 && jsonBytes >= threshold;
    artifactIndex.push({
      name: artifact.name,
      createdAt: artifact.createdAt,
      jsonBytes,
      compressed,
    });
    if (!compressed) return artifact;
    const value: CompressedWorkflowArtifactValue = {
      __digaAgentWorkflowCompressedArtifact: true,
      encoding: "gzip+base64+json",
      data: gzipSync(Buffer.from(json, "utf8")).toString("base64"),
      originalBytes: jsonBytes,
    };
    return { ...artifact, value };
  });
  return {
    run: { ...run, artifacts },
    artifactIndex,
  };
}

function decodeRunFromPersistence(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    traceEvents: run.traceEvents ?? [],
    artifacts: run.artifacts.map((artifact) => {
      const value = decodeArtifactValue(artifact.value);
      return value === artifact.value ? artifact : { ...artifact, value };
    }),
  };
}

function stringifyArtifactValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify(String(value)) ?? "null";
  }
}

function decodeArtifactValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const rec = value as Partial<CompressedWorkflowArtifactValue>;
  if (
    rec.__digaAgentWorkflowCompressedArtifact !== true ||
    rec.encoding !== "gzip+base64+json" ||
    typeof rec.data !== "string"
  ) {
    return value;
  }
  try {
    const json = gunzipSync(Buffer.from(rec.data, "base64")).toString("utf8");
    return JSON.parse(json);
  } catch {
    return value;
  }
}

export function workflowResumeSnapshot(
  run: WorkflowRun
): WorkflowResumeSnapshot {
  const lastCheckpoint = run.checkpoints[run.checkpoints.length - 1];
  return {
    workflowId: run.id,
    objective: run.objective,
    status: run.status,
    checkpointNames: run.checkpoints.map((checkpoint) => checkpoint.name),
    artifactNames: run.artifacts.map((artifact) => artifact.name),
    checkpointSummaries: run.checkpoints
      .slice(-8)
      .map((checkpoint) => resumeEntrySummary(checkpoint)),
    artifactSummaries: run.artifacts
      .slice(-8)
      .map((artifact) => resumeEntrySummary(artifact)),
    lastCheckpoint,
    canResume: run.checkpoints.length > 0 && run.status !== "running",
    reason:
      run.checkpoints.length > 0
        ? undefined
        : "No checkpoints were recorded for this workflow.",
  };
}

function resumeEntrySummary(
  entry: WorkflowArtifact | WorkflowCheckpoint
): WorkflowResumeEntrySummary {
  return {
    name: entry.name,
    createdAt: entry.createdAt,
    preview: previewWorkflowValue(entry.value),
  };
}

function previewWorkflowValue(value: unknown, maxLength = 360): string {
  let text: string;
  try {
    text =
      typeof value === "string"
        ? value
        : JSON.stringify(value, (_key, item) => {
            if (typeof item === "string" && item.length > 240) {
              return `${item.slice(0, 240)}…`;
            }
            return item;
          });
  } catch {
    text = String(value);
  }
  if (!text) return "";
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

export function __setWorkflowStoreRootForTest(root: string | null): void {
  store.rootOverride = root;
  store.loadedFromDisk = false;
  store.runs.clear();
  store.runningByParent.clear();
  store.controllers.clear();
}

export function __clearWorkflowMemoryForTest(): void {
  store.runs.clear();
  store.runningByParent.clear();
  store.controllers.clear();
  store.loadedFromDisk = false;
}

export function __resetWorkflowStoreForTest(): void {
  store.runs.clear();
  store.runningByParent.clear();
  store.controllers.clear();
  store.loadedFromDisk = false;
  if (store.rootOverride) {
    fs.rmSync(path.join(store.rootOverride, "workflows"), {
      recursive: true,
      force: true,
    });
  }
}

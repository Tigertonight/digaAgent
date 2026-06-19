import "server-only";

import { promises as fs } from "node:fs";
import { atomicWriteJson } from "@/lib/storage/atomic";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentProgress,
  ProgressArtifact,
  ProgressGroup,
  ProgressStep,
} from "./types";

function defaultRoot(): string {
  return path.join(os.homedir(), ".diga-agent");
}

let activeRoot: string | null = null;

export function __setProgressRuntimeRootForTests(root: string | null): void {
  activeRoot = root;
}

function getRoot(): string {
  return activeRoot ?? defaultRoot();
}

function assertSafeSessionId(sessionId: string): void {
  if (
    !sessionId ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("..")
  ) {
    throw new Error(`invalid sessionId: ${sessionId}`);
  }
}

function progressFilePath(sessionId: string): string {
  assertSafeSessionId(sessionId);
  return path.join(getRoot(), "runtime", sessionId, "progress.json");
}

async function ensureRuntimeDir(sessionId: string): Promise<void> {
  assertSafeSessionId(sessionId);
  await fs.mkdir(path.join(getRoot(), "runtime", sessionId), { recursive: true });
}

function isStepStatus(value: unknown): value is ProgressStep["status"] {
  return (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "blocked" ||
    value === "failed"
  );
}

function sanitizeStep(raw: unknown): ProgressStep | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.id !== "string" || typeof src.title !== "string") return null;
  if (!isStepStatus(src.status)) return null;
  return {
    id: src.id.slice(0, 80),
    title: src.title.slice(0, 160),
    status: src.status,
    ...(typeof src.summary === "string" ? { summary: src.summary.slice(0, 500) } : {}),
    ...(Array.isArray(src.evidenceIds)
      ? { evidenceIds: src.evidenceIds.filter((id): id is string => typeof id === "string").slice(0, 10) }
      : {}),
    ...(typeof src.startedAt === "number" ? { startedAt: src.startedAt } : {}),
    ...(typeof src.completedAt === "number" ? { completedAt: src.completedAt } : {}),
  };
}

function sanitizeArtifact(raw: unknown): ProgressArtifact | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const kind = src.kind;
  if (typeof src.id !== "string" || typeof src.title !== "string") return null;
  if (
    kind !== "file" &&
    kind !== "url" &&
    kind !== "screenshot" &&
    kind !== "test" &&
    kind !== "diff" &&
    kind !== "log" &&
    kind !== "browser" &&
    kind !== "other"
  ) {
    return null;
  }
  return {
    id: src.id.slice(0, 80),
    kind,
    title: src.title.slice(0, 160),
    ...(typeof src.href === "string" ? { href: src.href.slice(0, 1000) } : {}),
    ...(typeof src.summary === "string" ? { summary: src.summary.slice(0, 500) } : {}),
    createdAt: typeof src.createdAt === "number" ? src.createdAt : Date.now(),
  };
}

function sanitizeGroup(raw: unknown): ProgressGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.id !== "string" || typeof src.index !== "number") return null;
  const steps = Array.isArray(src.steps)
    ? src.steps.map(sanitizeStep).filter((s): s is ProgressStep => Boolean(s))
    : [];
  return {
    id: src.id.slice(0, 80),
    index: src.index,
    steps,
    startedAt: typeof src.startedAt === "number" ? src.startedAt : Date.now(),
    ...(typeof src.endedAt === "number" ? { endedAt: src.endedAt } : {}),
  };
}

function sanitizeProgress(raw: unknown): AgentProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const groups = Array.isArray(src.groups)
    ? src.groups.map(sanitizeGroup).filter((g): g is ProgressGroup => Boolean(g))
    : [];
  const fallbackSteps = Array.isArray(src.steps)
    ? src.steps.map(sanitizeStep).filter((s): s is ProgressStep => Boolean(s))
    : [];
  const steps = groups.at(-1)?.steps ?? fallbackSteps;
  const artifacts = Array.isArray(src.artifacts)
    ? src.artifacts.map(sanitizeArtifact).filter((a): a is ProgressArtifact => Boolean(a))
    : [];
  return {
    steps,
    groups,
    artifacts,
    updatedAt: typeof src.updatedAt === "number" ? src.updatedAt : Date.now(),
  };
}

export async function readPersistedProgress(sessionId: string): Promise<AgentProgress | null> {
  let text: string;
  try {
    text = await fs.readFile(progressFilePath(sessionId), "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    // T1.4: 非 ENOENT IO 错误不能静默吞吃，上报一条 warn 供运维跟踪。
    console.warn("[progress-store] read failed", {
      sessionId,
      code: err.code,
      err: err.message,
    });
    return null;
  }
  try {
    return sanitizeProgress(JSON.parse(text));
  } catch (e) {
    console.warn("[progress-store] parse failed (corrupt file)", {
      sessionId,
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export async function writePersistedProgress(
  sessionId: string,
  progress: AgentProgress
): Promise<void> {
  const sanitized = sanitizeProgress(progress);
  if (!sanitized) throw new Error("invalid progress payload");
  await ensureRuntimeDir(sessionId);
  const fp = progressFilePath(sessionId);
  // T2.2: 复用统一原子写 helper（UUID tmp + open(wx) + fsync + rename + fsyncDir + per-key 串行）。
  await atomicWriteJson(fp, sanitized, { scope: "progress" });
}

export async function deletePersistedProgress(sessionId: string): Promise<void> {
  try {
    await fs.unlink(progressFilePath(sessionId));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}

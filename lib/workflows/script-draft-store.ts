import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  WorkflowScriptDraft,
  WorkflowScriptDraftSummary,
} from "./types";

const MAX_DRAFT_SCRIPT_CHARS = 200_000;

const g = globalThis as unknown as {
  __digaAgentWorkflowDraftRootOverride?: string | null;
};

function defaultRoot(): string {
  return path.join(os.homedir(), ".diga-agent");
}

function getRoot(): string {
  return g.__digaAgentWorkflowDraftRootOverride ?? defaultRoot();
}

function sanitizeSegment(raw: string, fallback: string): string {
  const value = raw
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 100);
  if (!value || value.includes("..")) return fallback;
  return value;
}

function draftsDir(parentAgentId: string): string {
  return path.join(
    getRoot(),
    "workflows",
    "drafts",
    sanitizeSegment(parentAgentId, "unknown"),
  );
}

function draftPath(parentAgentId: string, draftId: string): string {
  return path.join(draftsDir(parentAgentId), `${sanitizeSegment(draftId, "draft")}.json`);
}

function now(): number {
  return Date.now();
}

function readDraftFile(file: string): WorkflowScriptDraft | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WorkflowScriptDraft>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.parentAgentId !== "string" ||
      typeof parsed.script !== "string" ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    return {
      id: parsed.id,
      parentAgentId: parsed.parentAgentId,
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      script: parsed.script,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function writeDraft(draft: WorkflowScriptDraft): WorkflowScriptDraft {
  fs.mkdirSync(draftsDir(draft.parentAgentId), { recursive: true });
  const file = draftPath(draft.parentAgentId, draft.id);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(draft, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return draft;
}

export function getWorkflowScriptDraft(
  parentAgentId: string,
  draftId: string,
): WorkflowScriptDraft | null {
  return readDraftFile(draftPath(parentAgentId, draftId));
}

export function listWorkflowScriptDrafts(
  parentAgentId: string,
): WorkflowScriptDraftSummary[] {
  let files: string[];
  try {
    files = fs.readdirSync(draftsDir(parentAgentId));
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => readDraftFile(path.join(draftsDir(parentAgentId), file)))
    .filter((draft): draft is WorkflowScriptDraft => Boolean(draft))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((draft) => ({
      id: draft.id,
      parentAgentId: draft.parentAgentId,
      title: draft.title,
      chars: draft.script.length,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    }));
}

export function putWorkflowScriptDraft(input: {
  parentAgentId: string;
  id?: string;
  title?: string;
  script?: string;
  append?: string;
}): WorkflowScriptDraft {
  const parentAgentId = sanitizeSegment(input.parentAgentId, "unknown");
  const id = sanitizeSegment(input.id ?? `draft-${now()}`, `draft-${now()}`);
  const existing = getWorkflowScriptDraft(parentAgentId, id);
  const nextScript = ((input.script ?? existing?.script ?? "") + (input.append ?? "")).slice(
    0,
    MAX_DRAFT_SCRIPT_CHARS,
  );
  const timestamp = now();
  return writeDraft({
    id,
    parentAgentId,
    title: input.title ?? existing?.title,
    script: nextScript,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  });
}

export function __setWorkflowScriptDraftRootForTest(root: string | null): void {
  g.__digaAgentWorkflowDraftRootOverride = root;
}

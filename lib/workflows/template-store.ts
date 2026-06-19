import "server-only";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  WorkflowCapability,
  WorkflowJsonSchema,
  WorkflowTemplate,
  WorkflowTemplateSummary,
} from "./types";

const WORKFLOW_TEMPLATE_SCHEMA_VERSION = 1;
const MAX_TEMPLATE_SCRIPT_CHARS = 100_000;
const MAX_TEMPLATE_ID_CHARS = 120;

interface PersistedWorkflowTemplate {
  schemaVersion: 1;
  kind: "workflow-template";
  template: WorkflowTemplate;
  persistedAt: number;
}

type TemplateStoreState = {
  rootOverride?: string | null;
};

const g = globalThis as unknown as {
  __digaAgentWorkflowTemplateStore?: TemplateStoreState;
};
if (!g.__digaAgentWorkflowTemplateStore) {
  g.__digaAgentWorkflowTemplateStore = { rootOverride: null };
}
const store = g.__digaAgentWorkflowTemplateStore;

function defaultRoot(): string {
  return path.join(os.homedir(), ".diga-agent");
}

function getRoot(): string {
  return store.rootOverride ?? defaultRoot();
}

function templatesDir(): string {
  return path.join(getRoot(), "workflows", "templates");
}

function cleanText(raw: unknown, limit: number): string {
  return (typeof raw === "string" ? raw.trim() : "").slice(0, limit);
}

function sanitizeTemplateId(raw: string): string {
  const id = cleanText(raw, MAX_TEMPLATE_ID_CHARS);
  if (!id) throw new Error("workflow template id is required");
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid workflow template id: ${id}`);
  }
  const normalized = id.replace(/[^a-zA-Z0-9_.:-]/g, "-");
  if (!normalized) throw new Error(`invalid workflow template id: ${id}`);
  return normalized;
}

function templateFilePath(id: string): string {
  return path.join(templatesDir(), `${sanitizeTemplateId(id)}.json`);
}

function isCapability(value: unknown): value is WorkflowCapability {
  return (
    value === "spawn_agent" ||
    value === "read_files" ||
    value === "write_files" ||
    value === "shell" ||
    value === "browser" ||
    value === "network" ||
    value === "worktree" ||
    value === "ask_user" ||
    value === "mcp"
  );
}

function normalizeCapabilities(raw: unknown): WorkflowCapability[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: WorkflowCapability[] = [];
  for (const item of raw) {
    if (isCapability(item) && !out.includes(item)) out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeSchema(raw: unknown): WorkflowJsonSchema | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as WorkflowJsonSchema)
    : undefined;
}

function normalizeTemplate(
  raw: Partial<WorkflowTemplate> & { id: string; script: string },
  now = Date.now()
): WorkflowTemplate {
  const id = sanitizeTemplateId(raw.id);
  const script = cleanText(raw.script, MAX_TEMPLATE_SCRIPT_CHARS);
  if (!script) throw new Error("workflow template script is required");
  return {
    id,
    name: cleanText(raw.name, 160) || id,
    description: cleanText(raw.description, 1000) || undefined,
    version: cleanText(raw.version, 80) || "1.0.0",
    script,
    paramsSchema: normalizeSchema(raw.paramsSchema),
    defaultParams: raw.defaultParams,
    capabilities: normalizeCapabilities(raw.capabilities),
    maxAgents:
      typeof raw.maxAgents === "number" && Number.isFinite(raw.maxAgents)
        ? Math.max(1, Math.floor(raw.maxAgents))
        : undefined,
    maxConcurrency:
      typeof raw.maxConcurrency === "number" && Number.isFinite(raw.maxConcurrency)
        ? Math.max(1, Math.floor(raw.maxConcurrency))
        : undefined,
    timeoutMs:
      typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
        ? Math.max(1000, Math.floor(raw.timeoutMs))
        : undefined,
    tags: Array.isArray(raw.tags)
      ? raw.tags
          .map((tag) => cleanText(tag, 80))
          .filter(Boolean)
          .slice(0, 20)
      : [],
    createdAt:
      typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
        ? raw.createdAt
        : now,
    updatedAt: now,
  };
}

function parsePersisted(value: unknown): WorkflowTemplate | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (
    rec.kind === "workflow-template" &&
    rec.schemaVersion === 1 &&
    rec.template &&
    typeof rec.template === "object"
  ) {
    const template = rec.template as Partial<WorkflowTemplate> & {
      id: string;
      script: string;
    };
    return normalizeTemplate(template, template.updatedAt);
  }
  if (typeof rec.id === "string" && typeof rec.script === "string") {
    const template = rec as Partial<WorkflowTemplate> & {
      id: string;
      script: string;
    };
    return normalizeTemplate(template, template.updatedAt);
  }
  return null;
}

function summary(template: WorkflowTemplate): WorkflowTemplateSummary {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    version: template.version,
    tags: template.tags ?? [],
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

export function putWorkflowTemplate(
  raw: Partial<WorkflowTemplate> & { id: string; script: string }
): WorkflowTemplate {
  const existing = getWorkflowTemplate(raw.id);
  const template = normalizeTemplate({
    ...raw,
    createdAt: raw.createdAt ?? existing?.createdAt,
  });
  // T2.9: 同步原子写 + ENOSPC 重抣 + 其他 errno warn。
  fs.mkdirSync(templatesDir(), { recursive: true });
  const file = templateFilePath(template.id);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  const persisted: PersistedWorkflowTemplate = {
    schemaVersion: WORKFLOW_TEMPLATE_SCHEMA_VERSION,
    kind: "workflow-template",
    template,
    persistedAt: Date.now(),
  };
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx");
    fs.writeSync(fd, JSON.stringify(persisted, null, 2), 0, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    const code = (err as NodeJS.ErrnoException).code;
    console.warn("[workflow-template-store] persist failed", {
      id: template.id,
      code,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  return template;
}

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(templateFilePath(id), "utf8"));
    return parsePersisted(parsed) ?? undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function listWorkflowTemplates(): WorkflowTemplateSummary[] {
  let files: string[];
  try {
    files = fs.readdirSync(templatesDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(templatesDir(), file), "utf8")
        );
        return parsePersisted(parsed);
      } catch {
        return null;
      }
    })
    .filter((template): template is WorkflowTemplate => Boolean(template))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(summary);
}

export function deleteWorkflowTemplate(id: string): boolean {
  const file = templateFilePath(id);
  const existed = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  return existed;
}

export function __setWorkflowTemplateStoreRootForTest(root: string | null): void {
  store.rootOverride = root;
}

export function __resetWorkflowTemplateStoreForTest(): void {
  if (store.rootOverride) {
    fs.rmSync(path.join(store.rootOverride, "workflows", "templates"), {
      recursive: true,
      force: true,
    });
  }
}

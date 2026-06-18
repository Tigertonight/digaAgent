import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  WorkflowCapability,
  WorkflowSkill,
  WorkflowSkillSummary,
} from "./types";

/**
 * Workflow skill store (Claude Code style).
 *
 * A skill is a reusable workflow harness persisted on disk so an orchestrator
 * can discover it via progressive disclosure (list summaries -> read one body)
 * and run it without regenerating a large script each time.
 *
 * On-disk layout (human-readable, mirrors Claude Code's skill folders):
 *   ~/.diga-agent/workflows/skills/<name>/
 *     SKILL.md      # YAML frontmatter (name/description/tags/capabilities) + markdown body
 *     harness.js    # the async workflow harness body
 */

const MAX_HARNESS_CHARS = 100_000;
const MAX_NAME_CHARS = 80;

type SkillStoreState = {
  rootOverride?: string | null;
};

const g = globalThis as unknown as {
  __digaAgentWorkflowSkillStore?: SkillStoreState;
};
if (!g.__digaAgentWorkflowSkillStore) {
  g.__digaAgentWorkflowSkillStore = { rootOverride: null };
}
const store = g.__digaAgentWorkflowSkillStore;

function defaultRoot(): string {
  return path.join(os.homedir(), ".diga-agent");
}

function getRoot(): string {
  return store.rootOverride ?? defaultRoot();
}

function skillsDir(): string {
  return path.join(getRoot(), "workflows", "skills");
}

function cleanText(raw: unknown, limit: number): string {
  return (typeof raw === "string" ? raw.trim() : "").slice(0, limit);
}

export function sanitizeSkillName(raw: string): string {
  const name = cleanText(raw, MAX_NAME_CHARS).toLowerCase();
  if (!name) throw new Error("workflow skill name is required");
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`invalid workflow skill name: ${name}`);
  }
  const normalized = name.replace(/[^a-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error(`invalid workflow skill name: ${name}`);
  return normalized;
}

function skillDirPath(name: string): string {
  return path.join(skillsDir(), sanitizeSkillName(name));
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

function normalizeTags(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw
        .map((tag) => cleanText(tag, 80))
        .filter(Boolean)
        .slice(0, 20)
    : [];
}

/**
 * Serialize the SKILL.md: a small YAML frontmatter block plus the markdown
 * instructions body. We hand-roll the frontmatter to avoid a YAML dependency;
 * values are simple strings/arrays so this is safe and round-trippable.
 */
function renderSkillMd(skill: WorkflowSkill): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${skill.name}`);
  lines.push(`description: ${JSON.stringify(skill.description)}`);
  if (skill.tags && skill.tags.length > 0) {
    lines.push(`tags: [${skill.tags.map((t) => JSON.stringify(t)).join(", ")}]`);
  }
  if (skill.capabilities && skill.capabilities.length > 0) {
    lines.push(`capabilities: [${skill.capabilities.join(", ")}]`);
  }
  lines.push(`createdAt: ${skill.createdAt}`);
  lines.push(`updatedAt: ${skill.updatedAt}`);
  lines.push("---");
  lines.push("");
  lines.push(skill.instructions?.trim() || skill.description);
  lines.push("");
  return lines.join("\n");
}

type Frontmatter = Record<string, unknown>;

/** Minimal frontmatter parser for the keys we write in renderSkillMd. */
function parseSkillMd(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw.trim() };
  const [, fmBlock, body] = match;
  const frontmatter: Frontmatter = {};
  for (const line of fmBlock.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const valueRaw = line.slice(idx + 1).trim();
    if (!key) continue;
    if (valueRaw.startsWith("[") && valueRaw.endsWith("]")) {
      const inner = valueRaw.slice(1, -1).trim();
      frontmatter[key] = inner
        ? inner.split(",").map((item) => {
            const t = item.trim();
            try {
              return t.startsWith('"') ? (JSON.parse(t) as string) : t;
            } catch {
              return t;
            }
          })
        : [];
    } else if (valueRaw.startsWith('"')) {
      try {
        frontmatter[key] = JSON.parse(valueRaw);
      } catch {
        frontmatter[key] = valueRaw;
      }
    } else {
      frontmatter[key] = valueRaw;
    }
  }
  return { frontmatter, body: (body ?? "").trim() };
}

function readSkillFromDir(dir: string): WorkflowSkill | null {
  let mdRaw: string;
  let harness: string;
  try {
    mdRaw = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    harness = fs.readFileSync(path.join(dir, "harness.js"), "utf8");
  } catch {
    return null;
  }
  const { frontmatter, body } = parseSkillMd(mdRaw);
  const name = cleanText(frontmatter.name ?? path.basename(dir), MAX_NAME_CHARS);
  if (!name) return null;
  const description = cleanText(frontmatter.description, 1000) || name;
  const createdAt = Number(frontmatter.createdAt);
  const updatedAt = Number(frontmatter.updatedAt);
  return {
    name,
    description,
    instructions: body || undefined,
    harness: cleanText(harness, MAX_HARNESS_CHARS),
    capabilities: normalizeCapabilities(frontmatter.capabilities),
    tags: normalizeTags(frontmatter.tags),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

export function putWorkflowSkill(
  raw: Partial<WorkflowSkill> & { name: string; harness: string }
): WorkflowSkill {
  const name = sanitizeSkillName(raw.name);
  const harness = cleanText(raw.harness, MAX_HARNESS_CHARS);
  if (!harness) throw new Error("workflow skill harness is required");
  const existing = getWorkflowSkill(name);
  const now = Date.now();
  const skill: WorkflowSkill = {
    name,
    description: cleanText(raw.description, 1000) || name,
    instructions: cleanText(raw.instructions, 20_000) || undefined,
    harness,
    capabilities: normalizeCapabilities(raw.capabilities),
    tags: normalizeTags(raw.tags),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const dir = skillDirPath(name);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic-ish writes per file (tmp + rename).
  const writeAtomic = (file: string, contents: string) => {
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, contents, "utf8");
    fs.renameSync(tmp, file);
  };
  writeAtomic(path.join(dir, "SKILL.md"), renderSkillMd(skill));
  writeAtomic(path.join(dir, "harness.js"), skill.harness);
  return skill;
}

export function getWorkflowSkill(name: string): WorkflowSkill | undefined {
  return readSkillFromDir(skillDirPath(name)) ?? undefined;
}

export function listWorkflowSkills(): WorkflowSkillSummary[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir(), { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSkillFromDir(path.join(skillsDir(), entry.name)))
    .filter((skill): skill is WorkflowSkill => Boolean(skill))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      tags: skill.tags ?? [],
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    }));
}

export function deleteWorkflowSkill(name: string): boolean {
  const dir = skillDirPath(name);
  const existed = fs.existsSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return existed;
}

export function __setWorkflowSkillStoreRootForTest(root: string | null): void {
  store.rootOverride = root;
}

export function __resetWorkflowSkillStoreForTest(): void {
  if (store.rootOverride) {
    fs.rmSync(path.join(store.rootOverride, "workflows", "skills"), {
      recursive: true,
      force: true,
    });
  }
}

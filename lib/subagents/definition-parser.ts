import { createHash } from "node:crypto";
import {
  isPermissionMode,
  isSubagentRole,
  MAX_SPECIALIST_PROMPT_CHARS,
  type SubagentDefinition,
  type SubagentDefinitionSource,
  type SubagentIsolationConfig,
} from "./definition";

export interface ParseDefinitionContext {
  /** Specialist id (usually the file name without .md). */
  id: string;
  source: SubagentDefinitionSource;
  sourcePath?: string;
}

export interface ParseDefinitionResult {
  definition?: SubagentDefinition;
  error?: string;
  warnings: string[];
}

/** Frontmatter values: scalar string or string array, plus one level nesting. */
type FmValue = string | string[] | Record<string, string>;

function assertSafeId(id: string): void {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid subagent definition id: ${id}`);
  }
}

/**
 * Minimal frontmatter parser (修正 1). Supports:
 *   key: value            -> scalar
 *   key:                  -> followed by "  - item" lines (string array)
 *   key:                  -> followed by "  subkey: value" lines (object, 1 level)
 * It does NOT support YAML anchors, multiline, or flow syntax. Unknown shapes
 * are skipped with a warning rather than crashing.
 */
function parseFrontmatter(
  raw: string,
  warnings: string[]
): Record<string, FmValue> {
  const out: Record<string, FmValue> = {};
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) {
      warnings.push(`Skipped unrecognized frontmatter line: ${line.trim()}`);
      i += 1;
      continue;
    }
    const key = m[1];
    const inline = m[2].trim();
    if (inline) {
      out[key] = stripQuotes(inline);
      i += 1;
      continue;
    }
    // Block form: look ahead for indented list items or sub-keys.
    const listItems: string[] = [];
    const obj: Record<string, string> = {};
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) {
      const child = lines[j].trim();
      const li = /^-\s+(.*)$/.exec(child);
      if (li) {
        listItems.push(stripQuotes(li[1].trim()));
      } else {
        const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(child);
        if (kv) obj[kv[1]] = stripQuotes(kv[2].trim());
        else warnings.push(`Skipped unrecognized nested line: ${child}`);
      }
      j += 1;
    }
    if (listItems.length > 0) out[key] = listItems;
    else if (Object.keys(obj).length > 0) out[key] = obj;
    else warnings.push(`Empty block value for key: ${key}`);
    i = j;
  }
  return out;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function asString(v: FmValue | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: FmValue | undefined): string[] | undefined {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x);
  return undefined;
}

function asObject(v: FmValue | undefined): Record<string, string> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

/**
 * Parse a `.md` specialist definition file (frontmatter + body). Returns a
 * definition or a readable error. Single-file failures should be skipped by the
 * registry, not crash discovery.
 */
export function parseDefinition(
  content: string,
  ctx: ParseDefinitionContext
): ParseDefinitionResult {
  const warnings: string[] = [];
  try {
    assertSafeId(ctx.id);

    const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(content);
    if (!fmMatch) {
      return {
        error: `Missing frontmatter (--- ... ---) in ${ctx.sourcePath ?? ctx.id}`,
        warnings,
      };
    }
    const fm = parseFrontmatter(fmMatch[1], warnings);
    const body = fmMatch[2].trim();

    const title = asString(fm.title);
    const description = asString(fm.description);
    if (!title) {
      return { error: `Missing required field "title" in ${ctx.id}`, warnings };
    }
    if (!description) {
      return {
        error: `Missing required field "description" in ${ctx.id}`,
        warnings,
      };
    }
    if (!body) {
      return { error: `Missing prompt body in ${ctx.id}`, warnings };
    }

    const permissionRaw = asString(fm.permissionMode);
    if (permissionRaw && !isPermissionMode(permissionRaw)) {
      return {
        error: `Invalid permissionMode "${permissionRaw}" in ${ctx.id} (allowed: readOnly, boundedWrite, denyAll)`,
        warnings,
      };
    }

    const roleRaw = asString(fm.role);
    if (roleRaw && !isSubagentRole(roleRaw)) {
      warnings.push(
        `Unknown role "${roleRaw}" in ${ctx.id}; ignoring (will default to general).`
      );
    }

    const modelObj = asObject(fm.model);

    // isolation: { mode: none|worktree, baseRef? }
    let isolation: SubagentIsolationConfig | undefined;
    const isoObj = asObject(fm.isolation);
    if (isoObj?.mode === "worktree" || isoObj?.mode === "none") {
      isolation = {
        mode: isoObj.mode,
        ...(isoObj.baseRef ? { baseRef: isoObj.baseRef } : {}),
      };
    } else if (asString(fm.isolation) === "worktree") {
      // Allow the scalar shorthand `isolation: worktree`.
      isolation = { mode: "worktree" };
    } else if (isoObj && isoObj.mode) {
      warnings.push(
        `Unknown isolation.mode "${isoObj.mode}" in ${ctx.id}; ignoring.`
      );
    }

    const definition: SubagentDefinition = {
      id: ctx.id,
      title,
      description,
      prompt: body.slice(0, MAX_SPECIALIST_PROMPT_CHARS),
      source: ctx.source,
      sourcePath: ctx.sourcePath,
      versionHash: createHash("sha256").update(content).digest("hex").slice(0, 16),
      ...(roleRaw && isSubagentRole(roleRaw) ? { role: roleRaw } : {}),
      ...(permissionRaw && isPermissionMode(permissionRaw)
        ? { permissionMode: permissionRaw }
        : {}),
      ...(modelObj && (modelObj.provider || modelObj.id)
        ? {
            model: {
              ...(modelObj.provider ? { provider: modelObj.provider } : {}),
              ...(modelObj.id ? { id: modelObj.id } : {}),
            },
          }
        : {}),
      ...(asStringArray(fm.defaultTools)
        ? { defaultTools: asStringArray(fm.defaultTools) }
        : {}),
      ...(isolation ? { isolation } : {}),
      ...(asStringArray(fm.capabilities)
        ? { capabilities: asStringArray(fm.capabilities) }
        : {}),
      ...(asStringArray(fm.allowedMcpServers)
        ? { allowedMcpServers: asStringArray(fm.allowedMcpServers) }
        : {}),
    };

    return { definition, warnings };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
      warnings,
    };
  }
}

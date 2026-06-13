import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SubagentDefinition, SubagentDefinitionSource } from "./definition";
import { parseDefinition } from "./definition-parser";

/**
 * In-memory cache keyed by discovery scope. project definitions are keyed by
 * cwd; user definitions are global. Cached by file versionHash so unchanged
 * files are not re-parsed.
 */
interface RegistryStore {
  /** cacheKey -> (id -> definition) */
  byScope: Map<string, Map<string, SubagentDefinition>>;
}

const g = globalThis as unknown as { __digaAgentSubagentRegistry?: RegistryStore };
if (!g.__digaAgentSubagentRegistry) {
  g.__digaAgentSubagentRegistry = { byScope: new Map() };
}
const store = g.__digaAgentSubagentRegistry;

let userRootOverride: string | null = null;

function userDir(): string {
  const root = userRootOverride ?? path.join(os.homedir(), ".diga-agent");
  return path.join(root, "subagents");
}

function projectDir(cwd: string): string {
  return path.join(cwd, ".agents", "subagents");
}

/**
 * Discover definitions in a single directory. Single-file failures are skipped
 * (collected into `errors`) rather than crashing discovery (修正 6). A missing
 * directory yields an empty list.
 */
function discoverDir(
  dir: string,
  source: SubagentDefinitionSource,
  errors: string[]
): SubagentDefinition[] {
  if (!existsSync(dir)) return [];
  const out: SubagentDefinition[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -".md".length);
    const fp = path.join(dir, name);
    try {
      const content = readFileSync(fp, "utf8");
      const res = parseDefinition(content, { id, source, sourcePath: fp });
      if (res.error) {
        errors.push(`${fp}: ${res.error}`);
        continue;
      }
      if (res.definition) out.push(res.definition);
    } catch (e) {
      errors.push(`${fp}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

export interface DiscoverResult {
  definitions: SubagentDefinition[];
  errors: string[];
}

/**
 * Discover and merge user + project definitions. Project overrides user by id.
 * Results are cached per cwd; pass `force` to bypass.
 */
export function discoverDefinitions(
  cwd: string,
  opts?: { force?: boolean }
): DiscoverResult {
  const cacheKey = cwd;
  if (!opts?.force) {
    const cached = store.byScope.get(cacheKey);
    if (cached) {
      return { definitions: Array.from(cached.values()), errors: [] };
    }
  }
  const errors: string[] = [];
  const merged = new Map<string, SubagentDefinition>();
  // user first, project overrides.
  for (const def of discoverDir(userDir(), "user", errors)) {
    merged.set(def.id, def);
  }
  for (const def of discoverDir(projectDir(cwd), "project", errors)) {
    merged.set(def.id, def);
  }
  store.byScope.set(cacheKey, merged);
  return { definitions: Array.from(merged.values()), errors };
}

export function listDefinitions(cwd: string): SubagentDefinition[] {
  return discoverDefinitions(cwd).definitions;
}

export function getDefinition(
  cwd: string,
  id: string
): SubagentDefinition | null {
  if (!store.byScope.has(cwd)) discoverDefinitions(cwd);
  return store.byScope.get(cwd)?.get(id) ?? null;
}

/** Compact hints (id + description) for injection into the planner / prompt. */
export function getRegistryHints(
  cwd: string
): Array<{ id: string; title: string; description: string }> {
  return listDefinitions(cwd).map((d) => ({
    id: d.id,
    title: d.title,
    description: d.description,
  }));
}

export function __setRegistryUserRootForTest(root: string | null): void {
  userRootOverride = root;
  store.byScope.clear();
}

export function __resetRegistryForTest(): void {
  store.byScope.clear();
}

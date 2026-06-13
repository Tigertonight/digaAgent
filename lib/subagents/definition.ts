import type { SubagentRole } from "./types";

/**
 * Permission modes for a registered specialist.
 * - readOnly / boundedWrite / denyAll: Sprint 2.
 * - worktree: Sprint 3 — writes happen in an isolated git worktree and must be
 *   merged via approval.
 * planOnly / acceptEdits / ask remain reserved for later phases.
 */
export type SubagentPermissionMode =
  | "readOnly"
  | "boundedWrite"
  | "denyAll"
  | "worktree";

export const PERMISSION_MODES: readonly SubagentPermissionMode[] = [
  "readOnly",
  "boundedWrite",
  "denyAll",
  "worktree",
];

/** Isolation strategy for a specialist's file writes (Sprint 3). */
export type SubagentIsolationMode = "none" | "worktree";

export interface SubagentIsolationConfig {
  mode: SubagentIsolationMode;
  /** Optional base ref for the worktree (defaults to HEAD). */
  baseRef?: string;
}

/** Built-in hook names a definition may reference (Sprint 3 + 4). */
export interface SubagentHookConfig {
  subagentStart?: string[];
  beforeToolUse?: string[];
  afterToolUse?: string[];
  subagentStop?: string[];
}

export interface SubagentModelPolicy {
  provider?: string;
  id?: string;
}

export type SubagentDefinitionSource = "project" | "user" | "builtin";

/**
 * A reusable specialist definition discovered from `.agents/subagents/*.md`
 * (project) or `~/.diga-agent/subagents/*.md` (user). The frontmatter supplies the
 * structured fields; the markdown body becomes `prompt`.
 */
export interface SubagentDefinition {
  id: string;
  title: string;
  description: string;
  prompt: string;
  source: SubagentDefinitionSource;
  sourcePath?: string;
  /** Content hash for cache invalidation. */
  versionHash: string;
  /** Optional reuse of the closed role enum for default tools / verification. */
  role?: SubagentRole;
  model?: SubagentModelPolicy;
  permissionMode?: SubagentPermissionMode;
  defaultTools?: string[];
  /** Isolation strategy for writes (Sprint 3). Defaults to none. */
  isolation?: SubagentIsolationConfig;
  /** Lifecycle hooks (Sprint 3). */
  hooks?: SubagentHookConfig;
  // Reserved for later phases (declared so frontmatter can carry them without
  // failing validation, but not yet consumed by the runtime):
  capabilities?: string[];
  allowedMcpServers?: string[];
}

/** Max characters of the markdown body injected into a child prompt (修正 3). */
export const MAX_SPECIALIST_PROMPT_CHARS = 4000;

export function isPermissionMode(v: unknown): v is SubagentPermissionMode {
  return (
    v === "readOnly" ||
    v === "boundedWrite" ||
    v === "denyAll" ||
    v === "worktree"
  );
}

export function isSubagentRole(v: unknown): v is SubagentRole {
  return (
    v === "general" ||
    v === "rag" ||
    v === "research" ||
    v === "code-review" ||
    v === "implementation"
  );
}

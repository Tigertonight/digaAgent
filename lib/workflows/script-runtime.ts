import "server-only";
import { spawn as spawnProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type {
  RunWorkflowScriptDeps,
  RunWorkflowScriptInput,
  WorkflowArtifact,
  WorkflowCheckpoint,
  WorkflowCapability,
  WorkflowManifest,
  WorkflowRunStatus,
  WorkflowScriptLog,
  WorkflowScriptResult,
  WorkflowCreateWorktreeInput,
  WorkflowSpawnAgentInput,
  WorkflowWorktree,
  WorkflowWorktreeDiff,
  WorkflowWorktreeMergeResult,
  WorkflowRun,
  WorkflowAskUserInput,
  WorkflowAskUserResult,
  WorkflowFetchUrlInput,
  WorkflowFetchUrlResult,
  WorkflowNetworkPolicy,
  WorkflowMcpToolDescriptor,
  WorkflowSearchToolsInput,
  WorkflowCallToolInput,
  WorkflowCallToolResult,
  WorkflowAgentInput,
  WorkflowAgentResult,
  WorkflowAgentType,
  WorkflowTraceEvent,
} from "./types";
import {
  appendWorkflowCheckpoint,
  appendWorkflowLog,
  appendWorkflowTraceEvent,
  finishWorkflowRun,
  getWorkflowRun,
  putWorkflowArtifact,
  putWorkflowRun,
} from "./server-store";
import { appendWorkflowNetworkAudit } from "./network-policy";
import { schemaInstruction, validateJsonSchema } from "./json-schema";
import { RUNTIME_LIMITS } from "@/lib/shared/runtime-limits";

const MAX_SCRIPT_TIMEOUT_MS = RUNTIME_LIMITS.workflowMaxTimeoutMs;
const DEFAULT_MAX_AGENTS = 8;
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_SCRIPT_CHARS = 50000;
const WORKFLOW_WORKER_MAX_OLD_SPACE_MB = 128;
const WORKFLOW_WORKER_CPU_SECONDS = 60;
const DEFAULT_FETCH_MAX_BYTES = 128 * 1024;
const HARD_FETCH_MAX_BYTES = 1024 * 1024;
const SAFE_WORKFLOW_AGENT_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_WORKFLOW_AGENT_TOOLS = new Set(["edit", "write", "apply_patch"]);
const SHELL_WORKFLOW_AGENT_TOOLS = new Set(["bash", "shell"]);
const BROWSER_WORKFLOW_AGENT_TOOLS = new Set([
  "browser_open",
  "browser_screenshot",
  "browser_click",
  "browser_click_text",
  "browser_fill",
  "browser_type",
  "browser_search",
  "browser_wait",
  "browser_wait_for",
  "browser_scroll",
  "browser_tabs",
  "browser_tab_open",
  "browser_tab_switch",
  "browser_extract",
  "browser_verify",
  "browser_annotations",
  "browser_resolve_annotation",
  "browser_close",
]);
const WORKFLOW_AGENT_TOOL_ALIASES = new Map<string, string>([
  ["glob", "find"],
  ["rg", "grep"],
  ["ripgrep", "grep"],
  ["search", "grep"],
  ["list", "ls"],
]);
const WORKFLOW_AGENT_TOOL_REPLACEMENTS = [
  "glob -> find",
  "rg/ripgrep/search -> grep",
  "list -> ls",
].join(", ");
const WORKFLOW_AGENT_SUPPORTED_TOOLS = [
  ...SAFE_WORKFLOW_AGENT_TOOLS,
  ...WRITE_WORKFLOW_AGENT_TOOLS,
  ...SHELL_WORKFLOW_AGENT_TOOLS,
  ...BROWSER_WORKFLOW_AGENT_TOOLS,
].join(", ");
const DEFAULT_CAPABILITIES: WorkflowCapability[] = [
  "spawn_agent",
  "read_files",
];
const IMPLEMENTED_CAPABILITIES = new Set<WorkflowCapability>([
  "spawn_agent",
  "read_files",
  "write_files",
  "shell",
  "browser",
  "network",
  "worktree",
  "ask_user",
  "mcp",
]);
const APPROVAL_REQUIRED_CAPABILITIES = new Set<WorkflowCapability>([
  "write_files",
  "shell",
  "browser",
  "network",
  "worktree",
  "ask_user",
  "mcp",
]);

type WorkflowSdk = {
  readonly workflowId: string;
  readonly objective: string;
  readonly capabilities: readonly WorkflowCapability[];
  readonly resume?: WorkflowResumeState;
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  checkpoint(name: string, value: unknown): unknown;
  artifact(name: string, value: unknown): unknown;
  readArtifact(name: string): unknown;
  listArtifacts(): WorkflowArtifact[];
  createWorktree(
    input?: WorkflowCreateWorktreeInput,
  ): Promise<WorkflowWorktree>;
  diffWorktree(worktree: WorkflowWorktree): Promise<WorkflowWorktreeDiff>;
  mergeWorktree(
    worktree: WorkflowWorktree,
  ): Promise<WorkflowWorktreeMergeResult>;
  removeWorktree(worktree: WorkflowWorktree): Promise<void>;
  askUser(input: WorkflowAskUserInput): Promise<WorkflowAskUserResult>;
  fetchUrl(input: WorkflowFetchUrlInput): Promise<WorkflowFetchUrlResult>;
  listTools(serverId?: string): Promise<WorkflowMcpToolDescriptor[]>;
  searchTools(
    input?: WorkflowSearchToolsInput,
  ): Promise<WorkflowMcpToolDescriptor[]>;
  callTool(input: WorkflowCallToolInput): Promise<WorkflowCallToolResult>;
  agent<T = unknown>(
    prompt: string,
    input?: Omit<WorkflowAgentInput, "prompt">,
  ): Promise<WorkflowAgentResult<T>>;
  spawnAgent(input: WorkflowSpawnAgentInput): Promise<unknown>;
  parallel<T>(items: Array<Promise<T> | (() => Promise<T> | T)>): Promise<T[]>;
  requireSuccess<T>(
    results: T[],
    options?: { minSuccess?: number; label?: string },
  ): T[];
  stage<T>(title: string, fn: () => Promise<T> | T): Promise<T>;
  sleep(ms: number): Promise<void>;
};

type WorkflowResumeState = {
  fromWorkflowId: string;
  objective: string;
  status: WorkflowRun["status"];
  lastCheckpoint?: WorkflowCheckpoint;
  checkpointNames: string[];
  artifactNames: string[];
};

function now() {
  return Date.now();
}

function cleanText(raw: string | undefined, limit: number): string {
  return (raw?.trim() ?? "").slice(0, limit);
}

export interface WorkflowScriptNormalizationDiagnostic {
  code:
    | "outer_fence_unwrapped"
    | "markdown_wrapper_extracted"
    | "embedded_fence_allowed";
  message: string;
}

const COMPLETE_SCRIPT_FENCE_RE =
  /^```(?:javascript|js)?\s*\n([\s\S]*?)\n```\s*$/i;

function parseMarkdownCodeBlocks(
  text: string,
): Array<{ language: string; body: string; start: number; end: number }> {
  const blocks: Array<{
    language: string;
    body: string;
    start: number;
    end: number;
  }> = [];
  const re = /```([A-Za-z0-9_-]*)[^\S\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n)```/g;
  for (const match of text.matchAll(re)) {
    blocks.push({
      language: (match[1] ?? "").toLowerCase(),
      body: match[2] ?? "",
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }
  return blocks;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function looksLikeMarkdownOrProseWrapper(text: string): boolean {
  const firstLine = firstNonEmptyLine(text);
  if (!firstLine) return false;
  if (/^```/.test(firstLine)) return true;
  if (/^(#{1,6}\s|[-*]\s|\d+[.)]\s|(?:plan|outline|steps?)\s*:)/i.test(firstLine)) {
    return true;
  }
  if (/^(here(?:'s| is)|below|script|workflow script|代码|脚本|计划|步骤)[:：\s]/i.test(firstLine)) {
    return true;
  }
  return false;
}

function isJavaScriptFenceLanguage(language: string): boolean {
  return language === "" || language === "js" || language === "javascript";
}

function findMarkdownFenceOutsideJavaScript(
  text: string,
): Array<{ index: number }> {
  const hits: Array<{ index: number }> = [];
  let state:
    | "code"
    | "single"
    | "double"
    | "template"
    | "line_comment"
    | "block_comment" = "code";
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (state === "line_comment") {
      if (ch === "\n" || ch === "\r") state = "code";
      continue;
    }
    if (state === "block_comment") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 1;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (state === "template" && text.startsWith("```", i)) {
        i += 2;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (
        (state === "single" && ch === "'") ||
        (state === "double" && ch === '"') ||
        (state === "template" && ch === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (text.startsWith("```", i)) {
      hits.push({ index: i });
      i += 2;
      continue;
    }
    if (ch === "/" && next === "/") {
      state = "line_comment";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block_comment";
      i += 1;
      continue;
    }
    if (ch === "'") {
      state = "single";
      continue;
    }
    if (ch === '"') {
      state = "double";
      continue;
    }
    if (ch === "`") {
      state = "template";
    }
  }

  return hits;
}

export function normalizeAndDiagnoseWorkflowScript(
  raw: string | undefined,
  maxChars = MAX_SCRIPT_CHARS,
): { script: string; diagnostics: WorkflowScriptNormalizationDiagnostic[] } {
  const text = cleanText(raw, maxChars);
  const diagnostics: WorkflowScriptNormalizationDiagnostic[] = [];
  const fenced = text.match(COMPLETE_SCRIPT_FENCE_RE);
  if (fenced?.[1] !== undefined) {
    diagnostics.push({
      code: "outer_fence_unwrapped",
      message:
        "script_normalized.outer_fence_unwrapped: removed one complete outer JavaScript Markdown fence before validation.",
    });
    return { script: fenced[1].trim(), diagnostics };
  }

  const blocks = parseMarkdownCodeBlocks(text).filter((block) =>
    isJavaScriptFenceLanguage(block.language),
  );
  if (blocks.length === 1 && looksLikeMarkdownOrProseWrapper(text)) {
    const block = blocks[0];
    const outside = `${text.slice(0, block.start)}\n${text.slice(block.end)}`;
    if (outside.trim()) {
      diagnostics.push({
        code: "markdown_wrapper_extracted",
        message:
          "script_normalized.markdown_wrapper_extracted: extracted the single JavaScript fenced block from surrounding prose before validation.",
      });
      return { script: block.body.trim(), diagnostics };
    }
  }

  if (
    text.includes("```") &&
    findMarkdownFenceOutsideJavaScript(text).length === 0
  ) {
    diagnostics.push({
      code: "embedded_fence_allowed",
      message:
        "script_validation.embedded_fence_allowed: Markdown fence characters appear only inside JavaScript strings/comments.",
    });
  }

  return { script: text, diagnostics };
}

export function normalizeWorkflowScriptBody(
  raw: string | undefined,
  maxChars = MAX_SCRIPT_CHARS,
): string {
  return normalizeAndDiagnoseWorkflowScript(raw, maxChars).script;
}

function serializeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sanitizeWorkflowId(raw: string | undefined): string | undefined {
  const id = cleanText(raw, 120);
  if (!id) return undefined;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`invalid resumeFromWorkflowId: ${id}`);
  }
  return id;
}

function sanitizeCheckpointName(raw: string | undefined): string | undefined {
  const name = cleanText(raw, 200);
  if (!name) return undefined;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`invalid resumeFromCheckpointName: ${name}`);
  }
  return name;
}

function normalizeCapabilities(
  raw: WorkflowCapability[] | undefined,
): WorkflowCapability[] {
  const source = raw === undefined ? DEFAULT_CAPABILITIES : raw;
  const out: WorkflowCapability[] = [];
  for (const capability of source) {
    if (
      capability === "spawn_agent" ||
      capability === "read_files" ||
      capability === "write_files" ||
      capability === "shell" ||
      capability === "browser" ||
      capability === "network" ||
      capability === "worktree" ||
      capability === "ask_user" ||
      capability === "mcp"
    ) {
      if (!out.includes(capability)) out.push(capability);
    }
  }
  return out;
}

function normalizeManifest(input: RunWorkflowScriptInput): WorkflowManifest {
  const capabilities = normalizeCapabilities(input.capabilities);
  return {
    capabilities,
    maxAgents: Math.max(
      1,
      Math.min(Math.floor(input.maxAgents ?? DEFAULT_MAX_AGENTS), 32),
    ),
    maxConcurrency: Math.max(
      1,
      Math.min(Math.floor(input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY), 16),
    ),
    timeoutMs: Math.max(
      1000,
      Math.min(
        input.timeoutMs ?? RUNTIME_LIMITS.workflowDefaultTimeoutMs(),
        MAX_SCRIPT_TIMEOUT_MS,
      ),
    ),
    runtime: "process",
    successCriteria: normalizeSuccessCriteria(input.successCriteria),
  };
}

function normalizeSuccessCriteria(
  raw: WorkflowManifest["successCriteria"],
): WorkflowManifest["successCriteria"] {
  if (!raw || typeof raw !== "object") return undefined;
  const out: NonNullable<WorkflowManifest["successCriteria"]> = {};
  if (Array.isArray(raw.requiredArtifacts)) {
    out.requiredArtifacts = raw.requiredArtifacts
      .map((name) => cleanText(name, 200))
      .filter(Boolean);
  }
  if (
    typeof raw.minNonEmptyArtifacts === "number" &&
    Number.isFinite(raw.minNonEmptyArtifacts)
  ) {
    out.minNonEmptyArtifacts = Math.max(
      0,
      Math.floor(raw.minNonEmptyArtifacts),
    );
  }
  if (
    typeof raw.minReportChars === "number" &&
    Number.isFinite(raw.minReportChars)
  ) {
    out.minReportChars = Math.max(0, Math.floor(raw.minReportChars));
  }
  if (typeof raw.reportArtifact === "string") {
    out.reportArtifact = cleanText(raw.reportArtifact, 200) || undefined;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Returns a stringified, trimmed form of an artifact value for emptiness/length
 * checks. Objects are JSON-stringified; null/undefined become "".
 */
function artifactStringValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isWorkflowCapabilityApprovalTimeout(error: string): boolean {
  return /^Workflow capability approval timed out: /i.test(error);
}

/**
 * End-state quality gate (Claude "end-state evaluation"): given the criteria and
 * the produced artifacts, return human-readable warnings for anything unmet.
 * Empty array means the run substantively succeeded.
 */
function evaluateSuccessCriteria(
  criteria: WorkflowManifest["successCriteria"],
  artifacts: WorkflowArtifact[],
): string[] {
  if (!criteria) return [];
  const warnings: string[] = [];
  const byName = new Map<string, WorkflowArtifact>();
  for (const artifact of artifacts) byName.set(artifact.name, artifact);

  for (const name of criteria.requiredArtifacts ?? []) {
    const artifact = byName.get(name);
    if (!artifact) {
      warnings.push(`必需产物「${name}」缺失`);
    } else if (artifactStringValue(artifact.value).length === 0) {
      warnings.push(`必需产物「${name}」为空`);
    }
  }

  if (typeof criteria.minNonEmptyArtifacts === "number") {
    const nonEmpty = artifacts.filter(
      (a) => artifactStringValue(a.value).length > 0,
    ).length;
    if (nonEmpty < criteria.minNonEmptyArtifacts) {
      warnings.push(
        `非空产物只有 ${nonEmpty} 个，期望至少 ${criteria.minNonEmptyArtifacts} 个`,
      );
    }
  }

  if (typeof criteria.minReportChars === "number") {
    const target = criteria.reportArtifact
      ? byName.get(criteria.reportArtifact)
      : artifacts[artifacts.length - 1];
    const len = artifactStringValue(target?.value).length;
    const hardMin = Math.max(
      criteria.minReportChars > 0 ? 1 : 0,
      Math.floor(criteria.minReportChars * 0.98),
    );
    if (len < hardMin) {
      const label = criteria.reportArtifact ?? target?.name ?? "report";
      warnings.push(
        `报告产物「${label}」约 ${len} 字符，期望约 ${criteria.minReportChars} 字符`,
      );
    }
  }

  return warnings;
}

async function approveManifestCapabilities(
  deps: RunWorkflowScriptDeps,
  input: RunWorkflowScriptInput,
  workflowId: string,
  manifest: WorkflowManifest,
  onTrace?: (trace: WorkflowTraceEvent) => void,
): Promise<void> {
  const approvalRequired = manifest.capabilities.filter((capability) =>
    APPROVAL_REQUIRED_CAPABILITIES.has(capability),
  );
  if (approvalRequired.length === 0) return;
  if (!deps.approveCapability) {
    throw new Error(
      `Workflow capability approval broker is not implemented for: ${approvalRequired.join(", ")}`,
    );
  }
  for (const capability of approvalRequired) {
    const resp = await deps.approveCapability({
      workflowId,
      capability,
      manifest,
      objective: input.objective,
      rationale: input.rationale,
    });
    onTrace?.({
      type: "approval",
      workflowId,
      capability,
      decision: resp.decision,
      createdAt: now(),
    });
    if (resp.decision !== "allow") {
      throw new Error(
        resp.denyReason ?? `Workflow capability denied: ${capability}`,
      );
    }
  }
}

function assertRuntimeSupportsCapabilities(manifest: WorkflowManifest): void {
  const unimplemented = manifest.capabilities.filter(
    (capability) => !IMPLEMENTED_CAPABILITIES.has(capability),
  );
  if (unimplemented.length > 0) {
    throw new Error(
      `Workflow runtime support is not implemented for: ${unimplemented.join(", ")}`,
    );
  }
}

function hasCapability(
  manifest: WorkflowManifest,
  capability: WorkflowCapability,
): boolean {
  return manifest.capabilities.includes(capability);
}

function requireCapability(
  manifest: WorkflowManifest,
  capability: WorkflowCapability,
) {
  if (!hasCapability(manifest, capability)) {
    throw new Error(`workflow capability required: ${capability}`);
  }
}

function roleForAgentType(
  agentType: WorkflowAgentType | undefined,
): WorkflowSpawnAgentInput["role"] {
  switch (agentType) {
    case "classifier":
    case "researcher":
      return "research";
    case "implementer":
      return "implementation";
    case "reviewer":
    case "verifier":
      return "code-review";
    case "general":
    default:
      return "general";
  }
}

function jsonRecoveryGuidance(): string {
  return "Return only compact valid JSON matching the schema. If the answer is large, keep only the required fields in JSON and put long prose/detail into a separate artifact or file instead of the schema output.";
}

function jsonParseErrorMessage(reason: string, truncated = false): string {
  const prefix = truncated
    ? "workflow.agent schema JSON output appears truncated"
    : "workflow.agent schema JSON output was not valid JSON";
  return `${prefix}: ${reason}. ${jsonRecoveryGuidance()}`;
}

function hasBalancedJsonDelimiters(text: string): boolean {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if ((ch === "}" && open !== "{") || (ch === "]" && open !== "[")) {
        return false;
      }
    }
  }
  return !inString && stack.length === 0;
}

function looksLikeTruncatedJson(text: string, reason?: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/Unexpected end of JSON input/i.test(reason ?? "")) return true;
  if (/^```(?:json)?\s*[\s\S]*$/i.test(trimmed) && !/```\s*$/.test(trimmed)) {
    return true;
  }
  if (/^[{[]/.test(trimmed) && !hasBalancedJsonDelimiters(trimmed)) return true;
  if (/[,:]\s*$/.test(trimmed)) return true;
  return false;
}

function parseJsonCandidate(candidate: string, source: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      jsonParseErrorMessage(reason, looksLikeTruncatedJson(source, reason)),
    );
  }
}

export function extractWorkflowJsonValue(raw: string): unknown {
  const text = raw.trim();
  if (!text) {
    throw new Error(
      "workflow.agent schema JSON output was empty. " + jsonRecoveryGuidance(),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return parseJsonCandidate(fenced[1].trim(), text);
    if (/^```(?:json)?\s*/i.test(text)) {
      throw new Error(
        jsonParseErrorMessage("missing closing markdown fence", true),
      );
    }
    const start = Math.min(
      ...[text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0),
    );
    if (Number.isFinite(start)) {
      const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
      if (end > start)
        return parseJsonCandidate(text.slice(start, end + 1), text);
      throw new Error(
        jsonParseErrorMessage("missing closing JSON delimiter", true),
      );
    }
    throw new Error(jsonParseErrorMessage("no JSON object or array found"));
  }
}

/**
 * Whether an MCP server is usable by this workflow. `undefined` allowedMcpServers
 * means "all enabled servers" (parent decides). An explicit list restricts to it.
 */
function isServerInScope(
  allowedMcpServers: string[] | undefined,
  serverId: string,
): boolean {
  if (allowedMcpServers === undefined) return true;
  return allowedMcpServers.includes(serverId);
}

function safeAllowedTools(
  manifest: WorkflowManifest,
  tools: string[] | undefined,
): { tools: string[] | undefined; normalized: string[] } {
  if (!tools) return { tools: undefined, normalized: [] };
  const cleaned: string[] = [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawTool of tools) {
    const inputTool = rawTool.trim();
    if (!inputTool) continue;
    const tool = WORKFLOW_AGENT_TOOL_ALIASES.get(inputTool) ?? inputTool;
    if (tool !== inputTool) normalized.push(`${inputTool} -> ${tool}`);
    if (seen.has(tool)) continue;
    seen.add(tool);
    cleaned.push(tool);
  }
  const unknown: string[] = [];
  for (const tool of cleaned) {
    if (SAFE_WORKFLOW_AGENT_TOOLS.has(tool)) {
      requireCapability(manifest, "read_files");
      continue;
    }
    if (WRITE_WORKFLOW_AGENT_TOOLS.has(tool)) {
      requireCapability(manifest, "write_files");
      continue;
    }
    if (SHELL_WORKFLOW_AGENT_TOOLS.has(tool)) {
      requireCapability(manifest, "shell");
      continue;
    }
    if (BROWSER_WORKFLOW_AGENT_TOOLS.has(tool)) {
      requireCapability(manifest, "browser");
      continue;
    }
    unknown.push(tool);
  }
  if (unknown.length > 0) {
    throw new Error(
      [
        `workflow.spawnAgent tool(s) are not mapped to workflow capabilities: ${unknown.join(", ")}`,
        `Supported child agent tools: ${WORKFLOW_AGENT_SUPPORTED_TOOLS}.`,
        `Common replacements: ${WORKFLOW_AGENT_TOOL_REPLACEMENTS}.`,
      ].join(" "),
    );
  }
  return { tools: cleaned, normalized };
}

/**
 * Map an agent tool name to the workflow capability it implies, or null if the
 * tool needs no extra capability beyond the safe default.
 */
function capabilityForAgentTool(tool: string): WorkflowCapability | null {
  tool = WORKFLOW_AGENT_TOOL_ALIASES.get(tool) ?? tool;
  if (WRITE_WORKFLOW_AGENT_TOOLS.has(tool)) return "write_files";
  if (SHELL_WORKFLOW_AGENT_TOOLS.has(tool)) return "shell";
  if (BROWSER_WORKFLOW_AGENT_TOOLS.has(tool)) return "browser";
  // SAFE_WORKFLOW_AGENT_TOOLS only need read_files, which is in DEFAULT.
  return null;
}

/**
 * Statically scan a workflow script for agent tool names and SDK calls that
 * imply a capability, so we can request approval BEFORE the workflow starts
 * spawning agents — instead of failing each child agent at runtime with
 * "workflow capability required: shell".
 *
 * This is a best-effort heuristic (the script is dynamic JS), so the runtime
 * safeAllowedTools check still backstops anything assembled at runtime. But for
 * the overwhelmingly common case — literal allowedTools arrays — it lets the
 * manifest auto-declare the right capabilities and route through one approval.
 */
function inferCapabilitiesFromScript(script: string): WorkflowCapability[] {
  const inferred = new Set<WorkflowCapability>();
  // Tool names referenced as string literals anywhere in the script.
  const tokens = script.match(/["'`]([a-z_]+)["'`]/g) ?? [];
  for (const raw of tokens) {
    const tool = raw.slice(1, -1);
    const capability = capabilityForAgentTool(tool);
    if (capability) inferred.add(capability);
  }
  // SDK calls that intrinsically need a capability regardless of allowedTools.
  if (
    /workflow\s*\.\s*(createWorktree|diffWorktree|mergeWorktree|removeWorktree)\s*\(/.test(
      script,
    )
  ) {
    inferred.add("worktree");
  }
  if (/workflow\s*\.\s*fetchUrl\s*\(/.test(script)) inferred.add("network");
  if (/workflow\s*\.\s*askUser\s*\(/.test(script)) inferred.add("ask_user");
  if (/workflow\s*\.\s*(callTool|listTools|searchTools)\s*\(/.test(script))
    inferred.add("mcp");
  return Array.from(inferred);
}

export interface WorkflowScriptIssue {
  code: string;
  message: string;
  fix: string;
}

/**
 * Filter + detail-trim MCP tool descriptors for progressive disclosure. Shared
 * by the in-process and worker SDKs so search semantics stay identical.
 */
function filterMcpToolsForSearch(
  tools: WorkflowMcpToolDescriptor[],
  input: WorkflowSearchToolsInput | undefined,
): WorkflowMcpToolDescriptor[] {
  const query = (input?.query ?? "").trim().toLowerCase();
  const detail = input?.detailLevel ?? "summary";
  const limit = Math.max(1, Math.min(Math.floor(input?.limit ?? 20), 100));
  const matched = tools.filter((tool) => {
    if (!query) return true;
    const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
    return haystack.includes(query);
  });
  return matched.slice(0, limit).map((tool) => {
    if (detail === "name") {
      return { serverId: tool.serverId, name: tool.name };
    }
    if (detail === "summary") {
      return {
        serverId: tool.serverId,
        name: tool.name,
        description: tool.description,
      };
    }
    return tool; // "full" includes inputSchema
  });
}

/**
 * Static "validate-then-run" pre-flight on a workflow harness, run BEFORE the
 * worker executes it. The goal is to fail fast with structured, actionable
 * guidance the model can act on (Claude 4 is a strong self-debugger when given a
 * clear reason) instead of producing an opaque runtime crash deep in a run.
 *
 * Heuristic, not a sandbox: the vm worker is still the real security boundary.
 * We only flag patterns that are almost always mistakes in this environment.
 */
export function validateWorkflowScript(
  script: string,
  options?: { maxChars?: number },
): WorkflowScriptIssue[] {
  const issues: WorkflowScriptIssue[] = [];
  const text = script ?? "";

  if (!text.trim()) {
    issues.push({
      code: "empty_script",
      message: "The workflow script is empty.",
      fix: "Provide an async harness body, or pass skillRef to run a saved skill.",
    });
    return issues;
  }

  const maxChars = options?.maxChars ?? MAX_SCRIPT_CHARS;
  if (text.length > maxChars) {
    issues.push({
      code: "too_long",
      message: `Script is ${text.length} chars, over the ${maxChars} limit.`,
      fix: "Split into a saved skill/template and reuse via skillRef/templateId, or move large prompts/data into spawnAgent calls instead of inlining them.",
    });
  } else if (text.length > maxChars * 0.85) {
    issues.push({
      code: "near_length_limit",
      message: `Script is ${text.length} chars, close to the ${maxChars} limit and at risk of truncation.`,
      fix: "Shorten the harness: reuse a saved skill/template, factor repeated logic, and keep large content inside spawnAgent prompts rather than the harness body.",
    });
  }

  const markdownFenceHits = findMarkdownFenceOutsideJavaScript(text);
  if (markdownFenceHits.length > 0) {
    const completeBlocks = parseMarkdownCodeBlocks(text);
    const partialFence =
      markdownFenceHits.length % 2 === 1 || completeBlocks.length === 0;
    issues.push({
      code: partialFence ? "partial_markdown_fence" : "markdown_wrapper_invalid",
      message: partialFence
        ? "Script contains an incomplete Markdown code fence outside JavaScript strings/comments."
        : "Script mixes Markdown wrapper text/code fences with the JavaScript harness body.",
      fix: partialFence
        ? "Finish or remove the Markdown fence. For large scripts, save the harness in chunks with save_workflow_script_draft, read it back, then run via draftRef."
        : "Pass only the JavaScript async function body in script, or one complete JavaScript fenced block. Do not include explanatory Markdown around the tool argument.",
    });
  }

  const firstLine =
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? "";
  if (
    /^(#{1,6}\s|[-*]\s|\d+[.)]\s|(?:plan|outline|steps?)\s*:)/i.test(firstLine)
  ) {
    issues.push({
      code: "not_javascript_body",
      message:
        "Script looks like a Markdown plan/list, not executable JavaScript.",
      fix: "Generate the actual workflow harness body using workflow.spawnAgent/workflow.parallel/workflow.artifact, not a prose plan.",
    });
  }

  const trimmed = text.trim();
  if (
    trimmed.startsWith("{") &&
    /"(?:objective|rationale|script|skillRef)"\s*:/.test(trimmed)
  ) {
    issues.push({
      code: "json_tool_arguments",
      message:
        "Script looks like the full run_workflow_script JSON arguments object, not the JavaScript harness body.",
      fix: "Pass only the JavaScript async harness body in the script field. If the JSON arguments were truncated, retry with skillRef or a shorter saved workflow skill instead of re-emitting the whole object.",
    });
  }

  // Forbidden host APIs. The worker has no module system / fs / network, so these
  // are guaranteed runtime failures; flag them early with the right alternative.
  const forbidden: Array<{ re: RegExp; name: string; fix: string }> = [
    {
      re: /\brequire\s*\(/,
      name: "require()",
      fix: "Modules are unavailable. Use the workflow SDK; do external work via workflow.spawnAgent.",
    },
    {
      re: /\bimport\s+[^;]*from\b|\bimport\s*\(/,
      name: "import",
      fix: "Modules are unavailable. Use the workflow SDK only.",
    },
    {
      re: /\bprocess\s*\./,
      name: "process",
      fix: "process is unavailable in the workflow sandbox. Remove it.",
    },
    {
      re: /\b(require\s*\(\s*["']fs["']\)|\bfs\s*\.\s*(readFile|writeFile|readdir|mkdir))/,
      name: "fs",
      fix: "Filesystem APIs are unavailable. Have a spawnAgent write files via its tools, then read artifacts.",
    },
    {
      re: /\bfetch\s*\(/,
      name: "fetch()",
      fix: "Global fetch is unavailable. Request the network capability and call workflow.fetchUrl instead.",
    },
    {
      re: /\beval\s*\(/,
      name: "eval()",
      fix: "eval is forbidden. Express logic directly in the harness.",
    },
    {
      re: /\bnew\s+Function\s*\(/,
      name: "new Function()",
      fix: "Dynamic code generation is forbidden. Express logic directly.",
    },
    {
      re: /\bchild_process\b/,
      name: "child_process",
      fix: "Spawning processes is forbidden. Request the shell capability and pass bash to a spawnAgent.",
    },
  ];
  for (const { re, name, fix } of forbidden) {
    if (re.test(text)) {
      issues.push({
        code: "forbidden_api",
        message: `Script uses forbidden host API: ${name}.`,
        fix,
      });
    }
  }

  // Unbalanced braces/parens are a strong, low-false-positive signal that a
  // large tool call was truncated mid-script (the classic stopReason:length
  // failure mode). Only flag a clear deficit, never a surplus.
  const opens = (text.match(/[{([]/g) ?? []).length;
  const closes = (text.match(/[)\]}]/g) ?? []).length;
  if (opens - closes >= 2) {
    issues.push({
      code: "likely_truncated",
      message: `Script has ${opens} opening vs ${closes} closing brackets — it looks truncated mid-statement.`,
      fix: "The harness was likely cut off (output length limit). Shorten it, or save it as a skill and run via skillRef so you don't re-emit a large script.",
    });
  }

  return issues;
}

type RequireSuccessOptions = {
  minSuccess?: number;
  label?: string;
};

/**
 * Quality gate for spawnAgent result batches. A workflow that fans out N agents
 * and then synthesizes their output should not silently proceed when most of
 * those agents failed (the classic "5/5 review failed but synthesis continues"
 * trap). requireSuccess throws with a readable summary when fewer than
 * `minSuccess` results have status === "completed". Defaults to requiring all.
 *
 * Shared shape so the in-process SDK and the worker-child SDK stay in lockstep.
 */
function evaluateRequireSuccess(
  results: unknown,
  options: RequireSuccessOptions | undefined,
): unknown[] {
  if (!Array.isArray(results)) {
    throw new Error("workflow.requireSuccess requires an array of results");
  }
  const label = options?.label ? `${options.label}: ` : "";
  const total = results.length;
  const minSuccess = Math.max(
    0,
    Math.min(Math.floor(options?.minSuccess ?? total), total),
  );
  const succeeded: unknown[] = [];
  const failures: string[] = [];
  for (let i = 0; i < total; i += 1) {
    const entry = results[i] as
      | { status?: string; title?: string; taskId?: string; answer?: string }
      | null
      | undefined;
    const status = entry?.status;
    if (status === "completed") {
      succeeded.push(entry);
      continue;
    }
    const who = entry?.title || entry?.taskId || `#${i}`;
    failures.push(`${who} (${status ?? "unknown"})`);
  }
  if (succeeded.length < minSuccess) {
    throw new Error(
      `${label}workflow.requireSuccess gate failed: ${succeeded.length}/${total} succeeded, ` +
        `need at least ${minSuccess}. Failed: ${failures.join(", ") || "n/a"}`,
    );
  }
  return succeeded;
}

function makeTimeout(
  controller: AbortController,
  timeoutMs: number,
): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error(`Workflow script timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    controller.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Workflow script aborted"));
      },
      { once: true },
    );
  });
}

function normalizeFetchHeaders(raw: Record<string, string> | undefined) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw ?? {})) {
    const lower = key.toLowerCase();
    if (
      lower === "authorization" ||
      lower === "cookie" ||
      lower === "set-cookie" ||
      lower === "proxy-authorization"
    ) {
      throw new Error(
        `workflow.fetchUrl does not allow sensitive header: ${key}`,
      );
    }
    if (!/^[a-zA-Z0-9_.:-]+$/.test(key)) {
      throw new Error(`workflow.fetchUrl invalid header name: ${key}`);
    }
    headers.set(key.slice(0, 80), String(value).slice(0, 2000));
  }
  return headers;
}

function isPrivateOrLocalHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

function isPrivateOrLocalIp(address: string): boolean {
  const lower = address.toLowerCase();
  if (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fe80:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd")
  ) {
    return true;
  }
  if (lower.startsWith("::ffff:")) {
    return isPrivateOrLocalIp(lower.slice("::ffff:".length));
  }
  const parts = lower.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function assertPublicHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("workflow.fetchUrl only supports http(s) URLs");
  }
  const host = url.hostname.toLowerCase();
  if (isPrivateOrLocalHostname(host) || isPrivateOrLocalIp(host)) {
    throw new Error(
      "workflow.fetchUrl does not allow localhost or private-network URLs",
    );
  }
  return url;
}

async function defaultResolveFetchHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: false });
  return records.map((record) => record.address);
}

async function assertPublicDnsResolution(
  url: URL,
  resolveHost: (host: string) => Promise<string[]>,
): Promise<void> {
  const host = url.hostname.toLowerCase();
  if (isPrivateOrLocalIp(host)) return;
  const addresses = await resolveHost(host);
  if (addresses.some((address) => isPrivateOrLocalIp(address))) {
    throw new Error(
      "workflow.fetchUrl does not allow URLs that resolve to localhost or private-network addresses",
    );
  }
}

function normalizeOriginRule(rule: string): string {
  const cleaned = cleanText(rule, 500).toLowerCase().replace(/\/+$/, "");
  if (!cleaned) return "";
  try {
    return new URL(cleaned).origin.toLowerCase();
  } catch {
    return cleaned;
  }
}

function originMatches(rules: string[] | undefined, url: URL): boolean {
  const candidates = new Set([
    url.origin.toLowerCase(),
    url.host.toLowerCase(),
    url.hostname.toLowerCase(),
  ]);
  return (rules ?? [])
    .map(normalizeOriginRule)
    .filter(Boolean)
    .some((rule) => candidates.has(rule));
}

function wildcardPatternMatches(pattern: string, value: string): boolean {
  const cleaned = cleanText(pattern, 1000);
  if (!cleaned) return false;
  const escaped = cleaned
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function urlPatternMatches(patterns: string[] | undefined, url: URL): boolean {
  const value = url.toString();
  return (patterns ?? []).some((pattern) =>
    wildcardPatternMatches(pattern, value),
  );
}

function assertNetworkPolicyAllows(
  input: WorkflowFetchUrlInput,
  url: URL,
  policy: WorkflowNetworkPolicy | undefined,
): void {
  if (!policy) return;
  const method = input.method === "POST" ? "POST" : "GET";
  if (
    Array.isArray(policy.allowedMethods) &&
    policy.allowedMethods.length > 0 &&
    !policy.allowedMethods.includes(method)
  ) {
    throw new Error(
      `workflow.fetchUrl network policy does not allow method: ${method}`,
    );
  }
  if (originMatches(policy.deniedOrigins, url)) {
    throw new Error(
      `workflow.fetchUrl network policy denies origin: ${url.origin}`,
    );
  }
  if (urlPatternMatches(policy.deniedUrlPatterns, url)) {
    throw new Error(
      `workflow.fetchUrl network policy denies URL: ${url.toString()}`,
    );
  }
  const hasAllowRules =
    (policy.allowedOrigins?.length ?? 0) > 0 ||
    (policy.allowedUrlPatterns?.length ?? 0) > 0;
  if (
    hasAllowRules &&
    !originMatches(policy.allowedOrigins, url) &&
    !urlPatternMatches(policy.allowedUrlPatterns, url)
  ) {
    throw new Error(
      `workflow.fetchUrl network policy does not allow URL: ${url.toString()}`,
    );
  }
}

async function assertFetchRequestAllowed(
  input: WorkflowFetchUrlInput,
  policy: WorkflowNetworkPolicy | undefined,
  resolveHost: (host: string) => Promise<string[]>,
): Promise<URL> {
  const url = assertPublicHttpUrl(cleanText(input.url, 2000));
  assertNetworkPolicyAllows(input, url, policy);
  await assertPublicDnsResolution(url, resolveHost);
  return url;
}

async function defaultFetchUrl(
  input: WorkflowFetchUrlInput,
  signal: AbortSignal,
  resolveHost: (host: string) => Promise<string[]> = defaultResolveFetchHost,
  policy?: WorkflowNetworkPolicy,
): Promise<WorkflowFetchUrlResult> {
  const url = await assertFetchRequestAllowed(input, policy, resolveHost);
  const method = input.method === "POST" ? "POST" : "GET";
  const maxBytes = Math.max(
    1,
    Math.min(
      Math.floor(input.maxBytes ?? DEFAULT_FETCH_MAX_BYTES),
      HARD_FETCH_MAX_BYTES,
    ),
  );
  const body = method === "POST" ? cleanText(input.body, 64 * 1024) : undefined;
  const response = await fetch(url.toString(), {
    method,
    headers: normalizeFetchHeaders(input.headers),
    body,
    signal,
    redirect: "follow",
  });
  const contentType = response.headers.get("content-type") ?? undefined;
  const text = await response.text();
  const truncated = text.length > maxBytes;
  return {
    url: response.url,
    status: response.status,
    ok: response.ok,
    statusText: response.statusText,
    contentType,
    text: truncated ? text.slice(0, maxBytes) : text,
    truncated,
  };
}

function createSdk(
  deps: RunWorkflowScriptDeps,
  input: RunWorkflowScriptInput,
  manifest: WorkflowManifest,
  workflowId: string,
  signal: AbortSignal,
  artifacts: Map<string, WorkflowArtifact>,
  checkpoints: WorkflowCheckpoint[],
  logs: WorkflowScriptLog[],
  traceEvents: WorkflowTraceEvent[],
  resumeState?: WorkflowResumeState,
): WorkflowSdk {
  let spawnedAgents = 0;
  const createdWorktrees = new Map<string, WorkflowWorktree>();

  function pushLog(level: WorkflowScriptLog["level"], message: string) {
    const log = {
      level,
      message: cleanText(message, 4000),
      createdAt: now(),
    };
    logs.push(log);
    appendWorkflowLog(workflowId, log);
    deps.onEvent?.({ type: "workflow_log", workflowId, log });
  }

  function pushTrace(trace: WorkflowTraceEvent) {
    traceEvents.push(trace);
    appendWorkflowTraceEvent(workflowId, trace);
    deps.onEvent?.({ type: "workflow_trace", workflowId, trace });
  }

  async function runSpawnAgent(agentInput: WorkflowSpawnAgentInput) {
    if (signal.aborted) throw new Error("Workflow script aborted");
    requireCapability(manifest, "spawn_agent");
    spawnedAgents += 1;
    if (spawnedAgents > manifest.maxAgents) {
      throw new Error(
        `workflow.spawnAgent exceeded manifest maxAgents=${manifest.maxAgents}`,
      );
    }
    const title = cleanText(agentInput.title, 120);
    const prompt = cleanText(agentInput.prompt, 12000);
    if (!title) throw new Error("workflow.spawnAgent requires a title");
    if (!prompt) throw new Error("workflow.spawnAgent requires a prompt");
    const allowedTools = safeAllowedTools(manifest, agentInput.allowedTools);
    if (allowedTools.normalized.length > 0) {
      pushLog(
        "warn",
        `normalized child agent tools: ${allowedTools.normalized.join(", ")}`,
      );
    }
    const { results } = await deps.runSubagents(
      {
        reason: [
          input.rationale,
          `Workflow ${workflowId} spawned agent: ${title}`,
        ].join("\n"),
        concurrency: 1,
        tasks: [
          {
            id: cleanText(agentInput.id, 80) || title,
            title,
            prompt: [`Workflow objective: ${input.objective}`, prompt].join(
              "\n\n",
            ),
            role: agentInput.role,
            cwd: agentInput.cwd,
            allowedTools: allowedTools.tools,
            maxTurns: agentInput.maxTurns,
            timeoutMs: agentInput.timeoutMs,
          },
        ],
      },
      signal,
    );
    const result = results[0];
    if (!result) throw new Error(`No subagent result returned for ${title}`);
    return {
      ...result,
      // Workflow scripts are often written against workflow.agent(), whose
      // result exposes `text`. Keep spawnAgent ergonomic without changing the
      // canonical SubagentResult.answer field.
      text: result.answer ?? "",
      output: result.answer ?? "",
      summary: result.answer ?? "",
    };
  }

  return Object.freeze({
    workflowId,
    objective: input.objective,
    capabilities: Object.freeze(manifest.capabilities.slice()),
    resume: resumeState ? Object.freeze({ ...resumeState }) : undefined,

    log(message: string) {
      pushLog("info", message);
    },

    warn(message: string) {
      pushLog("warn", message);
    },

    error(message: string) {
      pushLog("error", message);
    },

    checkpoint(name: string, value: unknown) {
      const checkpoint = {
        name: cleanText(name, 160),
        value,
        createdAt: now(),
      };
      checkpoints.push(checkpoint);
      appendWorkflowCheckpoint(workflowId, checkpoint);
      deps.onEvent?.({ type: "workflow_checkpoint", workflowId, checkpoint });
      return value;
    },

    artifact(name: string, value: unknown) {
      const artifact = {
        name: cleanText(name, 160),
        value,
        createdAt: now(),
      };
      artifacts.set(artifact.name, artifact);
      putWorkflowArtifact(workflowId, artifact);
      deps.onEvent?.({ type: "workflow_artifact", workflowId, artifact });
      return value;
    },

    readArtifact(name: string) {
      return artifacts.get(name)?.value;
    },

    listArtifacts() {
      return Array.from(artifacts.values());
    },

    async createWorktree(worktreeInput?: WorkflowCreateWorktreeInput) {
      if (signal.aborted) throw new Error("Workflow script aborted");
      requireCapability(manifest, "worktree");
      if (!deps.worktrees) {
        throw new Error("workflow.createWorktree requires a worktree runtime");
      }
      const worktree = await deps.worktrees.create({
        workflowId,
        name: cleanText(worktreeInput?.name, 80) || undefined,
        baseRef: cleanText(worktreeInput?.baseRef, 160) || undefined,
      });
      createdWorktrees.set(worktree.id, worktree);
      const value = {
        id: worktree.id,
        path: worktree.path,
        branchName: worktree.branchName,
        baseRef: worktree.baseRef,
      };
      const artifact = {
        name: `worktree:${worktree.id}`,
        value,
        createdAt: worktree.createdAt,
      };
      artifacts.set(artifact.name, artifact);
      putWorkflowArtifact(workflowId, artifact);
      deps.onEvent?.({ type: "workflow_artifact", workflowId, artifact });
      return worktree;
    },

    async diffWorktree(worktree: WorkflowWorktree) {
      if (signal.aborted) throw new Error("Workflow script aborted");
      requireCapability(manifest, "worktree");
      if (!deps.worktrees?.diff) {
        throw new Error(
          "workflow.diffWorktree requires a diff-capable worktree runtime",
        );
      }
      const known = createdWorktrees.get(worktree.id);
      if (!known || known.path !== worktree.path) {
        throw new Error(
          "workflow.diffWorktree can only diff worktrees created by this workflow",
        );
      }
      const diff = await deps.worktrees.diff(known);
      const artifact = {
        name: `worktree-diff:${known.id}`,
        value: {
          worktreeId: diff.worktreeId,
          path: diff.path,
          branchName: diff.branchName,
          baseRef: diff.baseRef,
          stat: diff.stat,
          diff: diff.diff,
        },
        createdAt: diff.createdAt,
      };
      artifacts.set(artifact.name, artifact);
      putWorkflowArtifact(workflowId, artifact);
      deps.onEvent?.({ type: "workflow_artifact", workflowId, artifact });
      return diff;
    },

    async mergeWorktree(worktree: WorkflowWorktree) {
      if (signal.aborted) throw new Error("Workflow script aborted");
      requireCapability(manifest, "worktree");
      requireCapability(manifest, "write_files");
      if (!deps.worktrees?.merge) {
        throw new Error(
          "workflow.mergeWorktree requires a merge-capable worktree runtime",
        );
      }
      if (!deps.worktrees.diff) {
        throw new Error(
          "workflow.mergeWorktree requires a diff-capable worktree runtime for merge approval",
        );
      }
      const known = createdWorktrees.get(worktree.id);
      if (!known || known.path !== worktree.path) {
        throw new Error(
          "workflow.mergeWorktree can only merge worktrees created by this workflow",
        );
      }
      const diff = await deps.worktrees.diff(known);
      const diffArtifact = {
        name: `worktree-diff:${known.id}`,
        value: {
          worktreeId: diff.worktreeId,
          path: diff.path,
          branchName: diff.branchName,
          baseRef: diff.baseRef,
          stat: diff.stat,
          diff: diff.diff,
        },
        createdAt: diff.createdAt,
      };
      artifacts.set(diffArtifact.name, diffArtifact);
      putWorkflowArtifact(workflowId, diffArtifact);
      deps.onEvent?.({
        type: "workflow_artifact",
        workflowId,
        artifact: diffArtifact,
      });
      if (diff.diff.trim()) {
        if (!deps.approveWorktreeMerge) {
          throw new Error(
            "workflow.mergeWorktree requires merge approval before applying a diff",
          );
        }
        const resp = await deps.approveWorktreeMerge({
          workflowId,
          manifest,
          objective: input.objective,
          rationale: input.rationale,
          worktree: known,
          diff,
        });
        if (resp.decision !== "allow") {
          throw new Error(resp.denyReason ?? "Workflow worktree merge denied");
        }
      }
      try {
        const merge = await deps.worktrees.merge(known);
        const artifact = {
          name: `worktree-merge:${known.id}`,
          value: merge,
          createdAt: merge.mergedAt,
        };
        artifacts.set(artifact.name, artifact);
        putWorkflowArtifact(workflowId, artifact);
        deps.onEvent?.({ type: "workflow_artifact", workflowId, artifact });
        return merge;
      } catch (error) {
        const failedAt = now();
        const failureArtifact = {
          name: `worktree-merge-failed:${known.id}`,
          value: {
            worktreeId: known.id,
            path: known.path,
            branchName: known.branchName,
            baseRef: known.baseRef,
            failedAt,
            error: serializeError(error),
            stat: diff.stat,
            diffPreview: diff.diff.slice(0, 12000),
            truncated: diff.diff.length > 12000,
          },
          createdAt: failedAt,
        };
        artifacts.set(failureArtifact.name, failureArtifact);
        putWorkflowArtifact(workflowId, failureArtifact);
        deps.onEvent?.({
          type: "workflow_artifact",
          workflowId,
          artifact: failureArtifact,
        });
        throw error;
      }
    },

    async removeWorktree(worktree: WorkflowWorktree) {
      if (signal.aborted) throw new Error("Workflow script aborted");
      requireCapability(manifest, "worktree");
      if (!deps.worktrees?.remove) {
        throw new Error(
          "workflow.removeWorktree requires a removable worktree runtime",
        );
      }
      const known = createdWorktrees.get(worktree.id);
      if (!known || known.path !== worktree.path) {
        throw new Error(
          "workflow.removeWorktree can only remove worktrees created by this workflow",
        );
      }
      await deps.worktrees.remove(known);
      createdWorktrees.delete(known.id);
    },

    async askUser(askInput: WorkflowAskUserInput) {
      if (signal.aborted) throw new Error("Workflow script aborted");
      requireCapability(manifest, "ask_user");
      if (!deps.askUser) {
        throw new Error(
          "workflow.askUser requires a user clarification runtime",
        );
      }
      const options = Array.isArray(askInput.options)
        ? askInput.options.slice(0, 4).map((option, index) => ({
            id: cleanText(option.id, 80) || undefined,
            label: cleanText(option.label, 80) || `Option ${index + 1}`,
            description: cleanText(option.description, 200) || undefined,
            value: cleanText(option.value, 1000) || undefined,
          }))
        : [];
      if (options.length === 0) {
        throw new Error("workflow.askUser requires at least one option");
      }
      return deps.askUser({
        workflowId,
        manifest,
        objective: input.objective,
        rationale: input.rationale,
        input: {
          title: cleanText(askInput.title, 100) || undefined,
          question: cleanText(askInput.question, 800),
          context: cleanText(askInput.context, 1000) || undefined,
          options,
          recommendedOptionId:
            cleanText(askInput.recommendedOptionId, 80) || undefined,
        },
      });
    },

    async fetchUrl(fetchInput: WorkflowFetchUrlInput) {
      if (signal.aborted) throw new Error("Workflow script aborted");
      requireCapability(manifest, "network");
      const fetchRequest: WorkflowFetchUrlInput = {
        url: cleanText(fetchInput.url, 2000),
        method: fetchInput.method === "POST" ? "POST" : "GET",
        headers: fetchInput.headers,
        body: fetchInput.body,
        maxBytes: fetchInput.maxBytes,
      };
      if (!fetchRequest.url)
        throw new Error("workflow.fetchUrl requires a url");
      if (!deps.approveNetworkRequest) {
        throw new Error(
          "workflow.fetchUrl requires per-request network approval",
        );
      }
      const method = fetchRequest.method ?? "GET";
      const resp = await deps.approveNetworkRequest({
        workflowId,
        manifest,
        objective: input.objective,
        rationale: input.rationale,
        input: fetchRequest,
      });
      if (resp.decision !== "allow") {
        appendWorkflowNetworkAudit({
          workflowId,
          url: fetchRequest.url,
          method,
          outcome: "denied",
          reason: resp.denyReason ?? "Workflow network request denied by user",
        });
        pushLog(
          "warn",
          `[network] denied by user: ${method} ${fetchRequest.url} (${resp.denyReason ?? "no reason"})`,
        );
        throw new Error(resp.denyReason ?? "Workflow network request denied");
      }
      try {
        if (deps.fetchUrl) {
          await assertFetchRequestAllowed(
            fetchRequest,
            deps.networkPolicy,
            deps.resolveFetchHost ?? defaultResolveFetchHost,
          );
        }
        const result = deps.fetchUrl
          ? await deps.fetchUrl(fetchRequest, signal)
          : await defaultFetchUrl(
              fetchRequest,
              signal,
              deps.resolveFetchHost,
              deps.networkPolicy,
            );
        pushLog(
          "info",
          `[network] fetched: ${method} ${fetchRequest.url} -> ${result.status} ${result.statusText}`,
        );
        appendWorkflowNetworkAudit({
          workflowId,
          url: fetchRequest.url,
          method,
          outcome: "allowed",
          status: result.status,
          reason: result.statusText,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushLog(
          "warn",
          `[network] blocked or failed: ${method} ${fetchRequest.url} (${message})`,
        );
        appendWorkflowNetworkAudit({
          workflowId,
          url: fetchRequest.url,
          method,
          outcome: "failed",
          reason: message,
        });
        throw error;
      }
    },

    async listTools(serverId?: string): Promise<WorkflowMcpToolDescriptor[]> {
      if (signal.aborted) throw new Error("Workflow script aborted");
      requireCapability(manifest, "mcp");
      if (!deps.listMcpTools) {
        throw new Error("workflow.listTools requires an MCP runtime");
      }
      const requested = cleanText(serverId, 120) || undefined;
      if (requested && !isServerInScope(deps.allowedMcpServers, requested)) {
        throw new Error(
          `workflow.listTools: MCP server "${requested}" is not in this workflow's scope`,
        );
      }
      const tools = await deps.listMcpTools(requested);
      // Defense-in-depth: even when no serverId was given, the broker already
      // scopes to allowedMcpServers; filter again so a scope leak can't slip a
      // tool through.
      return tools.filter((tool) =>
        isServerInScope(deps.allowedMcpServers, tool.serverId),
      );
    },

    async searchTools(
      searchInput?: WorkflowSearchToolsInput,
    ): Promise<WorkflowMcpToolDescriptor[]> {
      if (signal.aborted) throw new Error("Workflow script aborted");
      requireCapability(manifest, "mcp");
      if (!deps.listMcpTools) {
        throw new Error("workflow.searchTools requires an MCP runtime");
      }
      const requested = cleanText(searchInput?.serverId, 120) || undefined;
      if (requested && !isServerInScope(deps.allowedMcpServers, requested)) {
        throw new Error(
          `workflow.searchTools: MCP server "${requested}" is not in this workflow's scope`,
        );
      }
      const tools = (await deps.listMcpTools(requested)).filter((tool) =>
        isServerInScope(deps.allowedMcpServers, tool.serverId),
      );
      return filterMcpToolsForSearch(tools, searchInput);
    },

    async callTool(
      toolInput: WorkflowCallToolInput,
    ): Promise<WorkflowCallToolResult> {
      if (signal.aborted) throw new Error("Workflow script aborted");
      requireCapability(manifest, "mcp");
      if (!deps.callMcpTool) {
        throw new Error("workflow.callTool requires an MCP runtime");
      }
      const server = cleanText(toolInput?.server, 120);
      const tool = cleanText(toolInput?.tool, 200);
      if (!server) throw new Error("workflow.callTool requires a server id");
      if (!tool) throw new Error("workflow.callTool requires a tool name");
      if (!isServerInScope(deps.allowedMcpServers, server)) {
        throw new Error(
          `workflow.callTool: MCP server "${server}" is not in this workflow's scope`,
        );
      }
      const callRequest: WorkflowCallToolInput = {
        server,
        tool,
        input:
          toolInput?.input && typeof toolInput.input === "object"
            ? (toolInput.input as Record<string, unknown>)
            : {},
      };
      // Every MCP call surfaces an approval, mirroring fetchUrl: the worker can
      // never call an MCP tool without an explicit user (or policy) decision.
      if (!deps.approveMcpTool) {
        throw new Error("workflow.callTool requires per-call MCP approval");
      }
      const resp = await deps.approveMcpTool({
        workflowId,
        manifest,
        objective: input.objective,
        rationale: input.rationale,
        input: callRequest,
      });
      if (resp.decision !== "allow") {
        pushLog(
          "warn",
          `[mcp] denied by user: ${server}/${tool} (${resp.denyReason ?? "no reason"})`,
        );
        throw new Error(resp.denyReason ?? "Workflow MCP tool call denied");
      }
      const result = await deps.callMcpTool(callRequest);
      pushLog(
        "info",
        `[mcp] called: ${server}/${tool} -> ${result.isError ? "error" : "ok"}`,
      );
      return result;
    },

    async agent<T = unknown>(
      prompt: string,
      agentInput?: Omit<WorkflowAgentInput, "prompt">,
    ): Promise<WorkflowAgentResult<T>> {
      if (signal.aborted) throw new Error("Workflow script aborted");
      const title = cleanText(agentInput?.title, 120) || "Workflow agent";
      const agentRunId =
        cleanText(agentInput?.id, 80) || `${title}-${spawnedAgents + 1}`;
      const agentType = agentInput?.agentType;
      const role = roleForAgentType(agentType);
      const isolation = agentInput?.isolation ?? "none";
      if (agentInput?.model) {
        throw new Error("workflow.agent model routing is not implemented yet");
      }
      let worktree: WorkflowWorktree | undefined;
      let cwd = cleanText(agentInput?.cwd, 1000) || undefined;
      if (isolation === "worktree") {
        requireCapability(manifest, "worktree");
        worktree = await this.createWorktree({ name: title });
        cwd = worktree.path;
      }
      const schema = agentInput?.schema;
      const fullPrompt = [prompt, schema ? schemaInstruction(schema) : ""]
        .filter(Boolean)
        .join("\n\n");
      pushTrace({
        type: "agent_start",
        workflowId,
        agentRunId,
        title,
        agentType,
        role,
        model: agentInput?.model,
        isolation,
        createdAt: now(),
      });
      let schemaValid: boolean | undefined;
      try {
        const result = await runSpawnAgent({
          id: agentRunId,
          title,
          prompt: fullPrompt,
          role,
          cwd,
          allowedTools: agentInput?.tools ?? agentInput?.allowedTools,
          maxTurns: agentInput?.maxTurns,
          timeoutMs: agentInput?.timeoutMs,
        });
        const text = result.answer ?? "";
        let data: T | undefined;
        const localArtifacts: WorkflowArtifact[] = [];
        if (schema) {
          let parsed: unknown;
          try {
            parsed = extractWorkflowJsonValue(text);
          } catch (error) {
            const errors = [serializeError(error)];
            schemaValid = false;
            const trace: WorkflowTraceEvent = {
              type: "schema_validation",
              workflowId,
              agentRunId,
              valid: false,
              errors,
              createdAt: now(),
            };
            pushTrace(trace);
            const artifact: WorkflowArtifact = {
              name: `schema-output:${agentRunId}`,
              value: {
                valid: false,
                data: null,
                errors,
                parseError: true,
                rawPreview: cleanText(text, 1000),
              },
              kind: "schema_output",
              createdAt: trace.createdAt,
            };
            artifacts.set(artifact.name, artifact);
            localArtifacts.push(artifact);
            putWorkflowArtifact(workflowId, artifact);
            deps.onEvent?.({ type: "workflow_artifact", workflowId, artifact });
            throw new Error(
              `workflow.agent schema JSON parse failed: ${errors[0]}`,
            );
          }
          const errors = validateJsonSchema(parsed, schema);
          schemaValid = errors.length === 0;
          const trace: WorkflowTraceEvent = {
            type: "schema_validation",
            workflowId,
            agentRunId,
            valid: schemaValid,
            errors,
            createdAt: now(),
          };
          pushTrace(trace);
          const artifact: WorkflowArtifact = {
            name: `schema-output:${agentRunId}`,
            value: { valid: schemaValid, data: parsed, errors },
            kind: "schema_output",
            createdAt: trace.createdAt,
          };
          artifacts.set(artifact.name, artifact);
          localArtifacts.push(artifact);
          putWorkflowArtifact(workflowId, artifact);
          deps.onEvent?.({ type: "workflow_artifact", workflowId, artifact });
          if (!schemaValid) {
            throw new Error(
              `workflow.agent schema validation failed: ${errors.join("; ")}`,
            );
          }
          data = parsed as T;
        }
        pushTrace({
          type: "agent_end",
          workflowId,
          agentRunId,
          title,
          status: result.status,
          schemaValid,
          error: result.error,
          createdAt: now(),
        });
        return {
          title,
          status: result.status,
          text,
          data,
          error: result.error,
          taskId: result.taskId,
          agentId: result.agentId,
          worktree,
          artifacts: localArtifacts,
        };
      } catch (error) {
        pushTrace({
          type: "agent_end",
          workflowId,
          agentRunId,
          title,
          status: "failed",
          schemaValid,
          error: serializeError(error),
          createdAt: now(),
        });
        throw error;
      }
    },

    async spawnAgent(agentInput: WorkflowSpawnAgentInput) {
      return runSpawnAgent(agentInput);
    },

    async parallel<T>(items: Array<Promise<T> | (() => Promise<T> | T)>) {
      if (!Array.isArray(items)) {
        throw new Error("workflow.parallel requires an array");
      }
      // maxConcurrency is a concurrency budget, not an array-length cap. Any
      // number of items may be scheduled; at most `maxConcurrency` run at once
      // and the rest queue. Results preserve input order (Promise.all semantics).
      const limit = Math.max(1, manifest.maxConcurrency);
      const total = items.length;
      if (total === 0) return [];

      const results = new Array<T>(total);
      let nextIndex = 0;

      const runWorker = async (): Promise<void> => {
        for (;;) {
          if (signal.aborted) throw new Error("Workflow script aborted");
          const current = nextIndex;
          if (current >= total) return;
          nextIndex += 1;
          const item = items[current];
          results[current] = await (typeof item === "function"
            ? (item as () => Promise<T> | T)()
            : item);
        }
      };

      const workerCount = Math.min(limit, total);
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      return results;
    },

    requireSuccess<T>(
      results: T[],
      options?: { minSuccess?: number; label?: string },
    ) {
      return evaluateRequireSuccess(results, options) as T[];
    },

    async stage<T>(title: string, fn: () => Promise<T> | T) {
      pushLog("info", `stage:start:${cleanText(title, 160)}`);
      try {
        const result = await fn();
        pushLog("info", `stage:end:${cleanText(title, 160)}`);
        return result;
      } catch (err) {
        pushLog(
          "error",
          `stage:failed:${cleanText(title, 160)}:${serializeError(err)}`,
        );
        throw err;
      }
    },

    async sleep(ms: number) {
      const safeMs = Math.max(0, Math.min(Math.floor(ms), 30000));
      await new Promise((resolve) => setTimeout(resolve, safeMs));
    },
  });
}

function sendWorkerMessage(
  child: ChildProcessWithoutNullStreams,
  message: unknown,
): void {
  if (child.stdin.destroyed) return;
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function workerScriptPath(): string {
  const rel = path.join("lib", "workflows", "script-worker-child.cjs");
  const proc = process as NodeJS.Process & { resourcesPath?: string };
  const resourcesPath =
    typeof proc.resourcesPath === "string" ? proc.resourcesPath : undefined;
  const candidates = [
    path.join(process.cwd(), rel),
    path.join(process.cwd(), ".next", "standalone", rel),
    resourcesPath
      ? path.join(
          resourcesPath,
          "app.asar.unpacked",
          ".next",
          "standalone",
          rel,
        )
      : "",
    resourcesPath ? path.join(resourcesPath, "app.asar.unpacked", rel) : "",
    resourcesPath ? path.join(resourcesPath, "app.asar", rel) : "",
  ].filter(Boolean);
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
  );
}

export function buildWorkflowWorkerSpawnConfig(
  options: {
    platform?: NodeJS.Platform;
    execPath?: string;
    workerPath?: string;
    memoryMb?: number;
    cpuSeconds?: number;
    sandboxArgv?: string[];
  } = {},
): {
  command: string;
  args: string[];
  usesPosixCpuLimit: boolean;
  usesExternalSandbox: boolean;
} {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const memoryMb = Math.max(
    16,
    Math.floor(options.memoryMb ?? WORKFLOW_WORKER_MAX_OLD_SPACE_MB),
  );
  const workerPath = options.workerPath ?? workerScriptPath();
  const nodeArgs = [`--max-old-space-size=${memoryMb}`, workerPath];
  const cpuSeconds = Math.floor(
    options.cpuSeconds ?? WORKFLOW_WORKER_CPU_SECONDS,
  );
  let base: {
    command: string;
    args: string[];
    usesPosixCpuLimit: boolean;
  };
  if (platform !== "win32" && cpuSeconds > 0) {
    base = {
      command: "/bin/sh",
      args: [
        "-c",
        'ulimit -t "$1" 2>/dev/null || exit 126; shift; exec "$@"',
        "workflow-worker-launcher",
        String(cpuSeconds),
        execPath,
        ...nodeArgs,
      ],
      usesPosixCpuLimit: true,
    };
  } else {
    base = {
      command: execPath,
      args: nodeArgs,
      usesPosixCpuLimit: false,
    };
  }
  const sandboxArgv = options.sandboxArgv ?? parseWorkflowWorkerSandboxArgv();
  if (sandboxArgv.length === 0) {
    return {
      ...base,
      usesExternalSandbox: false,
    };
  }
  const wrapped = wrapWorkerWithExternalSandbox(sandboxArgv, base);
  return {
    ...wrapped,
    usesPosixCpuLimit: base.usesPosixCpuLimit,
    usesExternalSandbox: true,
  };
}

function parseWorkflowWorkerSandboxArgv(): string[] {
  const raw = process.env.DIGA_AGENT_WORKFLOW_WORKER_SANDBOX_ARGV_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "string" ? item : ""))
      .filter(Boolean)
      .slice(0, 100);
  } catch {
    return [];
  }
}

function wrapWorkerWithExternalSandbox(
  sandboxArgv: string[],
  worker: { command: string; args: string[] },
): { command: string; args: string[] } {
  const expanded: string[] = [];
  let sawCommand = false;
  let sawArgs = false;
  for (const arg of sandboxArgv) {
    if (arg === "{command}") {
      expanded.push(worker.command);
      sawCommand = true;
    } else if (arg === "{args}") {
      expanded.push(...worker.args);
      sawArgs = true;
    } else {
      expanded.push(arg);
    }
  }
  if (!sawCommand) expanded.push(worker.command);
  if (!sawArgs) expanded.push(...worker.args);
  const [command, ...args] = expanded;
  if (!command) {
    return { command: worker.command, args: worker.args };
  }
  return { command, args };
}

async function executeScriptInWorker(args: {
  input: RunWorkflowScriptInput;
  manifest: WorkflowManifest;
  workflowId: string;
  sdk: WorkflowSdk;
  signal: AbortSignal;
  resumeState?: WorkflowResumeState;
}): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const workerSpawn = buildWorkflowWorkerSpawnConfig({
      cpuSeconds: Math.max(
        1,
        Math.min(
          WORKFLOW_WORKER_CPU_SECONDS,
          Math.ceil(args.manifest.timeoutMs / 1000),
        ),
      ),
    });
    const child: ChildProcessWithoutNullStreams = spawnProcess(
      workerSpawn.command,
      workerSpawn.args,
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      },
    );
    const stderr: string[] = [];
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      args.signal.removeEventListener("abort", abortWorker);
      rl.close();
      child.kill("SIGKILL");
      fn();
    };

    const abortWorker = () => {
      settle(() => reject(new Error("Workflow script aborted")));
    };
    args.signal.addEventListener("abort", abortWorker, { once: true });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(String(chunk).slice(0, 4000));
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    const handleRequest = async (message: Record<string, unknown>) => {
      const id = String(message.id ?? "");
      const method = String(message.method ?? "");
      const requestArgs = Array.isArray(message.args) ? message.args : [];
      try {
        let result: unknown;
        if (method === "log") {
          const level = String(requestArgs[0] ?? "info");
          const text = String(requestArgs[1] ?? "");
          if (level === "warn") args.sdk.warn(text);
          else if (level === "error") args.sdk.error(text);
          else args.sdk.log(text);
          result = null;
        } else if (method === "checkpoint") {
          result = args.sdk.checkpoint(
            String(requestArgs[0] ?? ""),
            requestArgs[1],
          );
        } else if (method === "artifact") {
          result = args.sdk.artifact(
            String(requestArgs[0] ?? ""),
            requestArgs[1],
          );
        } else if (method === "createWorktree") {
          result = await args.sdk.createWorktree(
            requestArgs[0] as WorkflowCreateWorktreeInput | undefined,
          );
        } else if (method === "diffWorktree") {
          result = await args.sdk.diffWorktree(
            requestArgs[0] as WorkflowWorktree,
          );
        } else if (method === "mergeWorktree") {
          result = await args.sdk.mergeWorktree(
            requestArgs[0] as WorkflowWorktree,
          );
        } else if (method === "removeWorktree") {
          result = await args.sdk.removeWorktree(
            requestArgs[0] as WorkflowWorktree,
          );
        } else if (method === "askUser") {
          result = await args.sdk.askUser(
            requestArgs[0] as WorkflowAskUserInput,
          );
        } else if (method === "fetchUrl") {
          result = await args.sdk.fetchUrl(
            requestArgs[0] as WorkflowFetchUrlInput,
          );
        } else if (method === "listTools") {
          result = await args.sdk.listTools(
            requestArgs[0] as string | undefined,
          );
        } else if (method === "callTool") {
          result = await args.sdk.callTool(
            requestArgs[0] as WorkflowCallToolInput,
          );
        } else if (method === "agent") {
          result = await args.sdk.agent(
            String(requestArgs[0] ?? ""),
            requestArgs[1] as Omit<WorkflowAgentInput, "prompt"> | undefined,
          );
        } else if (method === "spawnAgent") {
          result = await args.sdk.spawnAgent(
            requestArgs[0] as WorkflowSpawnAgentInput,
          );
        } else {
          throw new Error(`Unsupported workflow worker method: ${method}`);
        }
        sendWorkerMessage(child, { type: "response", id, result });
      } catch (err) {
        sendWorkerMessage(child, {
          type: "response",
          id,
          error: serializeError(err),
        });
      }
    };

    rl.on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        settle(() =>
          reject(
            new Error(`Invalid workflow worker output: ${serializeError(err)}`),
          ),
        );
        return;
      }

      if (message.type === "request") {
        void handleRequest(message);
      } else if (message.type === "done") {
        settle(() => resolve(message.value));
      } else if (message.type === "error") {
        settle(() =>
          reject(new Error(String(message.error ?? "Workflow worker error"))),
        );
      }
    });

    child.on("error", (err: Error) => {
      settle(() => reject(err));
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      const detail = stderr.join("").trim();
      settle(() =>
        reject(
          new Error(
            `Workflow worker exited before completion (code=${code ?? "null"}, signal=${
              signal ?? "null"
            })${detail ? `: ${detail}` : ""}`,
          ),
        ),
      );
    });

    sendWorkerMessage(child, {
      type: "init",
      workflowId: args.workflowId,
      objective: args.input.objective,
      script: args.input.script,
      manifest: args.manifest,
      resume: args.resumeState,
      artifacts: args.sdk.listArtifacts(),
      params: args.input.templateParams,
      template: args.input.templateRef,
    });
  });
}

function loadResumeRun(
  input: RunWorkflowScriptInput,
  parentAgentId: string,
): { run?: WorkflowRun; state?: WorkflowResumeState } {
  const resumeFromWorkflowId = input.resumeFromWorkflowId;
  if (!resumeFromWorkflowId) return {};
  const run = getWorkflowRun(resumeFromWorkflowId);
  if (!run) {
    throw new Error(`resume workflow not found: ${resumeFromWorkflowId}`);
  }
  if (run.parentAgentId !== parentAgentId) {
    throw new Error("resume workflow does not belong to this agent");
  }
  if (run.status === "running") {
    throw new Error("cannot resume from a running workflow");
  }
  if (run.checkpoints.length === 0) {
    throw new Error("cannot resume workflow without checkpoints");
  }
  const requestedCheckpointName = sanitizeCheckpointName(
    input.resumeFromCheckpointName,
  );
  const selectedCheckpoint = requestedCheckpointName
    ? run.checkpoints.find(
        (checkpoint) => checkpoint.name === requestedCheckpointName,
      )
    : run.checkpoints[run.checkpoints.length - 1];
  if (!selectedCheckpoint) {
    throw new Error(
      `resume checkpoint not found in workflow ${resumeFromWorkflowId}: ${requestedCheckpointName}`,
    );
  }
  const state: WorkflowResumeState = {
    fromWorkflowId: run.id,
    objective: run.objective,
    status: run.status,
    lastCheckpoint: selectedCheckpoint,
    checkpointNames: run.checkpoints.map((checkpoint) => checkpoint.name),
    artifactNames: run.artifacts.map((artifact) => artifact.name),
  };
  return { run, state };
}

export async function runWorkflowScript(
  deps: RunWorkflowScriptDeps,
  rawInput: RunWorkflowScriptInput,
  externalSignal?: AbortSignal,
): Promise<WorkflowScriptResult> {
  const normalizedScript = normalizeAndDiagnoseWorkflowScript(
    rawInput.script,
    MAX_SCRIPT_CHARS,
  );
  const input: RunWorkflowScriptInput = {
    objective: cleanText(rawInput.objective, 2000),
    rationale: cleanText(rawInput.rationale, 2000),
    script: normalizedScript.script,
    draftRef: rawInput.draftRef,
    templateParams: rawInput.templateParams,
    templateRef: rawInput.templateRef,
    resumeFromWorkflowId: sanitizeWorkflowId(rawInput.resumeFromWorkflowId),
    resumeFromCheckpointName: sanitizeCheckpointName(
      rawInput.resumeFromCheckpointName,
    ),
    capabilities: rawInput.capabilities,
    maxAgents: rawInput.maxAgents,
    maxConcurrency: rawInput.maxConcurrency,
    timeoutMs: rawInput.timeoutMs,
    successCriteria: rawInput.successCriteria,
  };
  if (!input.objective)
    throw new Error("run_workflow_script requires an objective");
  if (!input.rationale)
    throw new Error("run_workflow_script requires a rationale");
  if (!input.script) throw new Error("run_workflow_script requires a script");

  // P0-4(a): auto-derive capabilities implied by the script BEFORE startup, so
  // they route through the normal approval flow instead of failing each spawned
  // agent at runtime. The declared set is the union of what the model asked for
  // and what the script demonstrably needs.
  const declaredCapabilities = normalizeCapabilities(input.capabilities);
  const inferredCapabilities = inferCapabilitiesFromScript(input.script).filter(
    (capability) => !declaredCapabilities.includes(capability),
  );
  const effectiveCapabilities =
    inferredCapabilities.length > 0
      ? normalizeCapabilities([
          ...declaredCapabilities,
          ...inferredCapabilities,
        ])
      : input.capabilities;
  const manifest = normalizeManifest({
    ...input,
    capabilities: effectiveCapabilities,
  });

  const parentAgentId = deps.parentAgentId ?? "unknown";
  const { run: resumeRun, state: resumeState } = loadResumeRun(
    input,
    parentAgentId,
  );
  const workflowId = randomUUID();
  const startedAt = now();
  const artifacts = new Map<string, WorkflowArtifact>(
    (resumeRun?.artifacts ?? []).map((artifact) => [artifact.name, artifact]),
  );
  // When resuming, surface empty upstream artifacts instead of silently feeding
  // them downstream (the "empty recon.md carried forward" trap).
  const emptyResumedArtifacts = resumeRun
    ? (resumeRun.artifacts ?? [])
        .filter((artifact) => artifactStringValue(artifact.value).length === 0)
        .map((artifact) => artifact.name)
    : [];
  const checkpoints: WorkflowCheckpoint[] =
    resumeRun?.checkpoints.slice() ?? [];
  const logs: WorkflowScriptLog[] = [];
  const traceEvents: WorkflowTraceEvent[] = [];
  const abortController = new AbortController();
  const abortFromExternal = () => abortController.abort();
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  putWorkflowRun(
    {
      id: workflowId,
      parentAgentId,
      objective: input.objective,
      rationale: input.rationale,
      status: "running",
      script: input.script,
      manifest,
      resumedFromWorkflowId: input.resumeFromWorkflowId,
      artifacts: Array.from(artifacts.values()),
      checkpoints,
      logs: [],
      traceEvents: [],
      createdAt: startedAt,
    },
    abortController,
  );
  deps.onEvent?.({
    type: "workflow_start",
    run: {
      id: workflowId,
      parentAgentId,
      objective: input.objective,
      rationale: input.rationale,
      status: "running",
      script: input.script,
      manifest,
      resumedFromWorkflowId: input.resumeFromWorkflowId,
      artifacts: Array.from(artifacts.values()),
      checkpoints,
      logs: [],
      traceEvents: [],
      createdAt: startedAt,
    },
  });
  const pushRuntimeTrace = (trace: WorkflowTraceEvent) => {
    traceEvents.push(trace);
    appendWorkflowTraceEvent(workflowId, trace);
    deps.onEvent?.({ type: "workflow_trace", workflowId, trace });
  };

  try {
    for (const diagnostic of normalizedScript.diagnostics) {
      const log = {
        level: "info" as const,
        message: diagnostic.message,
        createdAt: now(),
      };
      logs.push(log);
      appendWorkflowLog(workflowId, log);
      deps.onEvent?.({ type: "workflow_log", workflowId, log });
    }

    // Validate-then-run: fail fast with structured, actionable guidance before
    // spending a worker run on a script that cannot succeed.
    const issues = validateWorkflowScript(input.script, {
      maxChars: MAX_SCRIPT_CHARS,
    });
    if (issues.length > 0) {
      for (const issue of issues) {
        const log = {
          level: "error" as const,
          message: `validation [${issue.code}]: ${issue.message} Fix: ${issue.fix}`,
          createdAt: now(),
        };
        logs.push(log);
        appendWorkflowLog(workflowId, log);
        deps.onEvent?.({ type: "workflow_log", workflowId, log });
      }
      const summary = issues
        .map((issue) => `- [${issue.code}] ${issue.message} Fix: ${issue.fix}`)
        .join("\n");
      throw new Error(
        `Workflow script validation failed before execution:\n${summary}`,
      );
    }
    if (inferredCapabilities.length > 0) {
      const log = {
        level: "info" as const,
        message: `auto-declared capabilities inferred from script: ${inferredCapabilities.join(", ")}`,
        createdAt: now(),
      };
      logs.push(log);
      appendWorkflowLog(workflowId, log);
      deps.onEvent?.({ type: "workflow_log", workflowId, log });
    }
    if (emptyResumedArtifacts.length > 0) {
      const log = {
        level: "warn" as const,
        message: `resume warning: upstream artifact(s) are empty: ${emptyResumedArtifacts.join(", ")}. Consider re-running the producing stage rather than building on empty inputs.`,
        createdAt: now(),
      };
      logs.push(log);
      appendWorkflowLog(workflowId, log);
      deps.onEvent?.({ type: "workflow_log", workflowId, log });
    }
    await approveManifestCapabilities(
      deps,
      input,
      workflowId,
      manifest,
      pushRuntimeTrace,
    );
    assertRuntimeSupportsCapabilities(manifest);
    const sdk = createSdk(
      deps,
      input,
      manifest,
      workflowId,
      abortController.signal,
      artifacts,
      checkpoints,
      logs,
      traceEvents,
      resumeState,
    );
    const value = await Promise.race([
      executeScriptInWorker({
        input,
        manifest,
        workflowId,
        sdk,
        signal: abortController.signal,
        resumeState,
      }),
      makeTimeout(abortController, manifest.timeoutMs),
    ]);
    const endedAt = now();
    const finalArtifacts = Array.from(artifacts.values());
    // End-state quality gate: a harness that returns normally but fails its
    // declared success criteria is "completed_with_warnings", not "completed".
    const warnings = abortController.signal.aborted
      ? []
      : evaluateSuccessCriteria(manifest.successCriteria, finalArtifacts);
    const status: WorkflowRunStatus = abortController.signal.aborted
      ? "aborted"
      : warnings.length > 0
        ? "completed_with_warnings"
        : "completed";
    for (const warning of warnings) {
      const log = {
        level: "warn" as const,
        message: `end-state check: ${warning}`,
        createdAt: now(),
      };
      logs.push(log);
      appendWorkflowLog(workflowId, log);
      deps.onEvent?.({ type: "workflow_log", workflowId, log });
    }
    finishWorkflowRun(workflowId, {
      status,
      endedAt,
      returnValue: value,
      artifacts: finalArtifacts,
      checkpoints,
      logs,
      traceEvents,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
    deps.onEvent?.({
      type: "workflow_end",
      workflowId,
      status,
      endedAt,
      returnValue: value,
      artifacts: finalArtifacts,
      checkpoints,
      logs,
      traceEvents,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
    return {
      workflowId,
      objective: input.objective,
      status,
      manifest,
      resumedFromWorkflowId: input.resumeFromWorkflowId,
      returnValue: value,
      artifacts: finalArtifacts,
      checkpoints,
      logs,
      traceEvents,
      startedAt,
      endedAt,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (err) {
    const endedAt = now();
    const error = serializeError(err);
    const finalArtifacts = Array.from(artifacts.values());
    const elapsedMs = endedAt - startedAt;
    const hasResumeProgress =
      checkpoints.length > 0 || finalArtifacts.length > 0;
    const likelyTimedOut =
      error.includes("timed out") ||
      (abortController.signal.aborted &&
        elapsedMs >= Math.max(0, manifest.timeoutMs - 1_000));
    const approvalTimedOut = isWorkflowCapabilityApprovalTimeout(error);
    const status: WorkflowRunStatus =
      approvalTimedOut || (likelyTimedOut && hasResumeProgress)
        ? "needs_continue"
        : abortController.signal.aborted
          ? "aborted"
          : "failed";
    const finalError =
      approvalTimedOut
        ? `${error}. Workflow is paused at a capability approval boundary; retry/resume the workflow after approving the required capability instead of restarting from scratch.`
        : status === "needs_continue"
        ? `${error}. Workflow reached its time budget after recording progress; resume from the latest checkpoint to continue.`
        : error;
    if (status === "needs_continue") {
      const log = {
        level: "warn" as const,
        message:
          approvalTimedOut
            ? "workflow needs_continue: capability approval timed out; retry/resume after approving the requested capability."
            : "workflow needs_continue: time budget reached after checkpoint/artifact progress; resume from latest checkpoint.",
        createdAt: endedAt,
      };
      logs.push(log);
      appendWorkflowLog(workflowId, log);
    }
    finishWorkflowRun(workflowId, {
      status,
      endedAt,
      artifacts: finalArtifacts,
      checkpoints,
      logs,
      traceEvents,
      error: finalError,
    });
    deps.onEvent?.({
      type: "workflow_end",
      workflowId,
      status,
      endedAt,
      artifacts: finalArtifacts,
      checkpoints,
      logs,
      error: finalError,
    });
    return {
      workflowId,
      objective: input.objective,
      status,
      manifest,
      resumedFromWorkflowId: input.resumeFromWorkflowId,
      artifacts: finalArtifacts,
      checkpoints,
      logs,
      traceEvents,
      startedAt,
      endedAt,
      error: finalError,
    };
  } finally {
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

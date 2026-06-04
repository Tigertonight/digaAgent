import "server-only";
import { spawn as spawnProcess } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import path from "node:path";
import readline from "node:readline";
import type {
  RunWorkflowScriptDeps,
  RunWorkflowScriptInput,
  WorkflowArtifact,
  WorkflowCheckpoint,
  WorkflowCapability,
  WorkflowManifest,
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
  WorkflowCallToolInput,
  WorkflowCallToolResult,
} from "./types";
import {
  appendWorkflowCheckpoint,
  appendWorkflowLog,
  finishWorkflowRun,
  getWorkflowRun,
  putWorkflowArtifact,
  putWorkflowRun,
} from "./server-store";
import { appendWorkflowNetworkAudit } from "./network-policy";

const DEFAULT_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
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
  "browser_extract",
  "browser_verify",
  "browser_close",
]);
const DEFAULT_CAPABILITIES: WorkflowCapability[] = ["spawn_agent", "read_files"];
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
  createWorktree(input?: WorkflowCreateWorktreeInput): Promise<WorkflowWorktree>;
  diffWorktree(worktree: WorkflowWorktree): Promise<WorkflowWorktreeDiff>;
  mergeWorktree(worktree: WorkflowWorktree): Promise<WorkflowWorktreeMergeResult>;
  removeWorktree(worktree: WorkflowWorktree): Promise<void>;
  askUser(input: WorkflowAskUserInput): Promise<WorkflowAskUserResult>;
  fetchUrl(input: WorkflowFetchUrlInput): Promise<WorkflowFetchUrlResult>;
  listTools(serverId?: string): Promise<WorkflowMcpToolDescriptor[]>;
  callTool(input: WorkflowCallToolInput): Promise<WorkflowCallToolResult>;
  spawnAgent(input: WorkflowSpawnAgentInput): Promise<unknown>;
  parallel<T>(items: Array<Promise<T> | (() => Promise<T> | T)>): Promise<T[]>;
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

function normalizeCapabilities(raw: WorkflowCapability[] | undefined): WorkflowCapability[] {
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
    maxAgents: Math.max(1, Math.min(Math.floor(input.maxAgents ?? DEFAULT_MAX_AGENTS), 32)),
    maxConcurrency: Math.max(
      1,
      Math.min(Math.floor(input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY), 16)
    ),
    timeoutMs: Math.max(
      1000,
      Math.min(input.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS, DEFAULT_SCRIPT_TIMEOUT_MS)
    ),
    runtime: "process",
  };
}

async function approveManifestCapabilities(
  deps: RunWorkflowScriptDeps,
  input: RunWorkflowScriptInput,
  workflowId: string,
  manifest: WorkflowManifest
): Promise<void> {
  const approvalRequired = manifest.capabilities.filter((capability) =>
    APPROVAL_REQUIRED_CAPABILITIES.has(capability)
  );
  if (approvalRequired.length === 0) return;
  if (!deps.approveCapability) {
    throw new Error(
      `Workflow capability approval broker is not implemented for: ${approvalRequired.join(", ")}`
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
    if (resp.decision !== "allow") {
      throw new Error(
        resp.denyReason ?? `Workflow capability denied: ${capability}`
      );
    }
  }
}

function assertRuntimeSupportsCapabilities(manifest: WorkflowManifest): void {
  const unimplemented = manifest.capabilities.filter(
    (capability) => !IMPLEMENTED_CAPABILITIES.has(capability)
  );
  if (unimplemented.length > 0) {
    throw new Error(
      `Workflow runtime support is not implemented for: ${unimplemented.join(", ")}`
    );
  }
}

function hasCapability(manifest: WorkflowManifest, capability: WorkflowCapability): boolean {
  return manifest.capabilities.includes(capability);
}

function requireCapability(manifest: WorkflowManifest, capability: WorkflowCapability) {
  if (!hasCapability(manifest, capability)) {
    throw new Error(`workflow capability required: ${capability}`);
  }
}

/**
 * Whether an MCP server is usable by this workflow. `undefined` allowedMcpServers
 * means "all enabled servers" (parent decides). An explicit list restricts to it.
 */
function isServerInScope(
  allowedMcpServers: string[] | undefined,
  serverId: string
): boolean {
  if (allowedMcpServers === undefined) return true;
  return allowedMcpServers.includes(serverId);
}

function safeAllowedTools(
  manifest: WorkflowManifest,
  tools: string[] | undefined
): string[] | undefined {
  if (!tools) return undefined;
  const cleaned = tools.map((tool) => tool.trim()).filter(Boolean);
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
      `workflow.spawnAgent tool(s) are not mapped to workflow capabilities: ${unknown.join(", ")}`
    );
  }
  return cleaned;
}

function makeTimeout(controller: AbortController, timeoutMs: number): Promise<never> {
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
      { once: true }
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
      throw new Error(`workflow.fetchUrl does not allow sensitive header: ${key}`);
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
    a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && b === 168
  );
}

function assertPublicHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("workflow.fetchUrl only supports http(s) URLs");
  }
  const host = url.hostname.toLowerCase();
  if (isPrivateOrLocalHostname(host) || isPrivateOrLocalIp(host)) {
    throw new Error("workflow.fetchUrl does not allow localhost or private-network URLs");
  }
  return url;
}

async function defaultResolveFetchHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: false });
  return records.map((record) => record.address);
}

async function assertPublicDnsResolution(
  url: URL,
  resolveHost: (host: string) => Promise<string[]>
): Promise<void> {
  const host = url.hostname.toLowerCase();
  if (isPrivateOrLocalIp(host)) return;
  const addresses = await resolveHost(host);
  if (addresses.some((address) => isPrivateOrLocalIp(address))) {
    throw new Error(
      "workflow.fetchUrl does not allow URLs that resolve to localhost or private-network addresses"
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
  const escaped = cleaned.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function urlPatternMatches(patterns: string[] | undefined, url: URL): boolean {
  const value = url.toString();
  return (patterns ?? []).some((pattern) => wildcardPatternMatches(pattern, value));
}

function assertNetworkPolicyAllows(
  input: WorkflowFetchUrlInput,
  url: URL,
  policy: WorkflowNetworkPolicy | undefined
): void {
  if (!policy) return;
  const method = input.method === "POST" ? "POST" : "GET";
  if (
    Array.isArray(policy.allowedMethods) &&
    policy.allowedMethods.length > 0 &&
    !policy.allowedMethods.includes(method)
  ) {
    throw new Error(`workflow.fetchUrl network policy does not allow method: ${method}`);
  }
  if (originMatches(policy.deniedOrigins, url)) {
    throw new Error(`workflow.fetchUrl network policy denies origin: ${url.origin}`);
  }
  if (urlPatternMatches(policy.deniedUrlPatterns, url)) {
    throw new Error(`workflow.fetchUrl network policy denies URL: ${url.toString()}`);
  }
  const hasAllowRules =
    (policy.allowedOrigins?.length ?? 0) > 0 ||
    (policy.allowedUrlPatterns?.length ?? 0) > 0;
  if (
    hasAllowRules &&
    !originMatches(policy.allowedOrigins, url) &&
    !urlPatternMatches(policy.allowedUrlPatterns, url)
  ) {
    throw new Error(`workflow.fetchUrl network policy does not allow URL: ${url.toString()}`);
  }
}

async function assertFetchRequestAllowed(
  input: WorkflowFetchUrlInput,
  policy: WorkflowNetworkPolicy | undefined,
  resolveHost: (host: string) => Promise<string[]>
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
  policy?: WorkflowNetworkPolicy
): Promise<WorkflowFetchUrlResult> {
  const url = await assertFetchRequestAllowed(input, policy, resolveHost);
  const method = input.method === "POST" ? "POST" : "GET";
  const maxBytes = Math.max(
    1,
    Math.min(Math.floor(input.maxBytes ?? DEFAULT_FETCH_MAX_BYTES), HARD_FETCH_MAX_BYTES)
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
  resumeState?: WorkflowResumeState
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
        throw new Error("workflow.diffWorktree requires a diff-capable worktree runtime");
      }
      const known = createdWorktrees.get(worktree.id);
      if (!known || known.path !== worktree.path) {
        throw new Error("workflow.diffWorktree can only diff worktrees created by this workflow");
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
        throw new Error("workflow.mergeWorktree requires a merge-capable worktree runtime");
      }
      if (!deps.worktrees.diff) {
        throw new Error("workflow.mergeWorktree requires a diff-capable worktree runtime for merge approval");
      }
      const known = createdWorktrees.get(worktree.id);
      if (!known || known.path !== worktree.path) {
        throw new Error("workflow.mergeWorktree can only merge worktrees created by this workflow");
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
      deps.onEvent?.({ type: "workflow_artifact", workflowId, artifact: diffArtifact });
      if (diff.diff.trim()) {
        if (!deps.approveWorktreeMerge) {
          throw new Error("workflow.mergeWorktree requires merge approval before applying a diff");
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
        throw new Error("workflow.removeWorktree requires a removable worktree runtime");
      }
      const known = createdWorktrees.get(worktree.id);
      if (!known || known.path !== worktree.path) {
        throw new Error("workflow.removeWorktree can only remove worktrees created by this workflow");
      }
      await deps.worktrees.remove(known);
      createdWorktrees.delete(known.id);
    },

    async askUser(askInput: WorkflowAskUserInput) {
      if (signal.aborted) throw new Error("Workflow script aborted");
      requireCapability(manifest, "ask_user");
      if (!deps.askUser) {
        throw new Error("workflow.askUser requires a user clarification runtime");
      }
      const options = Array.isArray(askInput.options)
        ? askInput.options
            .slice(0, 4)
            .map((option, index) => ({
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
      if (!fetchRequest.url) throw new Error("workflow.fetchUrl requires a url");
      if (!deps.approveNetworkRequest) {
        throw new Error("workflow.fetchUrl requires per-request network approval");
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
          `[network] denied by user: ${method} ${fetchRequest.url} (${resp.denyReason ?? "no reason"})`
        );
        throw new Error(resp.denyReason ?? "Workflow network request denied");
      }
      try {
        if (deps.fetchUrl) {
          await assertFetchRequestAllowed(
            fetchRequest,
            deps.networkPolicy,
            deps.resolveFetchHost ?? defaultResolveFetchHost
          );
        }
        const result = deps.fetchUrl
          ? await deps.fetchUrl(fetchRequest, signal)
          : await defaultFetchUrl(
              fetchRequest,
              signal,
              deps.resolveFetchHost,
              deps.networkPolicy
            );
        pushLog(
          "info",
          `[network] fetched: ${method} ${fetchRequest.url} -> ${result.status} ${result.statusText}`
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
        pushLog("warn", `[network] blocked or failed: ${method} ${fetchRequest.url} (${message})`);
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
          `workflow.listTools: MCP server "${requested}" is not in this workflow's scope`
        );
      }
      const tools = await deps.listMcpTools(requested);
      // Defense-in-depth: even when no serverId was given, the broker already
      // scopes to allowedMcpServers; filter again so a scope leak can't slip a
      // tool through.
      return tools.filter((tool) =>
        isServerInScope(deps.allowedMcpServers, tool.serverId)
      );
    },

    async callTool(toolInput: WorkflowCallToolInput): Promise<WorkflowCallToolResult> {
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
          `workflow.callTool: MCP server "${server}" is not in this workflow's scope`
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
          `[mcp] denied by user: ${server}/${tool} (${resp.denyReason ?? "no reason"})`
        );
        throw new Error(resp.denyReason ?? "Workflow MCP tool call denied");
      }
      const result = await deps.callMcpTool(callRequest);
      pushLog(
        "info",
        `[mcp] called: ${server}/${tool} -> ${result.isError ? "error" : "ok"}`
      );
      return result;
    },

    async spawnAgent(agentInput: WorkflowSpawnAgentInput) {
      if (signal.aborted) throw new Error("Workflow script aborted");
      requireCapability(manifest, "spawn_agent");
      spawnedAgents += 1;
      if (spawnedAgents > manifest.maxAgents) {
        throw new Error(
          `workflow.spawnAgent exceeded manifest maxAgents=${manifest.maxAgents}`
        );
      }
      const title = cleanText(agentInput.title, 120);
      const prompt = cleanText(agentInput.prompt, 12000);
      if (!title) throw new Error("workflow.spawnAgent requires a title");
      if (!prompt) throw new Error("workflow.spawnAgent requires a prompt");
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
              prompt: [`Workflow objective: ${input.objective}`, prompt].join("\n\n"),
              role: agentInput.role,
              cwd: agentInput.cwd,
              allowedTools: safeAllowedTools(manifest, agentInput.allowedTools),
              maxTurns: agentInput.maxTurns,
              timeoutMs: agentInput.timeoutMs,
            },
          ],
        },
        signal
      );
      const result = results[0];
      if (!result) throw new Error(`No subagent result returned for ${title}`);
      return result;
    },

    async parallel<T>(items: Array<Promise<T> | (() => Promise<T> | T)>) {
      if (!Array.isArray(items)) {
        throw new Error("workflow.parallel requires an array");
      }
      if (items.length > manifest.maxConcurrency) {
        throw new Error(
          `workflow.parallel supports at most ${manifest.maxConcurrency} item(s) for this manifest`
        );
      }
      return Promise.all(
        items.map((item) => (typeof item === "function" ? item() : item))
      );
    },

    async stage<T>(title: string, fn: () => Promise<T> | T) {
      pushLog("info", `stage:start:${cleanText(title, 160)}`);
      try {
        const result = await fn();
        pushLog("info", `stage:end:${cleanText(title, 160)}`);
        return result;
      } catch (err) {
        pushLog("error", `stage:failed:${cleanText(title, 160)}:${serializeError(err)}`);
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
  message: unknown
): void {
  if (child.stdin.destroyed) return;
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function workerScriptPath(): string {
  return path.join(process.cwd(), "lib/workflows/script-worker-child.cjs");
}

export function buildWorkflowWorkerSpawnConfig(options: {
  platform?: NodeJS.Platform;
  execPath?: string;
  workerPath?: string;
  memoryMb?: number;
  cpuSeconds?: number;
  sandboxArgv?: string[];
} = {}): {
  command: string;
  args: string[];
  usesPosixCpuLimit: boolean;
  usesExternalSandbox: boolean;
} {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const memoryMb = Math.max(
    16,
    Math.floor(options.memoryMb ?? WORKFLOW_WORKER_MAX_OLD_SPACE_MB)
  );
  const workerPath = options.workerPath ?? workerScriptPath();
  const nodeArgs = [`--max-old-space-size=${memoryMb}`, workerPath];
  const cpuSeconds = Math.floor(options.cpuSeconds ?? WORKFLOW_WORKER_CPU_SECONDS);
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
  const raw = process.env.MINI_PI_WORKFLOW_WORKER_SANDBOX_ARGV_JSON;
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
  worker: { command: string; args: string[] }
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
        Math.min(WORKFLOW_WORKER_CPU_SECONDS, Math.ceil(args.manifest.timeoutMs / 1000))
      ),
    });
    const child: ChildProcessWithoutNullStreams = spawnProcess(
      workerSpawn.command,
      workerSpawn.args,
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      }
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
          result = args.sdk.checkpoint(String(requestArgs[0] ?? ""), requestArgs[1]);
        } else if (method === "artifact") {
          result = args.sdk.artifact(String(requestArgs[0] ?? ""), requestArgs[1]);
        } else if (method === "createWorktree") {
          result = await args.sdk.createWorktree(
            requestArgs[0] as WorkflowCreateWorktreeInput | undefined
          );
        } else if (method === "diffWorktree") {
          result = await args.sdk.diffWorktree(requestArgs[0] as WorkflowWorktree);
        } else if (method === "mergeWorktree") {
          result = await args.sdk.mergeWorktree(requestArgs[0] as WorkflowWorktree);
        } else if (method === "removeWorktree") {
          result = await args.sdk.removeWorktree(requestArgs[0] as WorkflowWorktree);
        } else if (method === "askUser") {
          result = await args.sdk.askUser(requestArgs[0] as WorkflowAskUserInput);
        } else if (method === "fetchUrl") {
          result = await args.sdk.fetchUrl(requestArgs[0] as WorkflowFetchUrlInput);
        } else if (method === "listTools") {
          result = await args.sdk.listTools(
            requestArgs[0] as string | undefined
          );
        } else if (method === "callTool") {
          result = await args.sdk.callTool(requestArgs[0] as WorkflowCallToolInput);
        } else if (method === "spawnAgent") {
          result = await args.sdk.spawnAgent(requestArgs[0] as WorkflowSpawnAgentInput);
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
          reject(new Error(`Invalid workflow worker output: ${serializeError(err)}`))
        );
        return;
      }

      if (message.type === "request") {
        void handleRequest(message);
      } else if (message.type === "done") {
        settle(() => resolve(message.value));
      } else if (message.type === "error") {
        settle(() => reject(new Error(String(message.error ?? "Workflow worker error"))));
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
            })${detail ? `: ${detail}` : ""}`
          )
        )
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
    });
  });
}

function loadResumeRun(
  input: RunWorkflowScriptInput,
  parentAgentId: string
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
    input.resumeFromCheckpointName
  );
  const selectedCheckpoint = requestedCheckpointName
    ? run.checkpoints.find((checkpoint) => checkpoint.name === requestedCheckpointName)
    : run.checkpoints[run.checkpoints.length - 1];
  if (!selectedCheckpoint) {
    throw new Error(
      `resume checkpoint not found in workflow ${resumeFromWorkflowId}: ${requestedCheckpointName}`
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
  externalSignal?: AbortSignal
): Promise<WorkflowScriptResult> {
  const input: RunWorkflowScriptInput = {
    objective: cleanText(rawInput.objective, 2000),
    rationale: cleanText(rawInput.rationale, 2000),
    script: cleanText(rawInput.script, MAX_SCRIPT_CHARS),
    resumeFromWorkflowId: sanitizeWorkflowId(rawInput.resumeFromWorkflowId),
    resumeFromCheckpointName: sanitizeCheckpointName(
      rawInput.resumeFromCheckpointName
    ),
    capabilities: rawInput.capabilities,
    maxAgents: rawInput.maxAgents,
    maxConcurrency: rawInput.maxConcurrency,
    timeoutMs: rawInput.timeoutMs,
  };
  if (!input.objective) throw new Error("run_workflow_script requires an objective");
  if (!input.rationale) throw new Error("run_workflow_script requires a rationale");
  if (!input.script) throw new Error("run_workflow_script requires a script");
  const manifest = normalizeManifest(input);

  const parentAgentId = deps.parentAgentId ?? "unknown";
  const { run: resumeRun, state: resumeState } = loadResumeRun(input, parentAgentId);
  const workflowId = randomUUID();
  const startedAt = now();
  const artifacts = new Map<string, WorkflowArtifact>(
    (resumeRun?.artifacts ?? []).map((artifact) => [artifact.name, artifact])
  );
  const checkpoints: WorkflowCheckpoint[] = resumeRun?.checkpoints.slice() ?? [];
  const logs: WorkflowScriptLog[] = [];
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
      createdAt: startedAt,
    },
    abortController
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
      createdAt: startedAt,
    },
  });

  try {
    await approveManifestCapabilities(deps, input, workflowId, manifest);
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
      resumeState
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
    const status = abortController.signal.aborted ? "aborted" : "completed";
    finishWorkflowRun(workflowId, {
      status,
      endedAt,
      returnValue: value,
      artifacts: Array.from(artifacts.values()),
      checkpoints,
      logs,
    });
    deps.onEvent?.({
      type: "workflow_end",
      workflowId,
      status,
      endedAt,
      returnValue: value,
      artifacts: Array.from(artifacts.values()),
      checkpoints,
      logs,
    });
    return {
      workflowId,
      objective: input.objective,
      status,
      manifest,
      resumedFromWorkflowId: input.resumeFromWorkflowId,
      returnValue: value,
      artifacts: Array.from(artifacts.values()),
      checkpoints,
      logs,
      startedAt,
      endedAt,
    };
  } catch (err) {
    const endedAt = now();
    const status = abortController.signal.aborted ? "aborted" : "failed";
    const error = serializeError(err);
    finishWorkflowRun(workflowId, {
      status,
      endedAt,
      artifacts: Array.from(artifacts.values()),
      checkpoints,
      logs,
      error,
    });
    deps.onEvent?.({
      type: "workflow_end",
      workflowId,
      status,
      endedAt,
      artifacts: Array.from(artifacts.values()),
      checkpoints,
      logs,
      error,
    });
    return {
      workflowId,
      objective: input.objective,
      status,
      manifest,
      resumedFromWorkflowId: input.resumeFromWorkflowId,
      artifacts: Array.from(artifacts.values()),
      checkpoints,
      logs,
      startedAt,
      endedAt,
      error,
    };
  } finally {
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

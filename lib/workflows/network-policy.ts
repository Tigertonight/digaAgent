import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type {
  WorkflowNetworkAuditEntry,
  WorkflowNetworkAuditQuery,
  WorkflowNetworkPolicy,
} from "./types";

const POLICY_SCHEMA_VERSION = 1;
const AUDIT_SCHEMA_VERSION = 1;
const MAX_AUDIT_ENTRIES = 200;

interface WorkflowNetworkPolicyEnvelope {
  schemaVersion: 1;
  kind: "workflow-network-policy";
  policy: WorkflowNetworkPolicy;
  updatedAt: number;
}

interface WorkflowNetworkAuditEnvelope {
  schemaVersion: 1;
  kind: "workflow-network-audit";
  entries: WorkflowNetworkAuditEntry[];
  updatedAt: number;
}

const g = globalThis as unknown as {
  __digaAgentWorkflowNetworkPolicy?: {
    rootOverride: string | null;
    loaded: boolean;
    policy: WorkflowNetworkPolicy;
    auditLoaded: boolean;
    audits: WorkflowNetworkAuditEntry[];
  };
};

if (!g.__digaAgentWorkflowNetworkPolicy) {
  g.__digaAgentWorkflowNetworkPolicy = {
    rootOverride: null,
    loaded: false,
    policy: {},
    auditLoaded: false,
    audits: [],
  };
}

const store = g.__digaAgentWorkflowNetworkPolicy;

function rootDir(): string {
  return store.rootOverride ?? path.join(os.homedir(), ".diga-agent");
}

function policyPath(): string {
  return path.join(rootDir(), "workflows", "network-policy.json");
}

function auditPath(): string {
  return path.join(rootDir(), "workflows", "network-audit.json");
}

function cleanStringArray(value: unknown, maxItems: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((item) => (typeof item === "string" ? item.trim().slice(0, 1000) : ""))
    .filter(Boolean)
    .slice(0, maxItems);
  return out.length > 0 ? out : undefined;
}

export function normalizeWorkflowNetworkPolicy(
  raw: unknown
): WorkflowNetworkPolicy {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const methods = Array.isArray(obj.allowedMethods)
    ? obj.allowedMethods
        .filter((method): method is "GET" | "POST" => method === "GET" || method === "POST")
        .slice(0, 2)
    : undefined;
  return {
    allowedOrigins: cleanStringArray(obj.allowedOrigins, 200),
    deniedOrigins: cleanStringArray(obj.deniedOrigins, 200),
    allowedUrlPatterns: cleanStringArray(obj.allowedUrlPatterns, 200),
    deniedUrlPatterns: cleanStringArray(obj.deniedUrlPatterns, 200),
    allowedMethods: methods && methods.length > 0 ? methods : undefined,
  };
}

function readPolicyFile(): WorkflowNetworkPolicy {
  try {
    const raw = fs.readFileSync(policyPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Partial<WorkflowNetworkPolicyEnvelope> & {
        policy?: unknown;
      };
      if (obj.kind === "workflow-network-policy" && obj.schemaVersion === POLICY_SCHEMA_VERSION) {
        return normalizeWorkflowNetworkPolicy(obj.policy);
      }
    }
    return normalizeWorkflowNetworkPolicy(parsed);
  } catch {
    return {};
  }
}

function ensureLoaded(): void {
  if (store.loaded) return;
  store.policy = readPolicyFile();
  store.loaded = true;
}

function normalizeAuditEntry(raw: unknown): WorkflowNetworkAuditEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const method = obj.method === "POST" ? "POST" : "GET";
  const outcome =
    obj.outcome === "allowed" || obj.outcome === "denied" || obj.outcome === "failed"
      ? obj.outcome
      : null;
  const workflowId = typeof obj.workflowId === "string" ? obj.workflowId.slice(0, 120) : "";
  const url = typeof obj.url === "string" ? obj.url.slice(0, 2000) : "";
  if (!outcome || !workflowId || !url) return null;
  const createdAt =
    typeof obj.createdAt === "number" && Number.isFinite(obj.createdAt)
      ? obj.createdAt
      : Date.now();
  const status =
    typeof obj.status === "number" && Number.isFinite(obj.status)
      ? obj.status
      : undefined;
  const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 1000) : undefined;
  return {
    id: typeof obj.id === "string" && obj.id ? obj.id.slice(0, 120) : randomUUID(),
    workflowId,
    url,
    method,
    outcome,
    ...(status !== undefined ? { status } : {}),
    ...(reason ? { reason } : {}),
    createdAt,
  };
}

function readAuditFile(): WorkflowNetworkAuditEntry[] {
  try {
    const raw = fs.readFileSync(auditPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const entries =
      parsed && typeof parsed === "object"
        ? (parsed as Partial<WorkflowNetworkAuditEnvelope> & { entries?: unknown }).entries
        : parsed;
    if (!Array.isArray(entries)) return [];
    return entries
      .map(normalizeAuditEntry)
      .filter((entry): entry is WorkflowNetworkAuditEntry => Boolean(entry))
      .slice(-MAX_AUDIT_ENTRIES);
  } catch {
    return [];
  }
}

function writeAudits(entries: WorkflowNetworkAuditEntry[]): void {
  fs.mkdirSync(path.dirname(auditPath()), { recursive: true });
  const envelope: WorkflowNetworkAuditEnvelope = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    kind: "workflow-network-audit",
    entries: entries.slice(-MAX_AUDIT_ENTRIES),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(auditPath(), JSON.stringify(envelope, null, 2));
}

function ensureAuditsLoaded(): void {
  if (store.auditLoaded) return;
  store.audits = readAuditFile();
  store.auditLoaded = true;
}

export function getWorkflowNetworkPolicy(): WorkflowNetworkPolicy {
  ensureLoaded();
  return { ...store.policy };
}

export function listWorkflowNetworkAudits(
  query: number | WorkflowNetworkAuditQuery = 50
): WorkflowNetworkAuditEntry[] {
  ensureAuditsLoaded();
  const opts = typeof query === "number" ? { limit: query } : query;
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const workflowId = opts.workflowId?.trim();
  const origin = opts.origin?.trim();
  const outcome = opts.outcome;
  const q = opts.q?.trim().toLowerCase();
  return store.audits
    .filter((entry) => {
      if (workflowId && entry.workflowId !== workflowId) return false;
      if (outcome && entry.outcome !== outcome) return false;
      if (origin) {
        try {
          if (new URL(entry.url).origin !== origin) return false;
        } catch {
          return false;
        }
      }
      if (q) {
        const haystack = [
          entry.workflowId,
          entry.url,
          entry.method,
          entry.outcome,
          entry.status?.toString() ?? "",
          entry.reason ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    })
    .slice(-limit)
    .reverse()
    .map((entry) => ({ ...entry }));
}

export function appendWorkflowNetworkAudit(
  raw: Omit<WorkflowNetworkAuditEntry, "id" | "createdAt"> & {
    id?: string;
    createdAt?: number;
  }
): WorkflowNetworkAuditEntry {
  ensureAuditsLoaded();
  const entry = normalizeAuditEntry({
    ...raw,
    id: raw.id ?? randomUUID(),
    createdAt: raw.createdAt ?? Date.now(),
  });
  if (!entry) {
    throw new Error("invalid workflow network audit entry");
  }
  store.audits = [...store.audits, entry].slice(-MAX_AUDIT_ENTRIES);
  writeAudits(store.audits);
  return { ...entry };
}

export function setWorkflowNetworkPolicy(
  raw: unknown
): WorkflowNetworkPolicy {
  const policy = normalizeWorkflowNetworkPolicy(raw);
  store.policy = policy;
  store.loaded = true;
  fs.mkdirSync(path.dirname(policyPath()), { recursive: true });
  const envelope: WorkflowNetworkPolicyEnvelope = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    kind: "workflow-network-policy",
    policy,
    updatedAt: Date.now(),
  };
  fs.writeFileSync(policyPath(), JSON.stringify(envelope, null, 2));
  return { ...policy };
}

export function __setWorkflowNetworkPolicyRootForTest(root: string | null): void {
  store.rootOverride = root;
  store.loaded = false;
  store.policy = {};
  store.auditLoaded = false;
  store.audits = [];
}

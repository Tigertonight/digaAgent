import "server-only";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServerConfig, McpTransport } from "./types";

const CURRENT_VERSION = 1 as const;

interface McpStoreEnvelope {
  version: number;
  servers: McpServerConfig[];
}

interface McpStore {
  servers: Map<string, McpServerConfig>;
}

const g = globalThis as unknown as { __digaAgentMcpRegistry?: McpStore };
if (!g.__digaAgentMcpRegistry) {
  g.__digaAgentMcpRegistry = { servers: new Map() };
}
const store = g.__digaAgentMcpRegistry;

let rootOverride: string | null = null;
let hydrated = false;

function getRoot(): string {
  return rootOverride ?? path.join(os.homedir(), ".diga-agent");
}

function mcpDir(): string {
  return path.join(getRoot(), "mcp");
}

function serversFile(): string {
  return path.join(mcpDir(), "servers.json");
}

function isTransport(v: unknown): v is McpTransport {
  return v === "stdio";
}

function assertSafeServerId(id: string): void {
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`invalid mcp server id: ${id}`);
  }
}

function sanitizeServer(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(src.id)) return null;
  if (!isTransport(src.transport)) return null;
  if (typeof src.command !== "string" || !src.command.trim()) return null;
  return {
    id: src.id,
    title: typeof src.title === "string" ? src.title : undefined,
    transport: src.transport,
    command: src.command,
    args: Array.isArray(src.args)
      ? src.args.filter((a): a is string => typeof a === "string")
      : undefined,
    env:
      src.env && typeof src.env === "object"
        ? (src.env as Record<string, string>)
        : undefined,
    enabled: src.enabled !== false,
  };
}

// T2.7: 同步原子写 + ENOSPC 重抣 + 其他 errno warn。
function persist(): void {
  let tmp: string | null = null;
  let fd: number | null = null;
  try {
    mkdirSync(mcpDir(), { recursive: true });
    const fp = serversFile();
    tmp = `${fp}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
    const envelope: McpStoreEnvelope = {
      version: CURRENT_VERSION,
      servers: Array.from(store.servers.values()),
    };
    fd = openSync(tmp, "wx");
    writeSync(fd, JSON.stringify(envelope, null, 2), 0, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, fp);
    tmp = null;
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    if (tmp) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOSPC") {
      console.warn("[mcp-registry] persist failed (no space)", { code });
      throw err;
    }
    console.warn("[mcp-registry] persist failed", {
      code,
      err: err instanceof Error ? err.message : String(err),
    });
    // 保留 best-effort 语义，不阈断运行时。
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const fp = serversFile();
  if (!existsSync(fp)) return;
  try {
    const env = JSON.parse(readFileSync(fp, "utf8")) as McpStoreEnvelope;
    if (!Array.isArray(env.servers)) return;
    for (const raw of env.servers) {
      const server = sanitizeServer(raw);
      if (server) store.servers.set(server.id, server);
    }
  } catch {
    // Ignore corrupt config; an empty registry is safe (no-op, 修正 6).
  }
}

export function listMcpServers(): McpServerConfig[] {
  hydrate();
  return Array.from(store.servers.values());
}

export function listEnabledMcpServers(): McpServerConfig[] {
  return listMcpServers().filter((s) => s.enabled);
}

export function getMcpServer(id: string): McpServerConfig | null {
  hydrate();
  return store.servers.get(id) ?? null;
}

export function upsertMcpServer(config: McpServerConfig): McpServerConfig {
  hydrate();
  assertSafeServerId(config.id);
  if (!config.command.trim()) throw new Error("mcp server command required");
  const normalized: McpServerConfig = {
    ...config,
    enabled: config.enabled !== false,
  };
  store.servers.set(config.id, normalized);
  persist();
  return normalized;
}

export function removeMcpServer(id: string): void {
  hydrate();
  store.servers.delete(id);
  persist();
}

export function __setMcpRegistryRootForTest(root: string | null): void {
  rootOverride = root;
  hydrated = false;
  store.servers.clear();
}

export function __resetMcpRegistryForTest(): void {
  store.servers.clear();
  hydrated = false;
}

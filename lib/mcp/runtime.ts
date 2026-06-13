import "server-only";
import { McpStdioClient } from "./client";
import { getMcpServer } from "./registry";
import type { McpServerConfig, McpToolDescriptor, McpToolResult } from "./types";

/**
 * MCP runtime: manages live stdio clients and exposes list/call with fault
 * tolerance. A failing server never throws into the agent main flow (修正 5):
 * list returns [] and call returns an error result.
 */

interface RuntimeStore {
  clients: Map<string, McpStdioClient>;
}

const g = globalThis as unknown as { __digaAgentMcpRuntime?: RuntimeStore };
if (!g.__digaAgentMcpRuntime) {
  g.__digaAgentMcpRuntime = { clients: new Map() };
}
const store = g.__digaAgentMcpRuntime;

/** Test seam: resolve a server config (defaults to the registry). */
let resolveConfig: (id: string) => McpServerConfig | null = getMcpServer;

function getClient(serverId: string): McpStdioClient | null {
  const existing = store.clients.get(serverId);
  if (existing) return existing;
  const config = resolveConfig(serverId);
  if (!config || !config.enabled) return null;
  const client = new McpStdioClient(config);
  store.clients.set(serverId, client);
  return client;
}

export async function listMcpTools(
  serverId: string
): Promise<McpToolDescriptor[]> {
  const client = getClient(serverId);
  if (!client) return [];
  try {
    return await client.listTools();
  } catch {
    // Drop a broken client so the next attempt re-spawns.
    disposeMcpClient(serverId);
    return [];
  }
}

export async function callMcpTool(
  serverId: string,
  tool: string,
  input: Record<string, unknown>
): Promise<McpToolResult> {
  const client = getClient(serverId);
  if (!client) {
    return {
      text: `MCP server "${serverId}" is not available.`,
      isError: true,
    };
  }
  try {
    return await client.callTool(tool, input);
  } catch (e) {
    disposeMcpClient(serverId);
    return {
      text: `MCP call failed: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
}

export function disposeMcpClient(serverId: string): void {
  const client = store.clients.get(serverId);
  if (client) {
    client.dispose();
    store.clients.delete(serverId);
  }
}

export function disposeAllMcpClients(): void {
  for (const [, client] of store.clients) client.dispose();
  store.clients.clear();
}

export function __setMcpConfigResolverForTest(
  resolver: ((id: string) => McpServerConfig | null) | null
): void {
  resolveConfig = resolver ?? getMcpServer;
}

export function __resetMcpRuntimeForTest(): void {
  disposeAllMcpClients();
  resolveConfig = getMcpServer;
}

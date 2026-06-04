import "server-only";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { listEnabledMcpServers } from "./registry";
import { listMcpTools } from "./runtime";
import { scopeServersForSpecialist } from "./policy";
import { createMcpToolDefinition, type McpToolBridgeOptions } from "./tool-bridge";

export interface LoadMcpToolsOptions extends McpToolBridgeOptions {
  /**
   * When provided, restrict to these server ids (specialist scope, 修正 4).
   * Undefined means "main agent": all enabled servers.
   */
  allowedMcpServers?: string[];
}

/**
 * Load agent tool definitions for the enabled MCP servers. Best-effort: any
 * server that fails to list tools is skipped (修正 5), never throwing into agent
 * creation. Returns [] when no servers are configured (no-op, 修正 6).
 */
export async function loadMcpToolDefinitions(
  opts: LoadMcpToolsOptions
): Promise<ToolDefinition[]> {
  let serverIds = listEnabledMcpServers().map((s) => s.id);
  if (opts.allowedMcpServers !== undefined) {
    // Specialist scope: only declared servers (empty when none declared).
    serverIds = scopeServersForSpecialist(serverIds, opts.allowedMcpServers);
  }
  if (serverIds.length === 0) return [];

  const defs: ToolDefinition[] = [];
  for (const serverId of serverIds) {
    let tools;
    try {
      tools = await listMcpTools(serverId);
    } catch {
      continue; // skip a broken server
    }
    for (const descriptor of tools) {
      defs.push(
        createMcpToolDefinition(descriptor, {
          rules: opts.rules,
          requestApproval: opts.requestApproval,
          onAudit: opts.onAudit,
        }) as unknown as ToolDefinition
      );
    }
  }
  return defs;
}

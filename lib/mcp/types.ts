/**
 * MCP (Model Context Protocol) types — Sprint 5.
 *
 * Scope (decision A): stdio transport + tools only. SSE/HTTP transport and
 * resources/prompts/sampling are intentionally out of scope for now.
 */

export type McpTransport = "stdio";

export interface McpServerConfig {
  /** Stable id (used as the tool namespace prefix and scope key). */
  id: string;
  /** Human-readable label. */
  title?: string;
  transport: McpTransport;
  /** Executable to spawn for a stdio server. */
  command: string;
  args?: string[];
  /** Extra environment variables for the spawned process. */
  env?: Record<string, string>;
  /** When false, the server is configured but not loaded. */
  enabled: boolean;
}

/** A tool advertised by an MCP server (subset of the MCP tools/list shape). */
export interface McpToolDescriptor {
  serverId: string;
  name: string;
  description?: string;
  /** JSON schema for the tool input, passed through to the agent tool. */
  inputSchema?: Record<string, unknown>;
}

/** Result of calling an MCP tool (subset of tools/call result). */
export interface McpToolResult {
  /** Text content concatenated for the agent. */
  text: string;
  /** Whether the server flagged the result as an error. */
  isError: boolean;
  /** Raw content blocks for audit/debug. */
  raw?: unknown;
}

export type McpPolicyAction = "allow" | "deny" | "ask";

export interface McpPolicyRule {
  /** Server id this rule applies to, or "*" for all. */
  serverId: string;
  /** Tool name glob (exact or "*"). */
  tool?: string;
  action: McpPolicyAction;
}

export interface McpPolicyDecision {
  action: McpPolicyAction;
  reason: string;
}

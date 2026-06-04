import type { McpPolicyDecision, McpPolicyRule } from "./types";

/**
 * Resolve the policy action for an MCP tool call (pure).
 *
 * Rules are matched most-specific-first:
 *   1. exact serverId + exact tool
 *   2. exact serverId + "*"
 *   3. "*" + exact tool
 *   4. "*" + "*"
 * Within the same specificity, the first matching rule wins.
 *
 * Default (no rule matched) is "ask" — safe-by-default: a tool call surfaces an
 * approval rather than silently running or being blocked.
 */
export function resolveMcpPolicy(
  serverId: string,
  tool: string,
  rules: McpPolicyRule[]
): McpPolicyDecision {
  const tiers: Array<(r: McpPolicyRule) => boolean> = [
    (r) => r.serverId === serverId && r.tool === tool,
    (r) => r.serverId === serverId && (r.tool === "*" || r.tool === undefined),
    (r) => r.serverId === "*" && r.tool === tool,
    (r) => r.serverId === "*" && (r.tool === "*" || r.tool === undefined),
  ];
  for (const match of tiers) {
    const rule = rules.find(match);
    if (rule) {
      return {
        action: rule.action,
        reason: `Matched rule ${rule.serverId}/${rule.tool ?? "*"} -> ${rule.action}.`,
      };
    }
  }
  return { action: "ask", reason: "No matching policy; defaulting to ask." };
}

/**
 * Whether an MCP server is in scope for a specialist (pure).
 *
 * - undefined `allowedMcpServers`: the specialist has no MCP scope → no servers.
 *   (Specialists must explicitly opt into MCP servers; 修正 4.)
 * - empty array: also no servers.
 * - otherwise: only servers listed are allowed.
 *
 * Note: the MAIN agent (not a specialist) is governed separately — it sees all
 * enabled servers unless restricted by policy.
 */
export function isServerAllowedForSpecialist(
  serverId: string,
  allowedMcpServers: string[] | undefined
): boolean {
  if (!allowedMcpServers || allowedMcpServers.length === 0) return false;
  return allowedMcpServers.includes(serverId);
}

/**
 * Filter a list of server ids down to those a specialist may use.
 */
export function scopeServersForSpecialist(
  serverIds: string[],
  allowedMcpServers: string[] | undefined
): string[] {
  return serverIds.filter((id) =>
    isServerAllowedForSpecialist(id, allowedMcpServers)
  );
}

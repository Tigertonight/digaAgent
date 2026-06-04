import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalResponse } from "@/lib/collab/types";
import { callMcpTool } from "./runtime";
import { resolveMcpPolicy } from "./policy";
import type { McpPolicyRule, McpToolDescriptor } from "./types";

// MCP tool input is dynamic JSON; accept an open object and let the MCP server
// validate against its own schema. The descriptor's inputSchema is surfaced in
// the description for the model.
const McpToolParams = Type.Object(
  {},
  { additionalProperties: true }
);

export interface McpToolBridgeOptions {
  /** Policy rules to gate calls (allow/deny/ask). */
  rules: McpPolicyRule[];
  /** Request user approval when policy says "ask". Deny when absent. */
  requestApproval?: (params: {
    serverId: string;
    tool: string;
    input: Record<string, unknown>;
  }) => Promise<ApprovalResponse>;
  /** Optional audit sink. */
  onAudit?: (event: {
    serverId: string;
    tool: string;
    action: "allowed" | "denied" | "asked";
    isError?: boolean;
  }) => void;
}

/**
 * The agent-facing tool name for an MCP tool. Namespaced by server id so two
 * servers can expose same-named tools without collision.
 */
export function mcpToolName(serverId: string, tool: string): string {
  return `mcp__${serverId}__${tool}`;
}

/**
 * Wrap a single MCP tool descriptor into an agent ToolDefinition. The execute
 * path enforces policy (allow/deny/ask) before calling the MCP server, so an
 * agent can never bypass the broker (修正 2).
 */
export function createMcpToolDefinition(
  descriptor: McpToolDescriptor,
  opts: McpToolBridgeOptions
): ToolDefinition<typeof McpToolParams, { serverId: string; tool: string; isError: boolean }> {
  const name = mcpToolName(descriptor.serverId, descriptor.name);
  const schemaHint = descriptor.inputSchema
    ? `\nInput schema: ${JSON.stringify(descriptor.inputSchema).slice(0, 800)}`
    : "";
  return defineTool<
    typeof McpToolParams,
    { serverId: string; tool: string; isError: boolean }
  >({
    name,
    label: `MCP: ${descriptor.serverId}/${descriptor.name}`,
    description:
      (descriptor.description ||
        `Call the "${descriptor.name}" tool on MCP server "${descriptor.serverId}".`) +
      schemaHint,
    promptSnippet: `${name}: call MCP server ${descriptor.serverId}'s ${descriptor.name} tool.`,
    parameters: McpToolParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const input = (params ?? {}) as Record<string, unknown>;
      const decision = resolveMcpPolicy(
        descriptor.serverId,
        descriptor.name,
        opts.rules
      );

      if (decision.action === "deny") {
        opts.onAudit?.({
          serverId: descriptor.serverId,
          tool: descriptor.name,
          action: "denied",
        });
        return {
          content: [
            {
              type: "text",
              text: `MCP tool denied by policy: ${decision.reason}`,
            },
          ],
          details: {
            serverId: descriptor.serverId,
            tool: descriptor.name,
            isError: true,
          },
        };
      }

      if (decision.action === "ask") {
        if (!opts.requestApproval) {
          opts.onAudit?.({
            serverId: descriptor.serverId,
            tool: descriptor.name,
            action: "denied",
          });
          return {
            content: [
              {
                type: "text",
                text: "MCP tool requires approval but no approval channel is available; denied.",
              },
            ],
            details: {
              serverId: descriptor.serverId,
              tool: descriptor.name,
              isError: true,
            },
          };
        }
        const approval = await opts.requestApproval({
          serverId: descriptor.serverId,
          tool: descriptor.name,
          input,
        });
        opts.onAudit?.({
          serverId: descriptor.serverId,
          tool: descriptor.name,
          action: "asked",
        });
        if (approval.decision !== "allow") {
          return {
            content: [
              {
                type: "text",
                text: `MCP tool call denied${approval.denyReason ? `: ${approval.denyReason}` : "."}`,
              },
            ],
            details: {
              serverId: descriptor.serverId,
              tool: descriptor.name,
              isError: true,
            },
          };
        }
      } else {
        opts.onAudit?.({
          serverId: descriptor.serverId,
          tool: descriptor.name,
          action: "allowed",
        });
      }

      const result = await callMcpTool(descriptor.serverId, descriptor.name, input);
      return {
        content: [{ type: "text", text: result.text || "(empty result)" }],
        details: {
          serverId: descriptor.serverId,
          tool: descriptor.name,
          isError: result.isError,
        },
      };
    },
  });
}

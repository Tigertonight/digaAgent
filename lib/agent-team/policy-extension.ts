import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  extractWriteTargetPaths,
  isWriteBoundaryTool,
} from "@/lib/subagents/write-boundary";
import { validateStoredAgentTeamToolPolicy } from "./server-store";

const NETWORK_TOOL_PATTERN = /browser|fetch|http|https|web|search|curl|wget|network/i;

function isNetworkTool(toolName: string): boolean {
  return NETWORK_TOOL_PATTERN.test(toolName);
}

export function createAgentTeamPolicyExtension(opts: {
  getAgentId: () => string;
}): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const writePaths = extractWriteTargetPaths({
        toolName: event.toolName,
        input: event.input,
      });
      const result = validateStoredAgentTeamToolPolicy(opts.getAgentId(), {
        toolName: event.toolName,
        isWrite: isWriteBoundaryTool(event.toolName) || writePaths.length > 0,
        isNetwork: isNetworkTool(event.toolName),
      });
      if (!result.error) return undefined;
      return {
        block: true,
        reason: result.error,
      };
    });
  };
}

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { extractWriteTargetPaths } from "@/lib/subagents/write-boundary";
import { recordStoredAgentTeamToolWrite } from "./server-store";

export function createAgentTeamWriteLockExtension(opts: {
  getAgentId: () => string;
}): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const paths = extractWriteTargetPaths({
        toolName: event.toolName,
        input: event.input,
      });
      if (paths.length === 0) return undefined;
      const result = recordStoredAgentTeamToolWrite(opts.getAgentId(), paths);
      if (!result.error) return undefined;
      if (result.error === "team run is not running") return undefined;
      return {
        block: true,
        reason: result.error,
      };
    });
  };
}

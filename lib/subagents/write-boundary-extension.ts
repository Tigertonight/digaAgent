import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { findWriteBoundaryViolation } from "./write-boundary";

export function createSubagentWriteBoundaryExtension(opts: {
  cwd: string;
  writePaths?: string[];
}): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const violation = findWriteBoundaryViolation({
        toolName: event.toolName,
        input: event.input,
        cwd: opts.cwd,
        writePaths: opts.writePaths,
      });
      if (!violation) return undefined;
      const target =
        violation.paths.length > 0 ? violation.paths.join(", ") : "unknown target";
      const allowed =
        violation.allowedPaths.length > 0
          ? violation.allowedPaths.join(", ")
          : "no declared writePaths";
      return {
        block: true,
        reason: `${violation.reason}. target=${target}; allowed=${allowed}`,
      };
    });
  };
}

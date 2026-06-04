import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./runtime", () => ({
  callMcpTool: vi.fn(async () => ({ text: "ok", isError: false })),
}));

import { callMcpTool } from "./runtime";
import { createMcpToolDefinition, mcpToolName } from "./tool-bridge";
import type { McpToolDescriptor } from "./types";

const descriptor: McpToolDescriptor = {
  serverId: "fs",
  name: "read",
  description: "Read a file",
};

type ExecFn = (
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal
) => Promise<{ details: { isError: boolean } }>;

function exec(tool: { execute: unknown }): ExecFn {
  return tool.execute as ExecFn;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("mcpToolName", () => {
  it("namespaces by server id", () => {
    expect(mcpToolName("fs", "read")).toBe("mcp__fs__read");
  });
});

describe("createMcpToolDefinition", () => {
  it("allows and calls the tool when policy allows", async () => {
    const tool = createMcpToolDefinition(descriptor, {
      rules: [{ serverId: "fs", tool: "read", action: "allow" }],
    });
    const res = await exec(tool)("c1", { path: "/a" });
    expect(callMcpTool).toHaveBeenCalledWith("fs", "read", { path: "/a" });
    expect(res.details.isError).toBe(false);
  });

  it("denies without calling when policy denies", async () => {
    const tool = createMcpToolDefinition(descriptor, {
      rules: [{ serverId: "fs", tool: "*", action: "deny" }],
    });
    const res = await exec(tool)("c1", {});
    expect(callMcpTool).not.toHaveBeenCalled();
    expect(res.details.isError).toBe(true);
  });

  it("ask with no approval channel denies", async () => {
    const tool = createMcpToolDefinition(descriptor, { rules: [] }); // default ask
    const res = await exec(tool)("c1", {});
    expect(callMcpTool).not.toHaveBeenCalled();
    expect(res.details.isError).toBe(true);
  });

  it("ask -> approval allow calls the tool", async () => {
    const tool = createMcpToolDefinition(descriptor, {
      rules: [],
      requestApproval: async () => ({ decision: "allow" }),
    });
    const res = await exec(tool)("c1", { path: "/b" });
    expect(callMcpTool).toHaveBeenCalledWith("fs", "read", { path: "/b" });
    expect(res.details.isError).toBe(false);
  });

  it("ask -> approval deny does not call", async () => {
    const tool = createMcpToolDefinition(descriptor, {
      rules: [],
      requestApproval: async () => ({ decision: "deny", denyReason: "no" }),
    });
    const res = await exec(tool)("c1", {});
    expect(callMcpTool).not.toHaveBeenCalled();
    expect(res.details.isError).toBe(true);
  });

  it("fires audit callbacks", async () => {
    const onAudit = vi.fn();
    const tool = createMcpToolDefinition(descriptor, {
      rules: [{ serverId: "fs", tool: "read", action: "allow" }],
      onAudit,
    });
    await exec(tool)("c1", {});
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "allowed" })
    );
  });
});

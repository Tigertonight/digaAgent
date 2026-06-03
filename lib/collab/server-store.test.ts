import { afterEach, describe, expect, it } from "vitest";
import {
  __resetCollabStoreForTest,
  listPendingApprovals,
  registerPendingApproval,
  resolveApproval,
} from "./server-store";
import type { ApprovalRequest } from "./types";

function approval(agentId: string, toolCallId: string): ApprovalRequest {
  return {
    id: `${agentId}:${toolCallId}`,
    agentId,
    toolCallId,
    toolName: "shell",
    input: { cmd: "pwd" },
    reason: "rule",
    ruleId: "ask-shell",
    defaultDecision: "deny",
    createdAt: Date.now(),
  };
}

describe("collab server-store pending approvals", () => {
  afterEach(() => {
    __resetCollabStoreForTest();
  });

  it("listPendingApprovals 可按 agentId 过滤", async () => {
    const a1 = approval("agent-a", "tool-1");
    const a2 = approval("agent-b", "tool-2");
    const p1 = registerPendingApproval(a1);
    const p2 = registerPendingApproval(a2);

    expect(listPendingApprovals().map((p) => p.id)).toEqual([
      "agent-a:tool-1",
      "agent-b:tool-2",
    ]);
    expect(listPendingApprovals("agent-a").map((p) => p.id)).toEqual([
      "agent-a:tool-1",
    ]);
    expect(listPendingApprovals("missing")).toEqual([]);

    expect(resolveApproval(a1.id, { decision: "allow" })).toBe(true);
    expect(resolveApproval(a2.id, { decision: "deny" })).toBe(true);
    await expect(p1).resolves.toEqual({ decision: "allow" });
    await expect(p2).resolves.toEqual({ decision: "deny" });
  });
});

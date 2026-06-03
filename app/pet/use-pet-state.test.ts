import { describe, expect, it } from "vitest";
import type { PetSessionInfo } from "@/lib/electron-bridge";
import { derivePetAnimState, derivePetBubbleText } from "./use-pet-state";

function session(overrides: Partial<PetSessionInfo> = {}): PetSessionInfo {
  return {
    id: "s1",
    agentId: "a1",
    name: "demo",
    streaming: false,
    agentPhase: null,
    lastMessage: "done",
    currentTool: null,
    currentToolTarget: null,
    retry: null,
    compacting: false,
    pendingApproval: null,
    pendingClarification: null,
    budget: null,
    error: null,
    sseStatus: "active",
    streamingStartedAt: null,
    read: true,
    ...overrides,
  };
}

describe("pet state matrix", () => {
  it("offline outranks error and action-required states", () => {
    const s = session({
      sseStatus: "lost",
      error: "provider failed",
      pendingApproval: {
        count: 1,
        toolName: "Bash",
        toolTarget: "rm -rf build",
        createdAt: 1,
      },
      budget: {
        level: "blocked",
        label: "已暂停：预算到达上限",
        detail: "费用",
        triggered: ["cost"],
        peakRatio: 1,
      },
    });

    expect(derivePetAnimState(s)).toBe("offline");
    expect(derivePetBubbleText(s, "offline", Date.now()).primary).toBe(
      "连接已断开"
    );
  });

  it("approval outranks budget warning and running state", () => {
    const s = session({
      streaming: true,
      agentPhase: { kind: "running_tools", tools: [{ id: "t1", name: "Bash" }] },
      pendingApproval: {
        count: 2,
        toolName: "Bash",
        toolTarget: "rm -rf build",
        ruleId: "dangerous-bash-destructive",
        createdAt: 1,
      },
      budget: {
        level: "warning",
        label: "接近预算上限",
        detail: "轮次 82%",
        triggered: [],
        peakRatio: 0.82,
      },
    });

    expect(derivePetAnimState(s)).toBe("approval");
    const text = derivePetBubbleText(s, "approval", Date.now());
    expect(text.primary).toBe("等待授权 (2)");
    expect(text.secondary).toContain("Bash");
    expect(text.priority).toBe("high");
  });

  it("budget blocked outranks budget warning and normal completion", () => {
    const s = session({
      budget: {
        level: "blocked",
        label: "已暂停：预算到达上限",
        detail: "费用 / 时长",
        triggered: ["cost", "duration"],
        peakRatio: 1,
      },
    });

    expect(derivePetAnimState(s)).toBe("budget_blocked");
    const text = derivePetBubbleText(s, "budget_blocked", Date.now());
    expect(text.primary).toBe("已暂停：预算到达上限");
    expect(text.secondary).toBe("费用 / 时长");
    expect(text.priority).toBe("high");
  });

  it("clarification outranks budget blocked and asks user to confirm", () => {
    const s = session({
      pendingClarification: {
        count: 1,
        title: "需要你确认下一步",
        question: "先做 MVP 还是完整重构？",
        recommendedLabel: "先做 MVP",
        createdAt: 1,
      },
      budget: {
        level: "blocked",
        label: "已暂停：预算到达上限",
        detail: "费用",
        triggered: ["cost"],
        peakRatio: 1,
      },
    });

    expect(derivePetAnimState(s)).toBe("clarification");
    const text = derivePetBubbleText(s, "clarification", Date.now());
    expect(text.primary).toBe("等待你确认");
    expect(text.secondary).toBe("推荐：先做 MVP");
    expect(text.priority).toBe("high");
  });

  it("budget warning is visible before complete", () => {
    const s = session({
      budget: {
        level: "warning",
        label: "接近预算上限",
        detail: "轮次 82%",
        triggered: [],
        peakRatio: 0.82,
      },
    });

    expect(derivePetAnimState(s)).toBe("budget_warning");
    const text = derivePetBubbleText(s, "budget_warning", Date.now());
    expect(text.primary).toBe("接近预算上限");
    expect(text.secondary).toBe("轮次 82%");
    expect(text.priority).toBe("normal");
  });
});

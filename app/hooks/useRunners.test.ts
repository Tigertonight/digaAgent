import { describe, expect, it } from "vitest";
import { createInitialState } from "@/lib/chat-reducer";
import { DRAFT_KEY, emptyRunner, type RunnerState } from "@/lib/session-runner";
import { planRunnerEviction } from "./useRunners";

function runner(
  key: string,
  lastTouched: number,
  patch: Partial<RunnerState> = {}
): [string, RunnerState] {
  return [
    key,
    {
      ...emptyRunner(),
      lastTouched,
      ...patch,
    },
  ];
}

describe("planRunnerEviction", () => {
  it("evicts the coldest unprotected background runners first", () => {
    const runners = new Map<string, RunnerState>([
      runner(DRAFT_KEY, 0),
      runner("active", 1),
      runner("old", 2),
      runner("new", 3),
    ]);

    const plan = planRunnerEviction({
      runners,
      activeKey: "active",
      maxRunners: 3,
    });

    expect(plan).toEqual({ evict: ["old"], softLimitExceeded: false });
  });

  it("keeps streaming and waiting-user runners even when the limit is exceeded", () => {
    const waitingState = createInitialState();
    waitingState.messages.push({
      role: "assistant",
      text: "",
      parts: [
        {
          kind: "approval",
          id: "approval-1",
          toolCallId: "tool-1",
          toolName: "write",
          input: {},
          status: "pending",
          createdAt: 1,
        },
      ],
    });
    const runners = new Map<string, RunnerState>([
      runner(DRAFT_KEY, 0),
      runner("active", 1),
      runner("streaming", 2, { streaming: true }),
      runner("waiting", 3, { chatState: waitingState }),
    ]);

    const plan = planRunnerEviction({
      runners,
      activeKey: "active",
      maxRunners: 2,
    });

    expect(plan).toEqual({ evict: [], softLimitExceeded: true });
  });

  it("evicts available cold runners but reports soft overflow for the protected remainder", () => {
    const runners = new Map<string, RunnerState>([
      runner(DRAFT_KEY, 0),
      runner("active", 1),
      runner("cold", 2),
      runner("streaming", 3, { streaming: true }),
      runner("compacting", 4, { compacting: true }),
    ]);

    const plan = planRunnerEviction({
      runners,
      activeKey: "active",
      maxRunners: 2,
    });

    expect(plan).toEqual({ evict: ["cold"], softLimitExceeded: true });
  });
});

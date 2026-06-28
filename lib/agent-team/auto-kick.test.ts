import { describe, expect, it } from "vitest";
import { createInitialAgentTeamRun } from "./initial-run";
import { shouldAutoKickAgentTeamRun } from "./auto-kick";

function stalePendingRun(now: number) {
  return {
    ...createInitialAgentTeamRun("auto kick team"),
    createdAt: now - 120_000,
    updatedAt: now - 120_000,
    board: {
      ...createInitialAgentTeamRun("auto kick team").board,
      events: [],
      tasks: [
        {
          ...createInitialAgentTeamRun("auto kick team").board.tasks[0]!,
          status: "pending" as const,
        },
      ],
    },
    members: createInitialAgentTeamRun("auto kick team").members.map((member) => ({
      ...member,
      status: "idle" as const,
      lastActiveAt: now - 120_000,
      currentTaskId: undefined,
    })),
  };
}

describe("shouldAutoKickAgentTeamRun", () => {
  it("kicks a stale running team that has pending work but no active member", () => {
    const now = 10_000_000;
    expect(shouldAutoKickAgentTeamRun(stalePendingRun(now), now)).toBe(true);
  });

  it("does not kick immediately after a recent update", () => {
    const now = 10_000_000;
    const run = { ...stalePendingRun(now), updatedAt: now - 10_000 };
    expect(shouldAutoKickAgentTeamRun(run, now)).toBe(false);
  });

  it("does not kick while a task or member is actively running", () => {
    const now = 10_000_000;
    const withClaimedTask = {
      ...stalePendingRun(now),
      board: {
        ...stalePendingRun(now).board,
        tasks: [
          {
            ...stalePendingRun(now).board.tasks[0]!,
            status: "claimed" as const,
            claimedAt: now - 120_000,
          },
        ],
      },
    };
    const withWorkingMember = {
      ...stalePendingRun(now),
      members: stalePendingRun(now).members.map((member, index) =>
        index === 0 ? { ...member, status: "working" as const } : member
      ),
    };

    expect(shouldAutoKickAgentTeamRun(withClaimedTask, now)).toBe(false);
    expect(shouldAutoKickAgentTeamRun(withWorkingMember, now)).toBe(false);
  });

  it("does not kick terminal or already-idle-without-pending runs", () => {
    const now = 10_000_000;
    const completed = { ...stalePendingRun(now), status: "completed" as const };
    const noPending = {
      ...stalePendingRun(now),
      board: {
        ...stalePendingRun(now).board,
        tasks: [
          {
            ...stalePendingRun(now).board.tasks[0]!,
            status: "completed" as const,
          },
        ],
      },
    };

    expect(shouldAutoKickAgentTeamRun(completed, now)).toBe(false);
    expect(shouldAutoKickAgentTeamRun(noPending, now)).toBe(false);
  });
});

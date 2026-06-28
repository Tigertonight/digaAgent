import { describe, expect, it } from "vitest";
import { createInitialAgentTeamRun } from "./initial-run";
import {
  cleanupAgentTeamWorktrees,
  markMissingAgentTeamWorktrees,
  mergeAgentTeamMemberWorktree,
  prepareAgentTeamMemberWorktree,
} from "./worktree-policy";
import type { WorkflowWorktreeManager } from "@/lib/workflows/types";

function manager(path: string): WorkflowWorktreeManager {
  return {
    async create(input) {
      return {
        id: `${input.workflowId}:${input.name}`,
        path,
        branchName: `team/${input.name}`,
        baseRef: input.baseRef ?? "HEAD",
        createdAt: 123,
      };
    },
  };
}

describe("agent team worktree policy", () => {
  it("does not create worktrees when policy is none", async () => {
    const run = createInitialAgentTeamRun("plain team", {
      allowWorktree: false,
      worktreePolicy: "none",
    });
    const member = run.members.find((item) => item.id !== run.leadAgentId)!;

    const result = await prepareAgentTeamMemberWorktree({
      run,
      member,
      cwd: "/repo",
      manager: manager("/repo/worktree"),
    });

    expect(result.cwd).toBe("/repo");
    expect(result.member.worktree).toBeUndefined();
    expect(result.event).toBeUndefined();
  });

  it("creates a per-member worktree and points teammate cwd at it", async () => {
    const run = createInitialAgentTeamRun("isolated team", {
      allowWorktree: true,
      worktreePolicy: "per_member",
    });
    const member = run.members.find((item) => item.id !== run.leadAgentId)!;

    const result = await prepareAgentTeamMemberWorktree({
      run,
      member,
      cwd: "/repo",
      manager: manager("/tmp/team-worktree/member-a"),
      now: 456,
    });

    expect(result.cwd).toBe("/tmp/team-worktree/member-a");
    expect(result.worktreeRoot).toBe("/tmp/team-worktree");
    expect(result.member.worktree).toMatchObject({
      path: "/tmp/team-worktree/member-a",
      status: "active",
    });
    expect(result.event?.type).toBe("worktree_created");
  });

  it("blocks the member when worktree creation fails instead of using shared cwd", async () => {
    const run = createInitialAgentTeamRun("failed isolation team", {
      allowWorktree: true,
      worktreePolicy: "per_member",
    });
    const member = run.members.find((item) => item.id !== run.leadAgentId)!;

    const result = await prepareAgentTeamMemberWorktree({
      run,
      member,
      cwd: "/repo",
      manager: {
        async create() {
          throw new Error("not a git repo");
        },
      },
      now: 789,
    });

    expect(result.cwd).toBe("/repo");
    expect(result.member.status).toBe("blocked");
    expect(result.member.worktree?.status).toBe("failed");
    expect(result.member.latestOutput).toContain("未回退到共享目录");
    expect(result.event?.type).toBe("worktree_failed");
  });

  it("accepts a member worktree by merging it and closing the member status", async () => {
    const run = createInitialAgentTeamRun("merge isolated team", {
      allowWorktree: true,
      worktreePolicy: "per_member",
    });
    const member = run.members.find((item) => item.id !== run.leadAgentId)!;
    const withWorktree = {
      ...run,
      members: run.members.map((item) =>
        item.id === member.id
          ? {
              ...item,
              worktree: {
                id: "wt-1",
                path: "/tmp/wt-1",
                branchName: "team/wt-1",
                baseRef: "HEAD",
                status: "active" as const,
                createdAt: 1,
              },
            }
          : item
      ),
    };

    const result = await mergeAgentTeamMemberWorktree({
      run: withWorktree,
      memberId: member.id,
      strategy: "accept",
      cwd: "/repo",
      manager: {
        async create() {
          throw new Error("unused");
        },
        async merge(worktree) {
          return {
            worktreeId: worktree.id,
            path: worktree.path,
            branchName: worktree.branchName,
            mergedAt: 2,
            applied: true,
            summary: "patched",
          };
        },
      },
      now: 2,
    });

    expect(result.error).toBeUndefined();
    expect(result.run.members.find((item) => item.id === member.id)?.worktree?.status).toBe("merged");
    expect(result.event?.type).toBe("worktree_merged");
  });

  it("keeps a failed merge as pending for manual handling", async () => {
    const run = createInitialAgentTeamRun("pending isolated team", {
      allowWorktree: true,
      worktreePolicy: "per_member",
    });
    const member = run.members.find((item) => item.id !== run.leadAgentId)!;
    const withWorktree = {
      ...run,
      members: run.members.map((item) =>
        item.id === member.id
          ? {
              ...item,
              worktree: {
                id: "wt-2",
                path: "/tmp/wt-2",
                branchName: "team/wt-2",
                baseRef: "HEAD",
                status: "active" as const,
                createdAt: 1,
              },
            }
          : item
      ),
    };

    const result = await mergeAgentTeamMemberWorktree({
      run: withWorktree,
      memberId: member.id,
      strategy: "accept",
      cwd: "/repo",
      manager: {
        async create() {
          throw new Error("unused");
        },
        async merge() {
          throw new Error("conflict");
        },
      },
      now: 3,
    });

    expect(result.error).toContain("conflict");
    expect(result.run.members.find((item) => item.id === member.id)?.worktree?.status).toBe("merge_pending");
    expect(result.event?.type).toBe("worktree_failed");
  });

  it("marks active worktrees as failed when their path disappears", () => {
    const run = createInitialAgentTeamRun("missing path team", {
      allowWorktree: true,
      worktreePolicy: "per_member",
    });
    const member = run.members.find((item) => item.id !== run.leadAgentId)!;
    const withWorktree = {
      ...run,
      members: run.members.map((item) =>
        item.id === member.id
          ? {
              ...item,
              worktree: {
                id: "wt-missing",
                path: "/tmp/wt-missing",
                branchName: "team/wt-missing",
                baseRef: "HEAD",
                status: "active" as const,
                createdAt: 1,
              },
            }
          : item
      ),
    };

    const result = markMissingAgentTeamWorktrees(withWorktree, () => false, 4);

    expect(result.missingMemberIds).toEqual([member.id]);
    expect(result.run.members.find((item) => item.id === member.id)?.status).toBe("blocked");
    expect(result.run.members.find((item) => item.id === member.id)?.worktree?.status).toBe("failed");
    expect(result.run.board.events.at(-1)?.type).toBe("worktree_failed");
  });

  it("cleans active worktrees during team shutdown", async () => {
    const run = createInitialAgentTeamRun("cleanup isolated team", {
      allowWorktree: true,
      worktreePolicy: "per_member",
    });
    const member = run.members.find((item) => item.id !== run.leadAgentId)!;
    const removed: string[] = [];
    const withWorktree = {
      ...run,
      members: run.members.map((item) =>
        item.id === member.id
          ? {
              ...item,
              worktree: {
                id: "wt-clean",
                path: "/tmp/wt-clean",
                branchName: "team/wt-clean",
                baseRef: "HEAD",
                status: "active" as const,
                createdAt: 1,
              },
            }
          : item
      ),
    };

    const result = await cleanupAgentTeamWorktrees({
      run: withWorktree,
      cwd: "/repo",
      manager: {
        async create() {
          throw new Error("unused");
        },
        async remove(worktree) {
          removed.push(worktree.path);
        },
      },
      now: 5,
    });

    expect(removed).toEqual(["/tmp/wt-clean"]);
    expect(result.cleanedMemberIds).toEqual([member.id]);
    expect(result.run.members.find((item) => item.id === member.id)?.worktree?.status).toBe("cleaned");
    expect(result.run.board.events.at(-1)?.type).toBe("worktree_cleaned");
  });
});

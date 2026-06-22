import path from "node:path";
import type { WorkflowWorktree, WorkflowWorktreeManager } from "@/lib/workflows/types";
import { createGitWorktreeManager } from "@/lib/workflows/git-worktree";
import type { AgentTeamEvent, AgentTeamMember, AgentTeamRun } from "./types";

export interface AgentTeamMemberWorktreeResult {
  member: AgentTeamMember;
  cwd: string;
  worktreeRoot?: string;
  event?: AgentTeamEvent;
}

export type AgentTeamWorktreeMergeStrategy = "accept" | "discard" | "keep_branch";

export interface AgentTeamWorktreeMergeResult {
  run: AgentTeamRun;
  event?: AgentTeamEvent;
  error?: string;
}

export interface AgentTeamWorktreeCleanupResult {
  run: AgentTeamRun;
  cleanedMemberIds: string[];
  failedMemberIds: string[];
}

export interface AgentTeamWorktreeValidationResult {
  run: AgentTeamRun;
  missingMemberIds: string[];
}

export function createAgentTeamWorktreeManager(cwd: string): WorkflowWorktreeManager {
  return createGitWorktreeManager(cwd);
}

export function shouldCreatePerMemberWorktree(run: AgentTeamRun): boolean {
  return run.settings.allowWorktree === true && run.settings.worktreePolicy === "per_member";
}

function memberWorktreeName(member: AgentTeamMember): string {
  return member.id.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 64) || "member";
}

export async function prepareAgentTeamMemberWorktree(opts: {
  run: AgentTeamRun;
  member: AgentTeamMember;
  cwd: string;
  manager?: WorkflowWorktreeManager;
  now?: number;
}): Promise<AgentTeamMemberWorktreeResult> {
  if (!shouldCreatePerMemberWorktree(opts.run)) {
    return { member: opts.member, cwd: opts.cwd };
  }

  const now = opts.now ?? Date.now();
  const manager = opts.manager ?? createAgentTeamWorktreeManager(opts.cwd);
  try {
    const worktree = await manager.create({
      workflowId: opts.run.id,
      name: memberWorktreeName(opts.member),
      baseRef: "HEAD",
    });
    return {
      member: {
        ...opts.member,
        worktree: {
          ...worktree,
          status: "active",
        },
      },
      cwd: worktree.path,
      worktreeRoot: path.dirname(worktree.path),
      event: {
        id: `${opts.run.id}:event:worktree:${opts.member.id}`,
        type: "worktree_created",
        at: now,
        actorAgentId: opts.run.leadAgentId,
        targetAgentId: opts.member.id,
        message: `${opts.member.name} isolated worktree created.`,
        data: {
          worktreeId: worktree.id,
          path: worktree.path,
          branchName: worktree.branchName,
          baseRef: worktree.baseRef,
        },
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      member: {
        ...opts.member,
        status: "blocked",
        latestOutput: `Worktree 创建失败，未回退到共享目录：${reason}`,
        lastActiveAt: now,
        worktree: {
          id: `${opts.run.id}:${opts.member.id}:failed`,
          path: opts.cwd,
          branchName: "",
          baseRef: "HEAD",
          status: "failed",
          createdAt: now,
          failureReason: reason,
        },
      },
      cwd: opts.cwd,
      event: {
        id: `${opts.run.id}:event:worktree-failed:${opts.member.id}`,
        type: "worktree_failed",
        at: now,
        actorAgentId: opts.run.leadAgentId,
        targetAgentId: opts.member.id,
        message: `${opts.member.name} isolated worktree creation failed.`,
        data: { reason },
      },
    };
  }
}

function memberWorkflowWorktree(member: AgentTeamMember): WorkflowWorktree | null {
  if (!member.worktree || member.worktree.status === "failed") return null;
  return {
    id: member.worktree.id,
    path: member.worktree.path,
    branchName: member.worktree.branchName,
    baseRef: member.worktree.baseRef,
    createdAt: member.worktree.createdAt,
  };
}

export function hasUnmergedAgentTeamWorktrees(run: AgentTeamRun): boolean {
  return run.members.some(
    (member) =>
      member.worktree?.status === "active" ||
      member.worktree?.status === "merge_pending"
  );
}

export function markMissingAgentTeamWorktrees(
  run: AgentTeamRun,
  pathExists: (path: string) => boolean,
  now = Date.now()
): AgentTeamWorktreeValidationResult {
  const missingMemberIds: string[] = [];
  const events: AgentTeamEvent[] = [];
  const members = run.members.map((member) => {
    if (
      member.worktree?.status !== "active" &&
      member.worktree?.status !== "merge_pending"
    ) {
      return member;
    }
    if (pathExists(member.worktree.path)) return member;
    missingMemberIds.push(member.id);
    events.push({
      id: `${run.id}:event:worktree-missing:${member.id}:${now}`,
      type: "worktree_failed",
      at: now,
      actorAgentId: run.leadAgentId,
      targetAgentId: member.id,
      message: `${member.name} worktree path is missing.`,
      data: { worktreeId: member.worktree.id, path: member.worktree.path },
    });
    return {
      ...member,
      status: "blocked" as const,
      latestOutput: `Worktree 路径不存在，需要保留/丢弃或替换成员：${member.worktree.path}`,
      lastActiveAt: now,
      worktree: {
        ...member.worktree,
        status: "failed" as const,
        failureReason: `worktree path missing: ${member.worktree.path}`,
      },
    };
  });
  if (missingMemberIds.length === 0) return { run, missingMemberIds };
  return {
    missingMemberIds,
    run: {
      ...run,
      members,
      board: { ...run.board, events: [...run.board.events, ...events] },
      updatedAt: now,
    },
  };
}

export async function cleanupAgentTeamWorktrees(opts: {
  run: AgentTeamRun;
  cwd: string;
  manager?: WorkflowWorktreeManager;
  now?: number;
}): Promise<AgentTeamWorktreeCleanupResult> {
  const now = opts.now ?? Date.now();
  const manager = opts.manager ?? createAgentTeamWorktreeManager(opts.cwd);
  const cleanedMemberIds: string[] = [];
  const failedMemberIds: string[] = [];
  const events: AgentTeamEvent[] = [];
  const members: AgentTeamMember[] = [];

  for (const member of opts.run.members) {
    const worktree = memberWorkflowWorktree(member);
    if (
      !worktree ||
      (member.worktree?.status !== "active" && member.worktree?.status !== "merge_pending")
    ) {
      members.push(member);
      continue;
    }
    try {
      if (manager.remove) await manager.remove(worktree);
      cleanedMemberIds.push(member.id);
      events.push({
        id: `${opts.run.id}:event:worktree-cleanup:${member.id}:${now}`,
        type: "worktree_cleaned",
        at: now,
        actorAgentId: opts.run.leadAgentId,
        targetAgentId: member.id,
        message: `${member.name} worktree cleaned during team shutdown.`,
        data: { worktreeId: worktree.id, path: worktree.path },
      });
      members.push({
        ...member,
        worktree: { ...member.worktree!, status: "cleaned" as const },
        latestOutput: "Team 停止时已清理 worktree。",
        lastActiveAt: now,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failedMemberIds.push(member.id);
      events.push({
        id: `${opts.run.id}:event:worktree-cleanup-failed:${member.id}:${now}`,
        type: "worktree_failed",
        at: now,
        actorAgentId: opts.run.leadAgentId,
        targetAgentId: member.id,
        message: `${member.name} worktree cleanup failed during team shutdown.`,
        data: { worktreeId: worktree.id, path: worktree.path, reason },
      });
      members.push({
        ...member,
        worktree: {
          ...member.worktree!,
          status: "merge_pending" as const,
          failureReason: reason,
        },
        latestOutput: `Team 停止时清理 worktree 失败：${reason}`,
        lastActiveAt: now,
      });
    }
  }

  if (cleanedMemberIds.length === 0 && failedMemberIds.length === 0) {
    return { run: opts.run, cleanedMemberIds, failedMemberIds };
  }
  return {
    cleanedMemberIds,
    failedMemberIds,
    run: {
      ...opts.run,
      members,
      board: { ...opts.run.board, events: [...opts.run.board.events, ...events] },
      updatedAt: now,
    },
  };
}

export async function mergeAgentTeamMemberWorktree(opts: {
  run: AgentTeamRun;
  memberId: string;
  strategy: AgentTeamWorktreeMergeStrategy;
  cwd: string;
  manager?: WorkflowWorktreeManager;
  now?: number;
}): Promise<AgentTeamWorktreeMergeResult> {
  const now = opts.now ?? Date.now();
  const member = opts.run.members.find((item) => item.id === opts.memberId);
  if (!member) return { run: opts.run, error: "team member not found" };
  const worktree = memberWorkflowWorktree(member);
  if (!worktree) return { run: opts.run, error: "team member has no mergeable worktree" };
  if (member.worktree?.status === "merged" || member.worktree?.status === "cleaned") {
    return { run: opts.run, error: "worktree is already closed" };
  }

  const manager = opts.manager ?? createAgentTeamWorktreeManager(opts.cwd);
  try {
    if (opts.strategy === "keep_branch") {
      const event: AgentTeamEvent = {
        id: `${opts.run.id}:event:worktree-keep:${opts.memberId}:${now}`,
        type: "worktree_cleaned",
        at: now,
        actorAgentId: opts.run.leadAgentId,
        targetAgentId: opts.memberId,
        message: `${member.name} worktree kept for manual merge.`,
        data: { worktreeId: worktree.id, path: worktree.path, strategy: opts.strategy },
      };
      return {
        run: {
          ...opts.run,
          members: opts.run.members.map((item) =>
            item.id === opts.memberId && item.worktree
              ? {
                  ...item,
                  worktree: { ...item.worktree, status: "merge_pending" as const },
                  latestOutput: "Worktree 已保留，等待手动 merge 或 discard。",
                  lastActiveAt: now,
                }
              : item
          ),
          board: { ...opts.run.board, events: [...opts.run.board.events, event] },
          updatedAt: now,
        },
        event,
      };
    }

    const mergeResult =
      opts.strategy === "accept" && manager.merge
        ? await manager.merge(worktree)
        : undefined;
    if (opts.strategy === "accept" && !manager.merge) {
      throw new Error("worktree manager does not support merge");
    }
    if (opts.strategy === "discard" && manager.remove) {
      await manager.remove(worktree);
    }
    const nextStatus = opts.strategy === "accept" ? "merged" : "cleaned";
    const event: AgentTeamEvent = {
      id: `${opts.run.id}:event:worktree-${opts.strategy}:${opts.memberId}:${now}`,
      type: opts.strategy === "accept" ? "worktree_merged" : "worktree_cleaned",
      at: now,
      actorAgentId: opts.run.leadAgentId,
      targetAgentId: opts.memberId,
      message:
        opts.strategy === "accept"
          ? `${member.name} worktree merged.`
          : `${member.name} worktree discarded.`,
      data: {
        worktreeId: worktree.id,
        path: worktree.path,
        strategy: opts.strategy,
        summary: mergeResult?.summary,
        applied: mergeResult?.applied,
      },
    };
    return {
      run: {
        ...opts.run,
        members: opts.run.members.map((item) =>
          item.id === opts.memberId && item.worktree
            ? {
                ...item,
                worktree: { ...item.worktree, status: nextStatus },
                latestOutput:
                  opts.strategy === "accept"
                    ? "Worktree diff 已合并回主工作区。"
                    : "Worktree 已丢弃并清理。",
                lastActiveAt: now,
              }
            : item
        ),
        board: { ...opts.run.board, events: [...opts.run.board.events, event] },
        updatedAt: now,
      },
      event,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const event: AgentTeamEvent = {
      id: `${opts.run.id}:event:worktree-merge-failed:${opts.memberId}:${now}`,
      type: "worktree_failed",
      at: now,
      actorAgentId: opts.run.leadAgentId,
      targetAgentId: opts.memberId,
      message: `${member.name} worktree ${opts.strategy} failed.`,
      data: { worktreeId: worktree.id, path: worktree.path, strategy: opts.strategy, reason },
    };
    return {
      run: {
        ...opts.run,
        members: opts.run.members.map((item) =>
          item.id === opts.memberId && item.worktree
            ? {
                ...item,
                worktree: {
                  ...item.worktree,
                  status: "merge_pending" as const,
                  failureReason: reason,
                },
                latestOutput: `Worktree ${opts.strategy} 失败：${reason}`,
                lastActiveAt: now,
              }
            : item
        ),
        board: { ...opts.run.board, events: [...opts.run.board.events, event] },
        updatedAt: now,
      },
      event,
      error: reason,
    };
  }
}

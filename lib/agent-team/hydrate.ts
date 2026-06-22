import type { AgentTeamMember, AgentTeamRun } from "./types";

export interface HydrateAgentTeamOptions {
  recreateIdleTeammates?: boolean;
  sessionExists?: (sessionFile: string) => boolean;
  recreateMember?: (
    member: AgentTeamMember
  ) => Promise<{ agentId: string; sessionFile?: string; modelId?: string }>;
  now?: number;
}

export interface HydrateAgentTeamResult {
  run: AgentTeamRun;
  rehydrated: string[];
  missing: string[];
  replaced: string[];
}

function eventId(run: AgentTeamRun, suffix: string): string {
  return `${run.id}:event:hydrate:${Date.now()}:${suffix}`;
}

export async function hydrateAgentTeamRun(
  run: AgentTeamRun,
  opts: HydrateAgentTeamOptions = {}
): Promise<HydrateAgentTeamResult> {
  const now = opts.now ?? Date.now();
  const recreate = opts.recreateIdleTeammates === true;
  const rehydrated: string[] = [];
  const missing: string[] = [];
  const replaced: string[] = [];
  const nextMembers: AgentTeamMember[] = [];

  for (const member of run.members) {
    if (member.id === run.leadAgentId) {
      nextMembers.push({ ...member, hydrateState: "intact" });
      continue;
    }

    if (!member.sessionFile) {
      missing.push(member.id);
      nextMembers.push({
        ...member,
        agentId: undefined,
        status: "blocked",
        hydrateState: "missing",
        latestOutput: "成员会话记录缺失，需要替换成员后才能继续。",
        lastActiveAt: now,
      });
      continue;
    }

    if (opts.sessionExists && !opts.sessionExists(member.sessionFile)) {
      missing.push(member.id);
      nextMembers.push({
        ...member,
        agentId: undefined,
        status: "blocked",
        hydrateState: "missing",
        latestOutput: "成员会话文件不存在，需要替换成员后才能继续。",
        lastActiveAt: now,
      });
      continue;
    }

    if (!recreate || !opts.recreateMember) {
      nextMembers.push({
        ...member,
        hydrateState: member.agentId ? "intact" : "missing",
        status: member.agentId ? member.status : "blocked",
        latestOutput: member.agentId
          ? member.latestOutput
          : "成员 runtime 尚未重建；点击 Resume Team 后再继续。",
      });
      if (!member.agentId) missing.push(member.id);
      continue;
    }

    try {
      const created = await opts.recreateMember(member);
      rehydrated.push(member.id);
      nextMembers.push({
        ...member,
        agentId: created.agentId,
        sessionFile: created.sessionFile ?? member.sessionFile,
        modelId: created.modelId ?? member.modelId,
        status: "idle",
        currentTaskId: undefined,
        hydrateState: "rehydrated",
        latestOutput: "成员会话已恢复，等待自动分配下一步。",
        lastActiveAt: now,
      });
    } catch (err) {
      replaced.push(member.id);
      nextMembers.push({
        ...member,
        agentId: undefined,
        status: "blocked",
        hydrateState: "replaced",
        latestOutput: `成员会话重建失败，需要替换成员：${
          err instanceof Error ? err.message : String(err)
        }`,
        lastActiveAt: now,
      });
    }
  }

  const runStatus =
    recreate && missing.length === 0 && replaced.length === 0
      ? "running"
      : run.status === "running"
        ? "paused"
        : run.status;
  const message = recreate
    ? `Team hydrate finished: ${rehydrated.length} rehydrated, ${missing.length} missing, ${replaced.length} replaced.`
    : `Team hydrate inspected: ${missing.length} teammate session(s) need resume or replacement.`;

  return {
    run: {
      ...run,
      status: runStatus,
      members: nextMembers,
      hydrate: {
        lastHydratedAt: now,
        rehydratedMemberIds: rehydrated,
        missingMemberIds: [...missing, ...replaced],
        notes: message,
      },
      board: {
        ...run.board,
        events: [
          ...run.board.events,
          {
            id: eventId(run, `${run.board.events.length + 1}`),
            type: runStatus === "running" ? "team_resumed" : "team_paused",
            at: now,
            actorAgentId: run.leadAgentId,
            message,
            data: { rehydrated, missing, replaced },
          },
        ],
      },
      updatedAt: now,
    },
    rehydrated,
    missing,
    replaced,
  };
}

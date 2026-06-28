import type { AgentTeamRun } from "./types";

export function shouldAutoKickAgentTeamRun(
  run: AgentTeamRun,
  now: number,
  opts: { staleMs?: number } = {}
): boolean {
  if (run.status !== "running") return false;
  const pendingTasks = run.board.tasks.filter((task) => task.status === "pending");
  if (pendingTasks.length === 0) return false;
  const activeTasks = run.board.tasks.filter(
    (task) => task.status === "claimed" || task.status === "running"
  );
  if (activeTasks.length > 0) return false;
  const workingMembers = run.members.filter((member) => member.status === "working");
  if (workingMembers.length > 0) return false;
  const latestEventAt = Math.max(0, ...run.board.events.map((event) => event.at ?? 0));
  const latestMemberAt = Math.max(
    0,
    ...run.members.map((member) => member.lastActiveAt ?? 0)
  );
  const lastTouched = Math.max(
    run.updatedAt ?? 0,
    run.createdAt ?? 0,
    latestEventAt,
    latestMemberAt
  );
  return now - lastTouched >= (opts.staleMs ?? 45_000);
}

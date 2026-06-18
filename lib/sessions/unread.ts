import type { SessionInfoLite } from "@/lib/types";

/**
 * Sidebar 未读蓝点判定：以「上一轮 agent_end 时间」为准，
 * 中间 turn 的 message_end 不应触发未读重置。没有 lastAgentEndAt
 * （老 session / 导入会话 / 还没跑过 agent）时回退到 modified，
 * 保留原有提醒能力。返回 ISO 字符串，方便和 lastSeenMap 比较。
 */
export function deriveSessionUnreadAt(session: SessionInfoLite): string {
  if (typeof session.lastAgentEndAt === "number" && session.lastAgentEndAt > 0) {
    return new Date(session.lastAgentEndAt).toISOString();
  }
  return session.modified;
}

/**
 * 比较 seenAt（用户最近聚焦时间）与 unreadAt（上一轮活动时间）。
 * 用户没有 seenAt（首次看到这个 session）时按未读处理。
 */
export function isSessionUnread(args: {
  session: SessionInfoLite;
  seenAt: string | null | undefined;
  isRunning: boolean;
  isWaitingUser: boolean;
}): boolean {
  if (args.isRunning || args.isWaitingUser) return false;
  const unreadAt = deriveSessionUnreadAt(args.session);
  if (!args.seenAt) return true;
  const seenMs = Date.parse(args.seenAt);
  const unreadMs = Date.parse(unreadAt);
  if (!Number.isFinite(seenMs) || !Number.isFinite(unreadMs)) {
    return args.seenAt < unreadAt;
  }
  return seenMs < unreadMs;
}

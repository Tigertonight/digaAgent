import type { SessionInfoLite } from "@/lib/types";

export interface OptimisticSessionInput {
  /** 新 session 的 id（来自 /api/agent/new 返回 sessionId）。必填。 */
  id: string;
  /** ~/.pi/sessions/<id>.jsonl 路径（来自 /api/agent/new 返回 sessionFile）。 */
  path: string;
  /** 创建该 session 时使用的 cwd。 */
  cwd: string;
  /** 用户第一条消息的可见文本（用于 sidebar 显示，可与 firstMessage 一致）。 */
  firstMessage?: string;
  /** parent session path（如果是 fork 出来的），保留 fork 关系分组。 */
  parentSessionPath?: string;
}

/**
 * 把"刚刚发出的新 session"立刻 upsert 进 sessions state 顶端。
 *
 * 设计要点：
 *   - 已存在同 id：保留服务端字段（messageCount / modified / meta 等），
 *     **只**给空字段补值；不会把已经有真实数据的 session 反向打回 optimistic。
 *   - 不存在同 id：插到列表 **顶部**，runtimeState="loading"、isRunning=true，
 *     用户立刻看到一条新会话；后续 refreshSessions 会把它替换为服务端真值。
 *   - firstMessage trim 到 200 字符（和 SessionManager.listAll 行为一致），
 *     防止粘贴长 prompt 时 sidebar 撑爆。
 *
 * 不直接修改入参 list，返回新数组（适合 setSessions(prev => upsert(prev, ...))）。
 */
export function upsertOptimisticSession(
  list: SessionInfoLite[],
  input: OptimisticSessionInput
): SessionInfoLite[] {
  if (!input.id || !input.path) return list;
  const idx = list.findIndex((s) => s.id === input.id);
  const nowIso = new Date().toISOString();
  const trimmedFirst = (input.firstMessage ?? "").slice(0, 200);

  if (idx >= 0) {
    // 存在：只补空字段；不破坏 messageCount / modified / meta / 各运行时计数
    const cur = list[idx];
    const merged: SessionInfoLite = {
      ...cur,
      // 路径 / cwd 一般不变；服务端写过就以它为准。
      path: cur.path || input.path,
      cwd: cur.cwd || input.cwd,
      name:
        cur.name && cur.name !== "(empty)"
          ? cur.name
          : cur.firstMessage && cur.firstMessage.length > 0
          ? cur.name
          : trimmedFirst || cur.name,
      firstMessage:
        cur.firstMessage && cur.firstMessage.length > 0
          ? cur.firstMessage
          : trimmedFirst,
      parentSessionPath: cur.parentSessionPath ?? input.parentSessionPath,
      // runtime hint：只在没有任何 runtime 信号时给一次 "loading"，
      // 否则尊重 runtime（streaming / waiting_user 等）。
      runtimeState: cur.runtimeState ?? "loading",
      isRunning: cur.isRunning ?? true,
    };
    if (
      merged.firstMessage === cur.firstMessage &&
      merged.name === cur.name &&
      merged.runtimeState === cur.runtimeState &&
      merged.isRunning === cur.isRunning &&
      merged.parentSessionPath === cur.parentSessionPath
    ) {
      return list;
    }
    const next = list.slice();
    next[idx] = merged;
    return next;
  }

  // 不存在：插到顶部
  const optimistic: SessionInfoLite = {
    id: input.id,
    path: input.path,
    cwd: input.cwd,
    parentSessionPath: input.parentSessionPath,
    created: nowIso,
    modified: nowIso,
    name: trimmedFirst || "新会话",
    messageCount: trimmedFirst ? 1 : 0,
    firstMessage: trimmedFirst,
    isRunning: true,
    runtimeState: "loading",
    runtimeUpdatedAt: Date.now(),
  };
  return [optimistic, ...list];
}

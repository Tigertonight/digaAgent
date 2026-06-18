/**
 * SessionManager 封装。
 * - listAll: 列出所有 session（跨所有 cwd）
 * - openById: 通过 session id 找到对应 .jsonl 文件并 open
 *
 * 注意：pi-coding-agent 是 Node-only ESM 包，必须在 runtime=nodejs 的路由里用。
 */
import "server-only";
import {
  buildSessionContext,
  SessionManager,
  type SessionInfo,
  type SessionEntry,
  type SessionHeader,
  type SessionContext,
} from "@earendil-works/pi-coding-agent";
import { stripContextAside } from "./context-aside";
import { batchReadMeta } from "./meta/store";
import type { SessionMeta } from "./meta/types";
import type { SessionRuntimePhase } from "./types";

export type { SessionInfo, SessionEntry, SessionHeader, SessionContext };

/** SessionInfo + 运行时状态（运行中 / 空闲）+ 自维护元数据。 */
export type SessionInfoWithStatus = SessionInfo & {
  isRunning: boolean;
  runtimeState?: SessionRuntimePhase;
  waitingApprovalCount?: number;
  waitingClarificationCount?: number;
  lastEventSeq?: number;
  runtimeUpdatedAt?: number;
  /** 上一轮 agent_end 的时间戳（ms），用于 sidebar 未读蒙点。 */
  lastAgentEndAt?: number | null;
  /** RFC-3 Phase A：~/.diga-agent/sessions/{id}.meta.json 内容，未建时缺省 undefined */
  meta?: SessionMeta;
};

/**
 * 列出所有 session，按 "pinned → isRunning → modified 倒序" 排序。
 *
 * RFC-3 Phase A2：批量聚合 meta（pinned / title）。
 * 性能：100 session 增量 ~50ms，可接受；500+ 再考虑 SQLite。
 */
export async function listAllSessions(): Promise<SessionInfoWithStatus[]> {
  // 在这里做一次动态 import,避免 client bundle 误把 server-only 的 agent-registry
  // 拉进来 —— 这个文件本身有 "server-only" 守门,但 import 顺序还是显式更清楚。
  const { listAgentSummaries } = await import("./agent-registry");
  const summaries = listAgentSummaries().filter(
    (agent) => !agent.hidden && agent.sessionFile
  );
  const runtimeByPath = new Map(
    summaries.map((agent) => [agent.sessionFile!, agent])
  );
  const list = await SessionManager.listAll();
  const onDiskPaths = new Set(list.map((s) => s.path));
  const metas = await batchReadMeta(list.map((s) => s.id));
  const enriched: SessionInfoWithStatus[] = list.map((s) => {
    const runtime = runtimeByPath.get(s.path);
    return {
      ...s,
      isRunning: runtime?.runtimeState === "streaming" || runtime?.isStreaming === true,
      runtimeState: runtime?.runtimeState,
      waitingApprovalCount: runtime?.waitingApprovalCount,
      waitingClarificationCount: runtime?.waitingClarificationCount,
      lastEventSeq: runtime?.lastEventSeq,
      runtimeUpdatedAt: runtime?.updatedAt,
      lastAgentEndAt: runtime?.lastAgentEndAt ?? null,
      meta: metas.get(s.id),
    };
  });

  // P4 兑底：registry 里有 sessionFile / sessionId 但 SessionManager.listAll() 还
  // 拾不到的（SDK 还没把首行落盘、文件刚创建还没被底层缓存拿到等）补一个
  // stub。它是“运行中会话”，不会在代码仓库里太久。后续正常 listAll 拾到后
  // id 冲突，不会重复。
  const stubMetas = await batchReadMeta(
    summaries
      .filter((s) => !onDiskPaths.has(s.sessionFile!))
      .map((s) => s.sessionId)
      .filter((sid): sid is string => Boolean(sid))
  );
  for (const summary of summaries) {
    if (!summary.sessionFile) continue;
    if (onDiskPaths.has(summary.sessionFile)) continue;
    if (!summary.sessionId) continue;
    const now = new Date(summary.updatedAt ?? Date.now());
    enriched.push({
      id: summary.sessionId,
      path: summary.sessionFile,
      cwd: summary.cwd ?? "",
      created: now,
      modified: now,
      messageCount: 0,
      firstMessage: "",
      allMessagesText: "",
      isRunning:
        summary.runtimeState === "streaming" || summary.isStreaming === true,
      runtimeState: summary.runtimeState,
      waitingApprovalCount: summary.waitingApprovalCount,
      waitingClarificationCount: summary.waitingClarificationCount,
      lastEventSeq: summary.lastEventSeq,
      runtimeUpdatedAt: summary.updatedAt,
      lastAgentEndAt: summary.lastAgentEndAt ?? null,
      meta: stubMetas.get(summary.sessionId),
    });
  }

  return enriched.sort((a, b) => {
    // pinned 始终最优先（无论是否 running）
    const ap = a.meta?.pinned ? 1 : 0;
    const bp = b.meta?.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    const aw = a.runtimeState === "waiting_user" ? 1 : 0;
    const bw = b.runtimeState === "waiting_user" ? 1 : 0;
    if (aw !== bw) return bw - aw;
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    return b.modified.getTime() - a.modified.getTime();
  });
}

/** 通过 session id 找到对应文件路径 */
export async function findSessionPathById(id: string): Promise<string | null> {
  const all = await SessionManager.listAll();
  const hit = all.find((s) => s.id === id);
  return hit?.path ?? null;
}

/**
 * S4: 校验客户端传入的 sessionPath 确实属于 expectedId 的已知 session 文件，
 * 再返回该 path；否则返回 null。
 *
 * 防止 `?path=` 被用来读任意文件：旧实现先 SessionManager.open(任意 path) 再比对
 * sessionId，等于在校验前就已经打开/解析了攻击者指定的文件（可探测存在性 / 触发
 * 带路径的解析错误）。这里改为先用 listAll() 的可信清单做精确匹配，匹配上才返回
 * 那条**清单里登记的 path**（而非客户端原样回传的字符串），从根上杜绝越权读。
 */
export async function resolveTrustedSessionPath(
  sessionPath: string,
  expectedId: string
): Promise<string | null> {
  if (!sessionPath || !expectedId) return null;
  const all = await SessionManager.listAll();
  const hit = all.find((s) => s.id === expectedId && s.path === sessionPath);
  return hit?.path ?? null;
}

/**
 * 收集 root 这条 session 的所有后代（含自身），通过 parentSessionPath 链接，
 * BFS 找到所有以 root.path 为祖先的子 session。返回顺序：root 在前，后代在后。
 *
 * 用于级联删除——父 session 删掉后，从它 fork 出来的所有 child（含 child 的
 * child）必须一起清理，否则会变成游离的孤儿文件，UI 里又找不到入口。
 */
export async function collectSessionDescendants(
  rootId: string
): Promise<Array<{ id: string; path: string }> | null> {
  const all = await SessionManager.listAll();
  const root = all.find((s) => s.id === rootId);
  if (!root) return null;

  // 按 parent path 建索引：parentPath -> children[]
  const childrenByParent = new Map<string, SessionInfo[]>();
  for (const s of all) {
    if (!s.parentSessionPath) continue;
    const arr = childrenByParent.get(s.parentSessionPath) ?? [];
    arr.push(s);
    childrenByParent.set(s.parentSessionPath, arr);
  }

  const out: Array<{ id: string; path: string }> = [];
  const seen = new Set<string>();
  const queue: SessionInfo[] = [root];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    out.push({ id: cur.id, path: cur.path });
    const kids = childrenByParent.get(cur.path);
    if (kids) queue.push(...kids);
  }
  return out;
}

/** 拿 session 详情：header + 全部 entries + 当前上下文 */
export async function getSessionDetail(id: string): Promise<{
  info: SessionInfo;
  header: SessionHeader | null;
  entries: SessionEntry[];
  leafId: string | null;
} | null> {
  const all = await SessionManager.listAll();
  const info = all.find((s) => s.id === id);
  if (!info) return null;
  const sm = SessionManager.open(info.path);
  return {
    info,
    header: sm.getHeader(),
    entries: sm.getEntries(),
    leafId: sm.getLeafId(),
  };
}

/** 拿当前 leaf 路径上的对话上下文（喂给 LLM 的那一份） */
export async function getSessionContext(
  id: string
): Promise<SessionContext | null> {
  const path = await findSessionPathById(id);
  if (!path) return null;
  const sm = SessionManager.open(path);
  return sm.buildSessionContext();
}

/** 拿当前 leaf 路径尾部的轻量上下文，给移动端快速切换历史会话使用。 */
export async function getSessionContextTail(
  id: string,
  limit: number
): Promise<(SessionContext & { truncatedBefore?: number }) | null> {
  const path = await findSessionPathById(id);
  if (!path) return null;
  return getSessionContextTailByPath(path, id, limit);
}

export async function getSessionContextTailByPath(
  sessionPath: string,
  expectedId: string,
  limit: number
): Promise<
  (SessionContext & {
    truncatedBefore?: number;
    beforeCursor?: number | null;
    hasMoreBefore?: boolean;
  }) | null
> {
  // S4: 先用可信清单校验 path 归属，避免打开任意文件。
  const trusted = await resolveTrustedSessionPath(sessionPath, expectedId);
  if (!trusted) return null;
  const sm = SessionManager.open(trusted);
  if (sm.getSessionId() !== expectedId) return null;
  const branch = sm.getBranch();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  return buildSessionContextSlice(branch, sm.getLeafId(), {
    start: Math.max(0, branch.length - safeLimit),
    end: branch.length,
  });
}

/** 拿当前 leaf 路径上 beforeCursor 之前的一页上下文，给移动端“加载更早内容”。 */
export async function getSessionContextPageByPath(
  sessionPath: string,
  expectedId: string,
  beforeCursor: number,
  limit: number
): Promise<
  (SessionContext & {
    beforeCursor?: number | null;
    hasMoreBefore?: boolean;
    truncatedBefore?: number;
  }) | null
> {
  // S4: 先用可信清单校验 path 归属，避免打开任意文件。
  const trusted = await resolveTrustedSessionPath(sessionPath, expectedId);
  if (!trusted) return null;
  const sm = SessionManager.open(trusted);
  if (sm.getSessionId() !== expectedId) return null;
  const branch = sm.getBranch();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const safeEnd = Math.max(
    0,
    Math.min(branch.length, Math.floor(beforeCursor))
  );
  return buildSessionContextSlice(branch, sm.getLeafId(), {
    start: Math.max(0, safeEnd - safeLimit),
    end: safeEnd,
  });
}

function buildSessionContextSlice(
  branch: SessionEntry[],
  leafId: string | null,
  range: { start: number; end: number }
): SessionContext & {
  truncatedBefore?: number;
  beforeCursor?: number | null;
  hasMoreBefore?: boolean;
} {
  const start = Math.max(0, Math.min(branch.length, range.start));
  const end = Math.max(start, Math.min(branch.length, range.end));
  const entries = branch.slice(start, end);
  const ctx = buildSessionContext(entries, leafId);

  // 尾部截断可能丢掉前序 model / thinking_level_change，轻量扫描当前分支补回来。
  let thinkingLevel = "off";
  let model: SessionContext["model"] = null;
  for (const entry of branch) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.provider &&
      entry.message.model
    ) {
      model = {
        provider: entry.message.provider,
        modelId: entry.message.model,
      };
    }
  }

  return {
    ...ctx,
    thinkingLevel,
    model,
    truncatedBefore: start,
    beforeCursor: start > 0 ? start : null,
    hasMoreBefore: start > 0,
  };
}

/**
 * 从 leaf 回 root，挑出当前分支路径上所有 user message 的 entryId + text。
 * 顺序与 chat 渲染顺序一致（root → leaf）。
 * 不需要 AgentSession 实例，可在选中 session 后立即调用。
 */
export async function getForkableUserMessages(
  id: string
): Promise<Array<{ entryId: string; text: string }> | null> {
  const path = await findSessionPathById(id);
  if (!path) return null;
  const sm = SessionManager.open(path);
  // getBranch() 默认从 leaf 走到 root，返回顺序是 root → leaf
  const branch = sm.getBranch();
  const out: Array<{ entryId: string; text: string }> = [];
  for (const e of branch) {
    if (e.type !== "message") continue;
    const msg = (e as { message?: { role?: string; content?: unknown } })
      .message;
    if (!msg || msg.role !== "user") continue;
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (
          c &&
          typeof c === "object" &&
          (c as { type?: string }).type === "text"
        ) {
          text += (c as { text?: string }).text ?? "";
        }
      }
    }
    // 剩下净空（仅含 control aside、无可见原文）的 entry 不进 fork list。
    // 包括 goal continuation 之类“系统推进”同步到 jsonl 的 user message。
    const visible = stripContextAside(text);
    if (!visible) continue;
    out.push({ entryId: e.id, text: visible });
  }
  return out;
}

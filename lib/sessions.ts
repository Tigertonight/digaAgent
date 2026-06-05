/**
 * SessionManager 封装。
 * - listAll: 列出所有 session（跨所有 cwd）
 * - openById: 通过 session id 找到对应 .jsonl 文件并 open
 *
 * 注意：pi-coding-agent 是 Node-only ESM 包，必须在 runtime=nodejs 的路由里用。
 */
import "server-only";
import {
  SessionManager,
  type SessionInfo,
  type SessionEntry,
  type SessionHeader,
  type SessionContext,
} from "@earendil-works/pi-coding-agent";
import { stripContextAside } from "./context-aside";
import { batchReadMeta } from "./meta/store";
import type { SessionMeta } from "./meta/types";

export type { SessionInfo, SessionEntry, SessionHeader, SessionContext };

/** SessionInfo + 运行时状态（运行中 / 空闲）+ 自维护元数据。 */
export type SessionInfoWithStatus = SessionInfo & {
  isRunning: boolean;
  /** RFC-3 Phase A：~/.mini-pi/sessions/{id}.meta.json 内容，未建时缺省 undefined */
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
  const { getRunningSessionFiles } = await import("./agent-registry");
  const running = getRunningSessionFiles();
  const list = await SessionManager.listAll();
  const metas = await batchReadMeta(list.map((s) => s.id));
  const enriched: SessionInfoWithStatus[] = list.map((s) => ({
    ...s,
    isRunning: running.has(s.path),
    meta: metas.get(s.id),
  }));
  return enriched.sort((a, b) => {
    // pinned 始终最优先（无论是否 running）
    const ap = a.meta?.pinned ? 1 : 0;
    const bp = b.meta?.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
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
    out.push({ entryId: e.id, text: stripContextAside(text) });
  }
  return out;
}

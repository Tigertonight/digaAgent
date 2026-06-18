"use client";

/**
 * useSessions —— session 列表 + 已读追踪 + CRUD（RFC-1 阶段 B1）
 *
 * 职责：
 *   - 持有 sessions（左侧列表）/ selectedId（当前选中）/ lastSeenMap（已读追踪）
 *   - session meta 持久化 lastSeenAt；localStorage 只作为旧版本兼容缓存
 *   - groupedSessions —— 按 parentSessionPath 分组（parents + childrenByParent）
 *   - refreshSessions —— GET /api/sessions
 *   - 轮询 + visibilitychange 刷新（15s 间隔，不可见时跳过）
 *   - 已读触发：用户切换 session / 主窗口聚焦 / sessions 更新且窗口聚焦
 *   - submitRename / executeDeleteSession —— PATCH / DELETE，含 runner+SSE 清理
 *
 * 设计要点：
 *   - lazy init：useState 初始值直接读 localStorage（避免 mount 后 effect 加载
 *     被 markSessionSeen 提前覆盖导致其他 session 已读丢失）
 *   - sessionsRef / lastSeenMapRef 镜像最新值，供外部 callback（如 doPush）
 *     在不进依赖的前提下读到最新
 *   - delete session 是跨 hook 操作：清 SSE（useSseManager.closeSseFor）+
 *     清 runner（runnersRef.delete）+ 若删的是 active 则切回 draft（switchTo）
 *
 * 不在本 hook 内的职责：
 *   - SSE 连接生命周期 → useSseManager
 *   - runner 状态 → useRunners
 *   - agent 事件 → useAgentEvents
 *   - send / abort / steer 等 chat 流 → useChatStream（B2）
 *   - fork / 宠物 push 等业务交互 → 仍在 ChatApp 内
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { SessionInfoLite } from "@/lib/types";
import {
  DRAFT_KEY,
  type RunnerKey,
  type RunnerState,
} from "@/lib/session-runner";
import { deleteInput } from "@/lib/composer/input-store";
import { userFacingMessage } from "@/lib/user-facing-error";
import { deriveSessionUnreadAt } from "@/lib/sessions/unread";

const STORAGE_KEY = "sessionLastSeen";
const POLL_INTERVAL_MS = 15_000;

function readLastSeenFromStorage(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // ignore (corrupt JSON / private mode)
  }
  return {};
}

function writeLastSeenToStorage(map: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore (private mode / quota)
  }
}

function seenIsoFromMeta(session: SessionInfoLite): string | null {
  const value = session.meta?.lastSeenAt;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value).toISOString();
}

function mergeServerLastSeen(
  prev: Record<string, string>,
  sessions: SessionInfoLite[]
): Record<string, string> {
  let changed = false;
  const next = { ...prev };
  for (const session of sessions) {
    const seen = seenIsoFromMeta(session);
    if (!seen) continue;
    if (!next[session.id] || next[session.id] < seen) {
      next[session.id] = seen;
      changed = true;
    }
  }
  return changed ? next : prev;
}

function persistServerLastSeen(sessionId: string, modifiedIso: string): void {
  const lastSeenAt = Date.parse(modifiedIso);
  if (!Number.isFinite(lastSeenAt)) return;
  void fetch(`/api/sessions/${sessionId}/meta`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastSeenAt }),
  }).catch(() => {});
}

function withSessionLastSeen(
  sessions: SessionInfoLite[],
  sessionId: string,
  lastSeenAt: number
): SessionInfoLite[] {
  let changed = false;
  const next = sessions.map((session) => {
    if (session.id !== sessionId) return session;
    if (session.meta?.lastSeenAt === lastSeenAt) return session;
    changed = true;
    return {
      ...session,
      meta: {
        ...session.meta,
        id: session.id,
        lastSeenAt,
      },
    };
  });
  return changed ? next : sessions;
}

function applyLastSeenMapToSessions(
  sessions: SessionInfoLite[],
  lastSeenMap: Record<string, string>
): SessionInfoLite[] {
  let changed = false;
  const next = sessions.map((session) => {
    const seenIso = lastSeenMap[session.id];
    if (!seenIso) return session;
    const seenMs = Date.parse(seenIso);
    if (!Number.isFinite(seenMs)) return session;
    const serverSeen = session.meta?.lastSeenAt;
    if (typeof serverSeen === "number" && serverSeen >= seenMs) return session;
    changed = true;
    return {
      ...session,
      meta: {
        ...session.meta,
        id: session.id,
        lastSeenAt: seenMs,
      },
    };
  });
  return changed ? next : sessions;
}

function sameSessionList(a: SessionInfoLite[], b: SessionInfoLite[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.path !== right.path ||
      left.cwd !== right.cwd ||
      left.name !== right.name ||
      left.parentSessionPath !== right.parentSessionPath ||
      left.created !== right.created ||
      left.modified !== right.modified ||
      left.messageCount !== right.messageCount ||
      left.firstMessage !== right.firstMessage ||
      left.isRunning !== right.isRunning ||
      left.runtimeState !== right.runtimeState ||
      left.waitingApprovalCount !== right.waitingApprovalCount ||
      left.waitingClarificationCount !== right.waitingClarificationCount ||
      left.lastEventSeq !== right.lastEventSeq ||
      left.runtimeUpdatedAt !== right.runtimeUpdatedAt ||
      left.lastAgentEndAt !== right.lastAgentEndAt ||
      left.meta?.title !== right.meta?.title ||
      left.meta?.pinned !== right.meta?.pinned ||
      left.meta?.lastSeenAt !== right.meta?.lastSeenAt
    ) {
      return false;
    }
  }
  return true;
}

export interface UseSessionsOptions {
  initialSessions: SessionInfoLite[];
  /** LRU / 删 session 时关 SSE */
  closeSseFor: (key: RunnerKey) => void;
  /** runners 容器（删 session 时清理） */
  runnersRef: MutableRefObject<Map<RunnerKey, RunnerState>>;
  /** 当前 active runner key（删 session 时判断是否要切 draft） */
  activeKeyRef: MutableRefObject<RunnerKey>;
  /** 删 active session 后切回 draft */
  switchTo: (key: RunnerKey) => void;
  /** 错误回调（fetch 失败 / rename 失败 / delete 失败） */
  onError: (msg: string) => void;
}

export interface UseSessionsReturn {
  // state
  sessions: SessionInfoLite[];
  setSessions: Dispatch<SetStateAction<SessionInfoLite[]>>;
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  lastSeenMap: Record<string, string>;

  // 派生
  groupedSessions: {
    parents: SessionInfoLite[];
    childrenByParent: Map<string, SessionInfoLite[]>;
  };

  // actions
  refreshSessions: () => void;
  markSessionSeen: (sessionId: string, snapshot: SessionInfoLite[]) => void;
  submitRename: (id: string, name: string) => Promise<void>;
  executeDeleteSession: (id: string) => Promise<void>;

  // refs（供外部 effect 闭包不进依赖的前提下读最新值）
  sessionsRef: MutableRefObject<SessionInfoLite[]>;
  lastSeenMapRef: MutableRefObject<Record<string, string>>;
}

export function useSessions(opts: UseSessionsOptions): UseSessionsReturn {
  const { initialSessions, closeSseFor, runnersRef, activeKeyRef, switchTo, onError } =
    opts;

  const [sessions, setSessions] = useState<SessionInfoLite[]>(initialSessions);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSessions[0]?.id ?? null
  );

  /**
   * 已查看的 session id → 上次查看时该 session 的 modified ISO。
   * 若 sessions[i].modified > lastSeenMap[sessions[i].id]，视为有新内容（未读）。
   * server meta 是跨版本持久化来源；localStorage 只用于兼容旧版本尚未迁移的
   * 已读状态。
   */
  const [lastSeenMap, setLastSeenMap] = useState<Record<string, string>>(() =>
    mergeServerLastSeen(readLastSeenFromStorage(), initialSessions)
  );

  // refs：让外部回调（如宠物 doPush）在不进依赖的前提下读最新
  const sessionsRef = useRef<SessionInfoLite[]>(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const selectedIdRef = useRef<string | null>(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const lastSeenMapRef = useRef<Record<string, string>>(lastSeenMap);
  useEffect(() => {
    lastSeenMapRef.current = lastSeenMap;
  }, [lastSeenMap]);

  /** 把指定 session 在当前 unreadAt 上标记为已读（幂等） */
  const markSessionSeen = useCallback(
    (sessionId: string, sessionsSnapshot: SessionInfoLite[]) => {
      const cur = sessionsSnapshot.find((s) => s.id === sessionId);
      if (!cur) return;
      const seenIso = deriveSessionUnreadAt(cur);
      const lastSeenAt = Date.parse(seenIso);
      setLastSeenMap((prev) => {
        if (prev[sessionId] === seenIso) return prev;
        const next = { ...prev, [sessionId]: seenIso };
        writeLastSeenToStorage(next);
        persistServerLastSeen(sessionId, seenIso);
        return next;
      });
      if (Number.isFinite(lastSeenAt)) {
        setSessions((prev) => withSessionLastSeen(prev, sessionId, lastSeenAt));
      }
    },
    []
  );

  // 用户切换 session 时（selectedId 单独变化），标当前 modified 已读。
  // 关键：依赖里只有 selectedId，sessions 变化不触发。
  // 用 ref 取最新 sessions 而不进依赖，避免 refreshSessions 后被错误触发。
  useEffect(() => {
    if (!selectedId) return;
    markSessionSeen(selectedId, sessionsRef.current);
  }, [selectedId, markSessionSeen]);

  // 主窗口真正被用户看到时（focus + visible），把 active session 标已读。
  // 包含：窗口 focus 事件、visibilitychange 转为 visible、selectedId 变更后若已聚焦也补一次。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tryMark = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible")
        return;
      if (typeof document !== "undefined" && !document.hasFocus()) return;
      const sid = selectedId;
      if (!sid) return;
      markSessionSeen(sid, sessionsRef.current);
    };
    // 初次挂载/依赖变化时尝试一次（覆盖"主窗口本来就在前台"的场景）
    tryMark();
    window.addEventListener("focus", tryMark);
    document.addEventListener("visibilitychange", tryMark);
    return () => {
      window.removeEventListener("focus", tryMark);
      document.removeEventListener("visibilitychange", tryMark);
    };
  }, [selectedId, markSessionSeen]);

  // sessions 列表更新后（如流式结束 modified 变化），若主窗口此刻
  // 仍被用户聚焦看着 active session，应立刻消除 unread（让宠物不闪 attention）。
  // 注意这里依赖 sessions——但只在"窗口被聚焦"的前提下才写，所以宠物失焦场景
  // 完全不会被这里覆盖。
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (document.visibilityState !== "visible") return;
    if (!document.hasFocus()) return;
    if (!selectedId) return;
    queueMicrotask(() => markSessionSeen(selectedId, sessions));
  }, [sessions, selectedId, markSessionSeen]);

  /**
   * 把扁平 sessions 按 parentSessionPath 分组：
   *   - parents: 没有 parentSessionPath（或 parent 不在列表里）的 session，保持原顺序
   *   - childrenByParent: parent.path -> child[]（按原顺序）
   * 渲染时 parent 之后立即渲染它的 children（缩进），其余 children 也作为 parent 显示在末尾兜底。
   */
  const groupedSessions = useMemo(() => {
    const byPath = new Map<string, SessionInfoLite>();
    for (const s of sessions) byPath.set(s.path, s);
    const childrenByParent = new Map<string, SessionInfoLite[]>();
    const parents: SessionInfoLite[] = [];
    for (const s of sessions) {
      if (s.parentSessionPath && byPath.has(s.parentSessionPath)) {
        const arr = childrenByParent.get(s.parentSessionPath) ?? [];
        arr.push(s);
        childrenByParent.set(s.parentSessionPath, arr);
      } else {
        parents.push(s);
      }
    }
    return { parents, childrenByParent };
  }, [sessions]);

  // 刷新左侧 session 列表
  const refreshSessions = useCallback(() => {
    void fetch("/api/sessions")
      .then((r) => r.json())
      .then((d: { sessions?: SessionInfoLite[] }) => {
        const next = applyLastSeenMapToSessions(
          d.sessions ?? [],
          lastSeenMapRef.current
        );
        setSessions((prev) => (sameSessionList(prev, next) ? prev : next));
        const nextIds = new Set(next.map((session) => session.id));
        const nextPaths = new Set(next.map((session) => session.path));
        const currentSelectedId = selectedIdRef.current;
        const currentActiveKey = activeKeyRef.current;
        if (currentSelectedId && !nextIds.has(currentSelectedId)) {
          setSelectedId(null);
        }
        if (currentActiveKey !== DRAFT_KEY && !nextPaths.has(currentActiveKey)) {
          closeSseFor(currentActiveKey);
          runnersRef.current.delete(currentActiveKey);
          switchTo(DRAFT_KEY);
        }
        setLastSeenMap((prev) => {
          const merged = mergeServerLastSeen(prev, next);
          if (merged !== prev) writeLastSeenToStorage(merged);
          return merged;
        });
      })
      .catch(() => {});
  }, [activeKeyRef, closeSseFor, runnersRef, switchTo]);

  // 首屏立即校验最新 session 列表。SSR / E2E / 移动远程入口可能先给
  // 一个轻量初始列表，主动刷新能减少切 session 前的空白等待。
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  /**
   * 轻量轮询 session 列表 —— 用来追踪"别的 agent"在后台的进展。
   * 自己的 agent_end 事件已经会主动 refreshSessions（见 reducer 监听），
   * 所以这里只负责兜底跨 session 同步，15s 间隔足够；tab 不可见时跳过。
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      refreshSessions();
    };
    const id = setInterval(tick, POLL_INTERVAL_MS);
    // 标签页从隐藏切回可见时立即拉一次（避免要等到下一个 15s 周期）
    const onVis = () => {
      if (document.visibilityState === "visible") refreshSessions();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshSessions]);

  // ===== CRUD =====

  const submitRename = useCallback(
    async (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        const r = await fetch(`/api/sessions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) onError(userFacingMessage(data.error));
        else refreshSessions();
      } catch (e) {
        onError(userFacingMessage(e));
      }
    },
    [refreshSessions, onError]
  );

  const executeDeleteSession = useCallback(
    async (id: string) => {
      try {
        const r = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
        const data = (await r.json()) as {
          error?: string;
          deleted?: string[];
        };
        if (data.error) {
          onError(userFacingMessage(data.error));
          return;
        }
        // 后端会级联删父+所有 fork 子 session，返回 deleted 列表；老接口没返就退化到只清自己
        const deletedIds = new Set<string>(
          data.deleted && data.deleted.length > 0 ? data.deleted : [id]
        );
        // 把对应 runner 从 Map 里删掉（如果有），关其 SSE
        let activeWasDeleted = false;
        for (const did of deletedIds) {
          const sel = sessionsRef.current.find((s) => s.id === did);
          if (!sel) continue;
          const key: RunnerKey = sel.path;
          closeSseFor(key);
          // M1：删 runner 的同时清掉它在 input-store 里残留的草稿文本，
          // 否则该 key 的输入框内容会变成无主死键，长期泄漏。
          deleteInput(key);
          if (activeKeyRef.current === key) activeWasDeleted = true;
          runnersRef.current.delete(key);
        }
        if (activeWasDeleted) {
          // active 被级联删了 → 切回 draft（switchTo 在 draft 不存在时兜底建空 runner）
          setSelectedId(null);
          switchTo(DRAFT_KEY);
        } else if (
          selectedIdRef.current &&
          deletedIds.has(selectedIdRef.current)
        ) {
          // 兜底：列表没找到但 selectedId 在删除集合里，也要回到 draft。
          // 否则 activeKey 可能停在已删除会话上，下一次发送只会被 guard 阻断。
          setSelectedId(null);
          if (activeKeyRef.current !== DRAFT_KEY) {
            closeSseFor(activeKeyRef.current);
            runnersRef.current.delete(activeKeyRef.current);
            switchTo(DRAFT_KEY);
          }
        }
        refreshSessions();
      } catch (e) {
        onError(userFacingMessage(e));
      }
    },
    [
      refreshSessions,
      switchTo,
      runnersRef,
      activeKeyRef,
      closeSseFor,
      onError,
    ]
  );

  return {
    sessions,
    setSessions,
    selectedId,
    setSelectedId,
    lastSeenMap,
    groupedSessions,
    refreshSessions,
    markSessionSeen,
    submitRename,
    executeDeleteSession,
    sessionsRef,
    lastSeenMapRef,
  };
}

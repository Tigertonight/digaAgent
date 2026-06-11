"use client";

/**
 * useSessions —— session 列表 + 已读追踪 + CRUD（RFC-1 阶段 B1）
 *
 * 职责：
 *   - 持有 sessions（左侧列表）/ selectedId（当前选中）/ lastSeenMap（已读追踪）
 *   - localStorage 持久化 lastSeenMap（lazy init，**修复刷新页面已读丢失 bug**）
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
import { userFacingMessage } from "@/lib/user-facing-error";

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
   *
   * **lazy init 修复**（RFC-1 B1）：旧实现先 useState({}) 再 useEffect 加载 LS，
   * mount 后第一次 render lastSeenMap={}，导致 selectedId 初始 effect 触发的
   * markSessionSeen 用 prev={} 覆盖 LS，**其他所有 session 的 lastSeen 全丢**。
   * lazy init 让初始值直接来自 LS，从源头消除这个 race。
   */
  const [lastSeenMap, setLastSeenMap] = useState<Record<string, string>>(
    readLastSeenFromStorage
  );

  // refs：让外部回调（如宠物 doPush）在不进依赖的前提下读最新
  const sessionsRef = useRef<SessionInfoLite[]>(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const lastSeenMapRef = useRef<Record<string, string>>(lastSeenMap);
  useEffect(() => {
    lastSeenMapRef.current = lastSeenMap;
  }, [lastSeenMap]);

  /** 把指定 session 在当前 modified 上标记为已读（幂等） */
  const markSessionSeen = useCallback(
    (sessionId: string, sessionsSnapshot: SessionInfoLite[]) => {
      const cur = sessionsSnapshot.find((s) => s.id === sessionId);
      if (!cur) return;
      setLastSeenMap((prev) => {
        if (prev[sessionId] === cur.modified) return prev;
        const next = { ...prev, [sessionId]: cur.modified };
        writeLastSeenToStorage(next);
        persistServerLastSeen(sessionId, cur.modified);
        return next;
      });
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
        const next = d.sessions ?? [];
        setSessions((prev) => (sameSessionList(prev, next) ? prev : next));
        setLastSeenMap((prev) => {
          const merged = mergeServerLastSeen(prev, next);
          if (merged !== prev) writeLastSeenToStorage(merged);
          return merged;
        });
      })
      .catch(() => {});
  }, []);

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
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          onError(userFacingMessage(data.error));
          return;
        }
        // 把对应 runner 从 Map 里删掉（如果有），关其 SSE
        const sel = sessionsRef.current.find((s) => s.id === id);
        if (sel) {
          const key: RunnerKey = sel.path;
          closeSseFor(key);
          const wasActive = activeKeyRef.current === key;
          runnersRef.current.delete(key);
          // 删的是当前活跃的 → 切回 draft（switchTo 在 draft 不存在时兜底建空 runner）
          if (wasActive) {
            setSelectedId(null);
            switchTo(DRAFT_KEY);
          }
        } else if (selectedId === id) {
          // 兜底：列表没找到但 selectedId 匹配，清掉显示
          setSelectedId(null);
        }
        refreshSessions();
      } catch (e) {
        onError(userFacingMessage(e));
      }
    },
    [
      refreshSessions,
      selectedId,
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

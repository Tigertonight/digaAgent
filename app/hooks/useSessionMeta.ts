"use client";

/**
 * useSessionMeta —— session meta 的写操作 hook（RFC-3 Phase A3）。
 *
 * 设计取舍（为什么不做 GET / state）：
 *   - Sidebar 列表已经从 `GET /api/sessions` 拿到 `sess.meta`（A2 已聚合）
 *   - 单 session 视图也会从父级 props 拿到 meta，不必每个 item 单 fetch
 *   - 因此本 hook 只暴露 PATCH 的封装，避免：
 *       * useEffect 自拉 → 触发 react-hooks/set-state-in-effect 警告
 *       * 双源真实（本地 state vs server）造成不一致
 *       * N 个 item 同时 mount 时的 fan-out 请求
 *
 * 用法：
 *   const { patch } = useSessionMeta({ onError: setError });
 *   await patch(sessionId, { pinned: true });
 *   // 然后调用方负责 refresh 列表（refreshSessions）以拿到 server 最新 meta
 *
 * 与 useApprovals 范式一致：纯 action，不做乐观更新，server 是 source of truth。
 */

import { useCallback } from "react";
import type { SessionMeta } from "@/lib/meta/types";

export interface UseSessionMetaOptions {
  /** PATCH 失败时报错（通常接 setError） */
  onError?: (msg: string) => void;
}

export interface UseSessionMetaReturn {
  /**
   * Partial merge 写 meta；返回 server 写回后的完整 meta，失败返回 null。
   * 不更新任何 hook 内 state——调用方需自行 refresh 列表。
   */
  patch: (
    sessionId: string,
    p: Partial<SessionMeta>
  ) => Promise<SessionMeta | null>;
}

interface PatchEnvelope {
  meta?: SessionMeta | null;
  error?: string;
}

export function useSessionMeta(
  opts: UseSessionMetaOptions = {}
): UseSessionMetaReturn {
  const { onError } = opts;

  const patch = useCallback<UseSessionMetaReturn["patch"]>(
    async (sessionId, p) => {
      if (!sessionId) return null;
      try {
        const r = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/meta`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(p),
            cache: "no-store",
          }
        );
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          onError?.(`meta PATCH failed: ${r.status} ${text}`);
          return null;
        }
        const env = (await r.json()) as PatchEnvelope;
        return env.meta ?? null;
      } catch (e) {
        onError?.(`meta PATCH network error: ${String(e)}`);
        return null;
      }
    },
    [onError]
  );

  return { patch };
}

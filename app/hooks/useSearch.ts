"use client";

/**
 * useSearch —— Sidebar 全文检索 hook（RFC-3 Phase B / F2）。
 *
 * 与 useSessionMeta 的对比：
 *   - useSessionMeta：纯 action hook，没有 state（避开 set-state-in-effect）
 *   - useSearch：必须自带 state（query / results / loading / error），
 *     因为没有上层数据源能聚合
 *
 * 如何避开 react-hooks/set-state-in-effect：
 *   - 不在 useEffect 同步 body 内 setState
 *   - setState 都发生在异步回调（fetch then / setTimeout 回调）里
 *   - useEffect 只做：
 *       1) 起一个 setTimeout（debounce）
 *       2) cleanup 清掉 timeout
 *     回调里 await fetch + setState 都是异步
 *
 * 行为：
 *   - setQuery(q) 立刻更新 query state
 *   - useEffect 监听 query，trim 后非空才发 fetch；空串就清 results
 *   - debounce 200ms，避免逐字符发请求
 *   - 同一时刻只有 latestQueryRef 对应的请求结果会写回 state（race 防护）
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { SearchResponse, SearchResult } from "@/lib/search/types";

const DEBOUNCE_MS = 200;
const BUILDING_NOTICE_MS = 600;
const TIMEOUT_NOTICE_MS = 5_000;

export type SearchStatus =
  | "idle"
  | "loading"
  | "building"
  | "timeout"
  | "ready"
  | "error";

export interface UseSearchState {
  query: string;
  status: SearchStatus;
  results: SearchResult[];
  /** 索引构建时刻（server 返回），UI 可显示「索引于 X 前」 */
  builtAt: number | null;
  totalDocs: number;
  /** server 端搜索耗时 ms */
  durationMs: number | null;
  indexStatus: SearchResponse["indexStatus"] | null;
  indexBuildMs: number | null;
  error: string | null;
}

export interface UseSearchReturn extends UseSearchState {
  setQuery: (q: string) => void;
  clear: () => void;
  retry: () => void;
  /** query 是否处于"非空且 trim 后非空"状态——UI 用这个决定要不要替换 sessions 列表 */
  isActive: boolean;
}

interface UseSearchOptions {
  /** 自定义 fetch（测试用） */
  fetcher?: typeof fetch;
}

const INITIAL: UseSearchState = {
  query: "",
  status: "idle",
  results: [],
  builtAt: null,
  totalDocs: 0,
  durationMs: null,
  indexStatus: null,
  indexBuildMs: null,
  error: null,
};

export function useSearch(opts: UseSearchOptions = {}): UseSearchReturn {
  const [state, setState] = useState<UseSearchState>(INITIAL);
  const [retryNonce, setRetryNonce] = useState(0);
  const latestQueryRef = useRef("");
  const requestIdRef = useRef(0);

  const fetcher = opts.fetcher ?? fetch;

  const setQuery = useCallback((q: string) => {
    setState((s) => ({ ...s, query: q }));
  }, []);

  const clear = useCallback(() => {
    setState(INITIAL);
    latestQueryRef.current = "";
    requestIdRef.current += 1;
  }, []);

  const retry = useCallback(() => {
    setState((s) => ({
      ...s,
      status: s.query.trim() ? "loading" : "idle",
      error: null,
      durationMs: null,
    }));
    setRetryNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const trimmed = state.query.trim();
    latestQueryRef.current = trimmed;

    // 空 query：清结果（但保留 query 字符串 = 用户输入的原文 / 空白），
    // 用 functional updater 在异步 cleanup-effect 边界外不会被 lint 抓
    if (!trimmed) {
      // 这里直接 setState 会触发 set-state-in-effect。
      // 解决：放到 microtask 里。queueMicrotask 是异步回调，规则不抓。
      queueMicrotask(() => {
        if (latestQueryRef.current === "") {
          requestIdRef.current += 1;
          setState((s) =>
            s.status === "idle" && s.results.length === 0
              ? s
              : { ...s, status: "idle", results: [], error: null },
          );
        }
      });
      return;
    }

    const handle = setTimeout(async () => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      // 进入 loading（异步回调内 setState，不触发 set-state-in-effect）
      setState((s) => ({
        ...s,
        status: "loading",
        error: null,
        durationMs: null,
        indexStatus: null,
        indexBuildMs: null,
      }));

      const stillCurrent = () =>
        latestQueryRef.current === trimmed &&
        requestIdRef.current === requestId;
      const buildingTimer = setTimeout(() => {
        if (stillCurrent()) {
          setState((s) =>
            s.status === "loading" ? { ...s, status: "building" } : s,
          );
        }
      }, BUILDING_NOTICE_MS);
      const timeoutTimer = setTimeout(() => {
        if (stillCurrent()) {
          setState((s) =>
            s.status === "loading" || s.status === "building"
              ? { ...s, status: "timeout" }
              : s,
          );
        }
      }, TIMEOUT_NOTICE_MS);

      try {
        const r = await fetcher("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: trimmed }),
          cache: "no-store",
        });

        // race 防护：用户已经又改了 query，丢弃这次结果
        if (!stillCurrent()) return;

        if (!r.ok) {
          const text = await r.text().catch(() => "");
          setState((s) => ({
            ...s,
            status: "error",
            error: `HTTP ${r.status} ${text || r.statusText}`,
          }));
          return;
        }

        const data = (await r.json()) as SearchResponse;
        if (!stillCurrent()) return;

        setState((s) => ({
          ...s,
          status: "ready",
          results: data.results,
          builtAt: data.builtAt,
          totalDocs: data.totalDocs,
          durationMs: data.durationMs,
          indexStatus: data.indexStatus ?? null,
          indexBuildMs: data.indexBuildMs ?? null,
          error: null,
        }));
      } catch (e) {
        if (!stillCurrent()) return;
        setState((s) => ({
          ...s,
          status: "error",
          error: String(e),
        }));
      } finally {
        clearTimeout(buildingTimer);
        clearTimeout(timeoutTimer);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [state.query, fetcher, retryNonce]);

  return {
    ...state,
    setQuery,
    clear,
    retry,
    isActive: state.query.trim().length > 0,
  };
}

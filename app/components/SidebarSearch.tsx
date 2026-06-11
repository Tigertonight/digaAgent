"use client";

/**
 * SidebarSearch —— RFC-3 Phase B / F2 的搜索结果视图。
 *
 * 由 Sidebar 在 `searchView` 插槽位置渲染，**完全替代**普通 sessions 列表。
 * 进入条件：useSearch().isActive === true（输入框 trim 后非空）。
 *
 * 设计要点：
 *   - 受控：query / results / status 全部 props 传入
 *   - 命中点高亮：matchedTokens 在 snippet 中做大小写不敏感包裹
 *   - 点击结果跳转到对应 session（v0 只跳 session，不跳 entry）
 *   - 不引入任何业务逻辑（不调 API、不管 cache）
 */

import type { SearchResult } from "@/lib/search/types";
import type { SearchStatus } from "@/app/hooks/useSearch";

import { shortCwd } from "@/lib/format";

export interface SidebarSearchProps {
  query: string;
  status: SearchStatus;
  results: SearchResult[];
  totalDocs: number;
  durationMs: number | null;
  error: string | null;
  onRetry: () => void;
  /** 点击结果时跳到该 session */
  onSelect: (sessionId: string) => void;
  /** 当前选中的 session id，用于结果列表高亮 */
  selectedId: string | null;
  /** 从 sessions 列表里拿 cwd / title 显示（id → 简要信息） */
  sessionLookup: Map<
    string,
    { cwd: string; title: string | null }
  >;
}

/** 在 snippet 中高亮 matchedTokens（大小写不敏感） */
function highlight(snippet: string, tokens: string[]): React.ReactNode[] {
  if (tokens.length === 0) return [snippet];
  // 拼一个 regex：所有 token 的并集；按长度倒序避免短 token 抢占
  const sorted = [...tokens].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = snippet.split(re);
  return parts.map((p, i) => {
    if (i % 2 === 1) {
      return (
        <mark
          key={i}
          style={{
            background: "var(--color-warning-bg)",
            color: "inherit",
            padding: "0 1px",
            borderRadius: "var(--radius-xs)",
          }}
        >
          {p}
        </mark>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

export function SidebarSearch(props: SidebarSearchProps) {
  const {
    query,
    status,
    results,
    totalDocs,
    durationMs,
    error,
    onRetry,
    onSelect,
    selectedId,
    sessionLookup,
  } = props;

  return (
    <div className="flex-1 overflow-y-auto">
      {/* 顶部状态行 */}
      <div
        className="flex items-center justify-between border-b px-3 py-1.5 text-token-xs"
        style={{
          borderColor: "var(--border-soft)",
          color: "var(--text-muted)",
        }}
      >
        <span>
          {status === "loading" && "搜索中…"}
          {status === "building" && "Building index…"}
          {status === "timeout" && (
            <span>
              Building index is taking longer than usual.
            </span>
          )}
          {status === "ready" &&
            `${results.length} 命中 · ${totalDocs} session 索引`}
          {status === "error" && (
            <span style={{ color: "var(--color-danger)" }}>错误：{error}</span>
          )}
          {status === "idle" && "输入开始搜索"}
        </span>
        {durationMs != null && status === "ready" && (
          <span style={{ color: "var(--fg-faint)" }}>{durationMs}ms</span>
        )}
        {status === "timeout" && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded border px-1.5 py-0.5 hover:opacity-80"
            style={{
              borderColor: "var(--border)",
              color: "var(--text)",
            }}
          >
            Retry
          </button>
        )}
      </div>

      {/* 命中列表 */}
      {status === "ready" && results.length === 0 && (
        <div
          className="p-4 text-token-xs"
          style={{ color: "var(--fg-faint)" }}
        >
          没有命中「{query}」的会话。
        </div>
      )}

      {results.map((r) => {
        const info = sessionLookup.get(r.sessionId);
        const active = selectedId === r.sessionId;
        return (
          <button
            key={r.sessionId}
            type="button"
            onClick={() => onSelect(r.sessionId)}
            className="w-full text-left border-b py-2 px-3 hover:opacity-90"
            style={{
              borderColor: "var(--border-soft)",
              background: active ? "var(--bg-panel-2)" : "transparent",
            }}
          >
            <div
              className="flex items-center gap-2 truncate text-token-body"
              style={{ color: "var(--text)" }}
            >
              <span className="truncate">
                {info?.title || r.sessionId.slice(0, 8)}
              </span>
              {info && (
                <span
                  className="shrink-0 text-token-xs"
                  style={{ color: "var(--fg-faint)" }}
                >
                  {shortCwd(info.cwd)}
                </span>
              )}
            </div>
            <div className="mt-1 space-y-0.5">
              {r.hits.slice(0, 3).map((h, i) => (
                <div
                  key={`${h.entryId}-${i}`}
                  className="truncate text-token-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  <span
                    className="mr-1 inline-block rounded-token-xs px-1 text-token-xs uppercase"
                    style={{
                      background: "var(--bg-hover)",
                      color: "var(--fg-faint)",
                    }}
                  >
                    {h.kind}
                  </span>
                  {highlight(h.snippet, h.matchedTokens)}
                </div>
              ))}
              {r.hits.length > 3 && (
                <div
                  className="text-token-xs"
                  style={{ color: "var(--fg-faint)" }}
                >
                  +{r.hits.length - 3} 处更多命中
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

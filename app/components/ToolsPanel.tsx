"use client";

import { Wrench } from "lucide-react";

/**
 * Tools 面板（右侧抽屉）。
 * - 从 /api/agent/[id]?action=get_tools 拉 { tools: ToolInfo[], active: string[] }
 * - 按 sourceInfo.source 分组（如 "builtin" / 各 extension package 名）
 * - 每个 tool 一个 checkbox；切换后整组 active set 通过 POST set_tools 提交（全量覆盖）
 * - 顶部：全选 / 全不选 / 仅 builtin / 刷新
 * - 搜索框过滤显示
 *
 * SDK 协议：
 *   GET  /api/agent/[id]?action=get_tools  -> { tools, active }
 *   POST /api/agent/[id] { type:"set_tools", tools: string[] } -> { ok, active }
 *
 * 注意：set_tools 是全量覆盖语义（未列出的工具会被禁用），与 SDK 的
 * setActiveToolsByName 一致。
 */
import { useCallback, useEffect, useMemo, useState } from "react";

interface SourceInfo {
  path?: string;
  source?: string;
  scope?: string;
  origin?: string;
  baseDir?: string;
}

interface ToolInfo {
  name: string;
  description?: string;
  sourceInfo?: SourceInfo;
  // parameters / promptGuidelines 这里不展示，避免噪声
}

interface ToolsResponse {
  tools: ToolInfo[];
  active: string[];
  error?: string;
}

interface Props {
  agentId: string;
  onClose: () => void;
}

export default function ToolsPanel({ agentId, onClose }: Props) {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/agent/${encodeURIComponent(agentId)}?action=get_tools`
      );
      const d = (await r.json()) as ToolsResponse;
      if (d.error) setError(d.error);
      setTools(Array.isArray(d.tools) ? d.tools : []);
      setActive(new Set(Array.isArray(d.active) ? d.active : []));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const commit = useCallback(
    async (next: Set<string>) => {
      setSaving(true);
      setError(null);
      try {
        const r = await fetch(`/api/agent/${encodeURIComponent(agentId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "set_tools",
            tools: Array.from(next),
          }),
        });
        const d = (await r.json()) as { ok?: boolean; active?: string[]; error?: string };
        if (d.error) {
          setError(d.error);
          // 回滚到服务端真实状态
          if (Array.isArray(d.active)) setActive(new Set(d.active));
          return;
        }
        if (Array.isArray(d.active)) setActive(new Set(d.active));
        else setActive(next);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [agentId]
  );

  const toggle = useCallback(
    (name: string) => {
      const next = new Set(active);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      setActive(next);
      void commit(next);
    },
    [active, commit]
  );

  const enableAll = useCallback(() => {
    const next = new Set(tools.map((t) => t.name));
    setActive(next);
    void commit(next);
  }, [tools, commit]);

  const disableAll = useCallback(() => {
    const next = new Set<string>();
    setActive(next);
    void commit(next);
  }, [commit]);

  const enableBuiltinOnly = useCallback(() => {
    const next = new Set(
      tools
        .filter((t) => (t.sourceInfo?.source ?? "builtin") === "builtin")
        .map((t) => t.name)
    );
    setActive(next);
    void commit(next);
  }, [tools, commit]);

  // 按 sourceInfo.source 分组
  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const groups = new Map<string, ToolInfo[]>();
    for (const t of tools) {
      if (
        q &&
        !(
          t.name.toLowerCase().includes(q) ||
          (t.description ?? "").toLowerCase().includes(q)
        )
      ) {
        continue;
      }
      const src = t.sourceInfo?.source ?? "builtin";
      if (!groups.has(src)) groups.set(src, []);
      groups.get(src)!.push(t);
    }
    // builtin 排第一，其余按字母
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === "builtin") return -1;
      if (b === "builtin") return 1;
      return a.localeCompare(b);
    });
  }, [tools, filter]);

  const total = tools.length;
  const activeCount = active.size;

  return (
    <aside
      className="flex flex-col h-full"
      style={{
        background: "var(--bg-panel)",
        borderLeft: "1px solid var(--border-soft)",
      }}
    >
      <header
        className="px-3 py-2 flex items-center justify-between border-b"
        style={{ borderColor: "var(--border-soft)" }}
      >
        <span className="text-sm font-semibold inline-flex items-center gap-1.5">
          <Wrench size={14} />
          Tools
        </span>
        <div className="flex items-center gap-1">
          <span
            className="text-token-xs"
            style={{ color: "var(--fg-faint)" }}
            title="启用 / 总数"
          >
            {activeCount}/{total}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            title="刷新"
            className="px-2 py-0.5 text-xs rounded border hover:opacity-80 disabled:opacity-50"
            style={{ borderColor: "var(--border)" }}
          >
            {loading ? "…" : "↻"}
          </button>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="px-2 py-0.5 text-xs rounded border hover:opacity-80"
            style={{ borderColor: "var(--border)" }}
          >
            ✕
          </button>
        </div>
      </header>

      {/* 顶部操作区 */}
      <div
        className="px-3 py-2 border-b space-y-2"
        style={{ borderColor: "var(--border-soft)" }}
      >
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤工具名 / 描述"
          className="w-full rounded px-2 py-1 text-xs border outline-none"
          style={{
            background: "var(--bg-panel-2)",
            borderColor: "var(--border)",
            color: "var(--fg)",
          }}
        />
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={enableAll}
            disabled={saving || tools.length === 0}
            className="px-2 py-0.5 text-token-xs rounded border hover:opacity-80 disabled:opacity-50"
            style={{ borderColor: "var(--border)" }}
            title="启用全部工具"
          >
            全选
          </button>
          <button
            type="button"
            onClick={disableAll}
            disabled={saving || activeCount === 0}
            className="px-2 py-0.5 text-token-xs rounded border hover:opacity-80 disabled:opacity-50"
            style={{ borderColor: "var(--border)" }}
            title="禁用全部工具"
          >
            全不选
          </button>
          <button
            type="button"
            onClick={enableBuiltinOnly}
            disabled={saving}
            className="px-2 py-0.5 text-token-xs rounded border hover:opacity-80 disabled:opacity-50"
            style={{ borderColor: "var(--border)" }}
            title="仅保留 builtin 工具"
          >
            仅 builtin
          </button>
          {saving && (
            <span
              className="text-token-xs self-center"
              style={{ color: "var(--fg-faint)" }}
            >
              保存中…
            </span>
          )}
        </div>
        <div className="text-token-xs" style={{ color: "var(--fg-faint)" }}>
          切换在<b>下一轮</b>对话生效。
        </div>
      </div>

      {error && (
        <div
          className="px-3 py-2 text-token-xs border-b"
          style={{
            color: "var(--color-danger)",
            borderColor: "var(--border-soft)",
            background: "var(--color-danger-bg)",
          }}
        >
          {error}
        </div>
      )}

      {/* 工具列表 */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {grouped.length === 0 && !loading && (
          <div
            className="text-xs text-center py-6"
            style={{ color: "var(--fg-faint)" }}
          >
            {filter ? "无匹配工具" : "暂无工具"}
          </div>
        )}
        {grouped.map(([src, list]) => (
          <section key={src} className="space-y-1">
            <div
              className="text-token-xs uppercase tracking-wider px-1"
              style={{ color: "var(--fg-faint)" }}
            >
              {src} · {list.length}
            </div>
            <div
              className="rounded overflow-hidden"
              style={{ border: "1px solid var(--border-soft)" }}
            >
              {list.map((t) => {
                const on = active.has(t.name);
                return (
                  <label
                    key={t.name}
                    className="flex items-start gap-2 px-2 py-1.5 cursor-pointer hover:opacity-90"
                    style={{
                      background: "var(--bg-panel-2)",
                      borderBottom: "1px solid var(--border-soft)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={saving}
                      onChange={() => toggle(t.name)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-mono truncate" title={t.name}>
                        {t.name}
                      </div>
                      {t.description && (
                        <div
                          className="text-token-xs leading-tight mt-0.5"
                          style={{ color: "var(--fg-muted)" }}
                        >
                          {t.description.length > 200
                            ? t.description.slice(0, 200) + "…"
                            : t.description}
                        </div>
                      )}
                      {t.sourceInfo?.scope &&
                        t.sourceInfo.scope !== "temporary" && (
                          <div
                            className="text-token-xs mt-0.5"
                            style={{ color: "var(--fg-faint)" }}
                          >
                            scope: {t.sourceInfo.scope}
                            {t.sourceInfo.origin
                              ? ` · ${t.sourceInfo.origin}`
                              : ""}
                          </div>
                        )}
                    </div>
                  </label>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}

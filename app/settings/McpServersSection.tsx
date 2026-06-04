"use client";

import { useCallback, useEffect, useState } from "react";
import type { McpServerConfig } from "@/lib/mcp/types";

interface DraftServer {
  id: string;
  title: string;
  command: string;
  args: string;
  enabled: boolean;
}

const EMPTY_DRAFT: DraftServer = {
  id: "",
  title: "",
  command: "",
  args: "",
  enabled: true,
};

export function McpServersSection() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [draft, setDraft] = useState<DraftServer>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setStatus(null);
    try {
      const r = await fetch("/api/mcp");
      const d = (await r.json()) as { servers?: McpServerConfig[]; error?: string };
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      setServers(Array.isArray(d.servers) ? d.servers : []);
    } catch (e) {
      setStatus(`加载失败: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      const r = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json()) as Record<string, unknown>;
      if (!r.ok || d.error) throw new Error(String(d.error ?? `HTTP ${r.status}`));
      return d;
    },
    []
  );

  const save = useCallback(async () => {
    if (!draft.id.trim() || !draft.command.trim()) {
      setStatus("需要 id 和 command");
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await post({
        type: "upsert",
        id: draft.id.trim(),
        title: draft.title.trim() || undefined,
        transport: "stdio",
        command: draft.command.trim(),
        args: draft.args
          .split(/\s+/)
          .map((a) => a.trim())
          .filter(Boolean),
        enabled: draft.enabled,
      });
      setDraft(EMPTY_DRAFT);
      await load();
      setStatus("已保存");
    } catch (e) {
      setStatus(`保存失败: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [draft, post, load]);

  const remove = useCallback(
    async (id: string) => {
      setSaving(true);
      try {
        await post({ type: "remove", id });
        await load();
      } catch (e) {
        setStatus(`删除失败: ${String(e)}`);
      } finally {
        setSaving(false);
      }
    },
    [post, load]
  );

  const toggle = useCallback(
    async (server: McpServerConfig) => {
      setSaving(true);
      try {
        await post({ ...server, type: "upsert", enabled: !server.enabled });
        await load();
      } catch (e) {
        setStatus(`更新失败: ${String(e)}`);
      } finally {
        setSaving(false);
      }
    },
    [post, load]
  );

  const test = useCallback(
    async (id: string) => {
      setTestResults((prev) => ({ ...prev, [id]: "测试中…" }));
      try {
        const d = (await post({ type: "test", id })) as {
          ok?: boolean;
          toolCount?: number;
        };
        setTestResults((prev) => ({
          ...prev,
          [id]: d.ok ? `连接成功，${d.toolCount ?? 0} 个工具` : "连接失败",
        }));
      } catch (e) {
        setTestResults((prev) => ({ ...prev, [id]: `失败: ${String(e)}` }));
      }
    },
    [post]
  );

  return (
    <section className="mb-6 border border-neutral-800 rounded p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold mb-1">MCP servers</h2>
          <p className="text-xs text-neutral-500 mb-4">
            配置外部 MCP (stdio) server，其工具会以 `mcp__&lt;server&gt;__&lt;tool&gt;`
            注入给 agent，调用前经审批/策略控制。配置保存到
            `~/.mini-pi/mcp/servers.json`。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || saving}
          className="px-2 py-1 text-xs border border-neutral-700 rounded hover:bg-neutral-900 disabled:opacity-50"
        >
          {loading ? "加载中" : "刷新"}
        </button>
      </div>

      {/* Existing servers */}
      {servers.length === 0 ? (
        <div className="text-xs text-neutral-600 mb-4">还没有配置 MCP server。</div>
      ) : (
        <div className="space-y-2 mb-4">
          {servers.map((s) => (
            <div
              key={s.id}
              className="rounded border border-neutral-800 bg-neutral-950/70 p-2"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span
                      className={s.enabled ? "text-emerald-300" : "text-neutral-500"}
                    >
                      {s.enabled ? "enabled" : "disabled"}
                    </span>
                    <span className="font-mono text-neutral-300">{s.id}</span>
                    {s.title ? (
                      <span className="text-neutral-500">{s.title}</span>
                    ) : null}
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-neutral-400">
                    {s.command} {(s.args ?? []).join(" ")}
                  </div>
                  {testResults[s.id] ? (
                    <div className="mt-1 text-[11px] text-neutral-500">
                      {testResults[s.id]}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void test(s.id)}
                    className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-900 disabled:opacity-50"
                  >
                    测试
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void toggle(s)}
                    className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-900 disabled:opacity-50"
                  >
                    {s.enabled ? "禁用" : "启用"}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void remove(s.id)}
                    className="rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-neutral-900 disabled:opacity-50"
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / edit draft */}
      <div className="border-t border-neutral-800 pt-3">
        <h3 className="text-xs font-semibold text-neutral-300 mb-2">添加 server</h3>
        <div className="grid gap-2 md:grid-cols-2">
          <Field
            label="id"
            placeholder="filesystem"
            value={draft.id}
            onChange={(v) => setDraft((d) => ({ ...d, id: v }))}
          />
          <Field
            label="title (可选)"
            placeholder="Filesystem"
            value={draft.title}
            onChange={(v) => setDraft((d) => ({ ...d, title: v }))}
          />
          <Field
            label="command"
            placeholder="npx"
            value={draft.command}
            onChange={(v) => setDraft((d) => ({ ...d, command: v }))}
          />
          <Field
            label="args (空格分隔)"
            placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
            value={draft.args}
            onChange={(v) => setDraft((d) => ({ ...d, args: v }))}
          />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft((d) => ({ ...d, enabled: e.target.checked }))
              }
            />
            enabled
          </label>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="px-3 py-1 text-xs bg-blue-700 hover:bg-blue-600 rounded disabled:bg-neutral-800 disabled:text-neutral-600"
          >
            {saving ? "保存中" : "保存 server"}
          </button>
        </div>
      </div>
      {status ? <div className="mt-2 text-xs text-neutral-500">{status}</div> : null}
    </section>
  );
}

function Field({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-500">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-200 outline-none focus:border-neutral-600"
      />
    </label>
  );
}

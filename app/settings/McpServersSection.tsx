"use client";

import { useCallback, useEffect, useState } from "react";
import type { McpServerConfig } from "@/lib/mcp/types";
import { userFacingMessage } from "@/lib/user-facing-error";

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
  const [showDraft, setShowDraft] = useState(false);
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
      setStatus(`加载失败：${userFacingMessage(e)}`);
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
      setShowDraft(false);
      await load();
      setStatus("已保存");
    } catch (e) {
      setStatus(`保存失败：${userFacingMessage(e)}`);
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
        setStatus(`删除失败：${userFacingMessage(e)}`);
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
        setStatus(`更新失败：${userFacingMessage(e)}`);
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
        setTestResults((prev) => ({
          ...prev,
          [id]: `失败：${userFacingMessage(e)}`,
        }));
      }
    },
    [post]
  );

  return (
    <section className="mb-6 border border-neutral-800 rounded p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold mb-1">外部工具服务</h2>
          <p className="text-xs text-neutral-500 mb-4">
            用于接入 MCP 工具服务。普通用户通常不需要配置；启用后，服务里的工具会交给 Agent 使用，并继续受审批规则约束。
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
        <div className="text-xs text-neutral-600 mb-4">还没有配置外部工具服务。</div>
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
                      {s.enabled ? "已启用" : "已停用"}
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
        {!showDraft ? (
          <button
            type="button"
            onClick={() => setShowDraft(true)}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
          >
            添加工具服务
          </button>
        ) : null}
        {showDraft ? (
          <>
        <h3 className="text-xs font-semibold text-neutral-300 mb-2">添加工具服务</h3>
        <div className="grid gap-2 md:grid-cols-2">
          <Field
            label="服务标识"
            placeholder="filesystem"
            value={draft.id}
            onChange={(v) => setDraft((d) => ({ ...d, id: v }))}
          />
          <Field
            label="显示名称（可选）"
            placeholder="Filesystem"
            value={draft.title}
            onChange={(v) => setDraft((d) => ({ ...d, title: v }))}
          />
          <Field
            label="启动命令"
            placeholder="npx"
            value={draft.command}
            onChange={(v) => setDraft((d) => ({ ...d, command: v }))}
          />
          <Field
            label="启动参数（用空格分隔）"
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
            保存后立即启用
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setDraft(EMPTY_DRAFT);
                setShowDraft(false);
              }}
              disabled={saving}
              className="px-3 py-1 text-xs border border-neutral-700 rounded hover:bg-neutral-900 disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="px-3 py-1 text-xs bg-blue-700 hover:bg-blue-600 rounded disabled:bg-neutral-800 disabled:text-neutral-600"
            >
              {saving ? "保存中" : "保存工具服务"}
            </button>
          </div>
        </div>
          </>
        ) : null}
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

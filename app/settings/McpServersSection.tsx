"use client";

import { useCallback, useEffect, useState } from "react";
import type { McpServerConfig } from "@/lib/mcp/types";
import { userFacingMessage } from "@/lib/user-facing-error";
import { Badge, Button, FieldInput } from "@/app/components/DesignPrimitives";

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
    <section className="mb-6 rounded-token border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="mb-1 text-token-body font-semibold">外部工具服务</h2>
          <p className="mb-4 text-token-sm text-[color:var(--text-muted)]">
            用于接入 MCP 工具服务。普通用户通常不需要配置；启用后，服务里的工具会交给 Agent 使用，并继续受审批规则约束。
          </p>
        </div>
        <Button
          type="button"
          onClick={() => void load()}
          disabled={loading || saving}
          size="sm"
          variant="outline"
        >
          {loading ? "加载中" : "刷新"}
        </Button>
      </div>

      {/* Existing servers */}
      {servers.length === 0 ? (
        <div className="mb-4 text-token-sm text-[color:var(--text-dim)]">还没有配置外部工具服务。</div>
      ) : (
        <div className="space-y-2 mb-4">
          {servers.map((s) => (
            <div
              key={s.id}
              className="rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] p-3"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-token-sm">
                    <Badge tone={s.enabled ? "success" : "default"} variant={s.enabled ? "soft" : "outline"}>
                      {s.enabled ? "已启用" : "已停用"}
                    </Badge>
                    <span className="font-mono text-[color:var(--text)]">{s.id}</span>
                    {s.title ? (
                      <span className="text-[color:var(--text-muted)]">{s.title}</span>
                    ) : null}
                  </div>
                  <div className="mt-1 truncate font-mono text-token-sm text-[color:var(--text-muted)]">
                    {s.command} {(s.args ?? []).join(" ")}
                  </div>
                  {testResults[s.id] ? (
                    <div className="mt-1 text-token-xs text-[color:var(--text-muted)]">
                      {testResults[s.id]}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <Button
                    type="button"
                    disabled={saving}
                    onClick={() => void test(s.id)}
                    size="xs"
                    variant="outline"
                  >
                    测试
                  </Button>
                  <Button
                    type="button"
                    disabled={saving}
                    onClick={() => void toggle(s)}
                    size="xs"
                    variant="outline"
                  >
                    {s.enabled ? "禁用" : "启用"}
                  </Button>
                  <Button
                    type="button"
                    disabled={saving}
                    onClick={() => void remove(s.id)}
                    size="xs"
                    tone="danger"
                    variant="soft"
                  >
                    删除
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / edit draft */}
      <div className="border-t border-[color:var(--border-soft)] pt-3">
        {!showDraft ? (
          <Button
            type="button"
            onClick={() => setShowDraft(true)}
            size="sm"
            variant="outline"
          >
            添加工具服务
          </Button>
        ) : null}
        {showDraft ? (
          <>
        <h3 className="mb-2 text-token-sm font-semibold text-[color:var(--text)]">添加工具服务</h3>
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
          <label className="flex items-center gap-2 text-token-sm text-[color:var(--text-muted)]">
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
            <Button
              type="button"
              onClick={() => {
                setDraft(EMPTY_DRAFT);
                setShowDraft(false);
              }}
              disabled={saving}
              size="sm"
              variant="outline"
            >
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              size="sm"
              tone="accent"
              variant="soft"
            >
              {saving ? "保存中" : "保存工具服务"}
            </Button>
          </div>
        </div>
          </>
        ) : null}
      </div>
      {status ? <div className="mt-2 text-token-sm text-[color:var(--text-muted)]">{status}</div> : null}
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
      <span className="mb-1 block text-token-sm text-[color:var(--text-muted)]">{label}</span>
      <FieldInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full font-mono"
      />
    </label>
  );
}

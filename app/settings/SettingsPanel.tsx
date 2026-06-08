"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Eye, Plus, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { getElectronApi, type SettingsApi } from "@/lib/electron-bridge";
import { ConfirmButton } from "@/app/components/ConfirmButton";
import { BudgetSettingsSection } from "./BudgetSettingsSection";
import { CollabSettingsSection } from "./CollabSettingsSection";
import { WorkflowNetworkPolicySection } from "./WorkflowNetworkPolicySection";
import { McpServersSection } from "./McpServersSection";

/* ===================== Web 模式 Settings（用 /api/auth） ===================== */

interface WebAuthProvider {
  provider: string;
  displayName: string;
  hasAuth: boolean;
  credentialType: "api_key" | "oauth" | null;
  status: {
    configured: boolean;
    source?: string;
    label?: string;
  };
  supportsOAuth: boolean;
}

interface WebAuthResponse {
  providers: WebAuthProvider[];
  oauthProviders: string[];
  authPath?: string;
}

function WebSettingsPanel() {
  const [data, setData] = useState<WebAuthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [newProvider, setNewProvider] = useState("");
  const [newKey, setNewKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/auth");
      const d = (await r.json()) as WebAuthResponse & { error?: string };
      if (d.error) setError(d.error);
      else setData(d);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const saveKey = async (provider: string, apiKey: string) => {
    if (!apiKey.trim()) return;
    setBusy(provider);
    setError(null);
    try {
      const r = await fetch("/api/auth", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
      });
      const d = await r.json();
      if (d.error) setError(d.error);
      else {
        setEditing((s) => ({ ...s, [provider]: "" }));
        await load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const deleteKey = async (provider: string) => {
    setBusy(provider);
    setError(null);
    try {
      const r = await fetch(
        `/api/auth?provider=${encodeURIComponent(provider)}`,
        { method: "DELETE" }
      );
      const d = await r.json();
      if (d.error) setError(d.error);
      else await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const addNew = async () => {
    if (!newProvider.trim() || !newKey.trim()) return;
    await saveKey(newProvider.trim(), newKey.trim());
    setNewProvider("");
    setNewKey("");
  };

  return (
    <div className="settings-page h-screen overflow-y-scroll bg-[color:var(--bg)] text-[color:var(--text)]">
      <header className="sticky top-0 z-20 border-b bg-[color:var(--bg-panel)]/95 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">设置</h1>
            <p className="mt-1 text-xs text-[color:var(--text-muted)]">
              管理模型凭证、预算保护、工具审批、Workflow 网络边界和 MCP server。
            </p>
          </div>
        <div className="flex items-center gap-2 text-xs">
          <Link
            href="/"
            className="rounded border border-[color:var(--border)] px-2 py-1 hover:bg-[color:var(--bg-hover)]"
          >
            返回
          </Link>
          <button
            onClick={() => void load()}
            disabled={loading || busy !== null}
            className="inline-flex items-center gap-1 rounded border border-[color:var(--border)] px-2 py-1 hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
          >
            <RefreshCw size={13} />
            刷新
          </button>
        </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 p-6">
        <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
          <h2 className="text-sm font-semibold">Provider Credentials (Web)</h2>
          <p className="mt-1 text-xs leading-relaxed text-[color:var(--text-muted)]">
            Web 模式会把 API key 写入本机 auth 文件；桌面模式会优先使用系统 Keychain。
            修改凭证后，正在运行的后端进程可能需要刷新或重启后才会读取新值。
          </p>
        </section>

        {error && (
          <div className="rounded border border-red-800 bg-red-900/40 p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <BudgetSettingsSection />

        <CollabSettingsSection />

        <WorkflowNetworkPolicySection />
        <McpServersSection />

        <section className="text-xs text-neutral-500 leading-relaxed">
          Web 模式下凭证写到{" "}
          <code className="text-neutral-400">
            {data?.authPath ?? "~/.pi/auth.json"}
          </code>
          。OAuth 登录请走 CLI：
          <code className="ml-1 text-neutral-400">pi login &lt;provider&gt;</code>
          。
        </section>

        {loading ? (
          <div className="text-sm text-neutral-500">加载中…</div>
        ) : (
          <div className="space-y-2">
            {data?.providers.map((p) => {
              const editVal = editing[p.provider] ?? "";
              const isBusy = busy === p.provider;
              const isOAuth = p.credentialType === "oauth";
              return (
                <div
                  key={p.provider}
                  className="border border-neutral-800 rounded p-3 flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                      <span className="font-mono text-sm">{p.provider}</span>
                      <span className="text-xs text-neutral-500">
                        {p.displayName}
                      </span>
                      {p.hasAuth ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-900/40 border border-emerald-700 text-emerald-300">
                          ✓ {p.credentialType ?? "stored"}
                        </span>
                      ) : (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-500">
                          empty
                        </span>
                      )}
                      {p.status.source && (
                        <span
                          className="text-xs text-neutral-600 truncate"
                          title={p.status.label ?? p.status.source}
                        >
                          src: {p.status.source}
                        </span>
                      )}
                      {p.supportsOAuth && !isOAuth && (
                        <span
                          className="text-xs px-1 py-0.5 rounded border border-amber-700 text-amber-300"
                          title="该 provider 支持 OAuth，可在终端用 pi login 登录"
                        >
                          OAuth ↗
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-xs shrink-0">
                      {p.hasAuth && (
                        <ConfirmButton
                          onConfirm={() => void deleteKey(p.provider)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1 rounded border border-red-800 px-2 py-0.5 text-red-300 hover:bg-red-900/40 disabled:opacity-50"
                          title={`删除 ${p.provider} 的凭证`}
                        >
                          <Trash2 size={12} />
                          删除
                        </ConfirmButton>
                      )}
                    </div>
                  </div>

                  {!isOAuth && (
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        value={editVal}
                        onChange={(e) =>
                          setEditing((s) => ({
                            ...s,
                            [p.provider]: e.target.value,
                          }))
                        }
                        placeholder={
                          p.hasAuth
                            ? "覆盖现有 key（粘贴新 key）"
                            : "粘贴 API key…"
                        }
                        className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:border-neutral-600"
                      />
                      <button
                        onClick={() => void saveKey(p.provider, editVal)}
                        disabled={!editVal.trim() || isBusy}
                        className="px-3 py-1 text-xs bg-blue-700 hover:bg-blue-600 rounded disabled:bg-neutral-800 disabled:text-neutral-600"
                      >
                        {isBusy ? "…" : "保存"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 自定义 provider */}
        <section className="border border-dashed border-neutral-700 rounded p-3 space-y-2">
          <div className="text-xs text-neutral-500">
            添加未列出的 provider（pi-coding-agent SDK 内置 provider id）
          </div>
          <div className="flex gap-2">
            <input
              value={newProvider}
              onChange={(e) => setNewProvider(e.target.value)}
              placeholder="provider id"
              className="bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:border-neutral-600 w-48"
            />
            <input
              type="password"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="key"
              className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:border-neutral-600"
            />
            <button
              onClick={() => void addNew()}
              disabled={!newProvider.trim() || !newKey.trim()}
              className="inline-flex items-center gap-1 rounded bg-[color:var(--accent)] px-3 py-1 text-xs text-white hover:bg-[color:var(--accent-hover)] disabled:bg-neutral-800 disabled:text-neutral-600"
            >
              <Plus size={13} />
              添加
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

/* ===================== Electron 模式 Settings（用 keytar） ===================== */

interface ProviderRow {
  provider: string;
  /** keytar 里有 */
  hasKey: boolean;
  /** key 预览（masked），点显示按钮才完整取回 */
  preview?: string | null;
  /** env 名提示 */
  envNames: string[];
}

function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}

export default function SettingsPanel() {
  const [api, setApi] = useState<SettingsApi | null>(null);
  const [envMap, setEnvMap] = useState<Record<string, string[]>>({});
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // 编辑状态：provider -> 输入框值
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  // 新增 provider（不在已知 env map 里）
  const [newProvider, setNewProvider] = useState("");
  const [newKey, setNewKey] = useState("");

  // 注意：getElectronApi 在 SSR 时返回 null，必须 mount 后再访问
  useEffect(() => {
    const ea = getElectronApi();
    if (!ea) {
      queueMicrotask(() => setLoading(false));
      return;
    }
    queueMicrotask(() => setApi(ea.settings));
  }, []);

  const refresh = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      const [envM, stored] = await Promise.all([
        api.getProviderEnvMap(),
        api.listProviders(),
      ]);
      setEnvMap(envM);
      const storedSet = new Set(stored);
      // 行 = 已知 env 映射的 provider ∪ keytar 里已存的 provider
      const all = new Set<string>([...Object.keys(envM), ...stored]);
      const list: ProviderRow[] = [...all].sort().map((p) => ({
        provider: p,
        hasKey: storedSet.has(p),
        envNames: envM[p] ?? [],
        preview: null,
      }));
      setRows(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const saveKey = async (provider: string, value: string) => {
    if (!api) return;
    setBusy(provider);
    setError(null);
    try {
      await api.setKey(provider, value.trim());
      // 清空编辑框
      setEditing((s) => ({ ...s, [provider]: "" }));
      setRevealed((s) => ({ ...s, [provider]: "" }));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const deleteKey = async (provider: string) => {
    if (!api) return;
    setBusy(provider);
    try {
      await api.deleteKey(provider);
      setRevealed((s) => ({ ...s, [provider]: "" }));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const revealKey = async (provider: string) => {
    if (!api) return;
    setBusy(provider);
    try {
      const v = await api.getKey(provider);
      setRevealed((s) => ({ ...s, [provider]: v ?? "" }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const reloadServer = async () => {
    if (!api) return;
    setBusy("__server__");
    setError(null);
    try {
      const r = await api.reloadServer();
      alert(
        r.dev
          ? "dev 模式跳过 reload（next dev 由你手动管）"
          : `server reloaded: ${r.base ?? "?"}`
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const addNew = async () => {
    if (!newProvider.trim() || !newKey.trim()) return;
    await saveKey(newProvider.trim(), newKey.trim());
    setNewProvider("");
    setNewKey("");
  };

  const knownProviderList = useMemo(() => Object.keys(envMap).sort(), [envMap]);

  // Web 模式 fallback — 用 /api/auth 提供等价能力（写 ~/.pi/auth.json）
  if (!loading && !api) {
    return <WebSettingsPanel />;
  }

  return (
    <div className="settings-page h-screen overflow-y-scroll bg-[color:var(--bg)] text-[color:var(--text)]">
      <header className="sticky top-0 z-20 border-b bg-[color:var(--bg-panel)]/95 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">设置</h1>
            <p className="mt-1 text-xs text-[color:var(--text-muted)]">
              管理模型凭证、预算保护、工具审批、Workflow 网络边界和 MCP server。
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={() => void refresh()}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 rounded border border-[color:var(--border)] px-2 py-1 hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
            >
              <RefreshCw size={13} />
              刷新
            </button>
            <button
              onClick={() => void reloadServer()}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 rounded border border-[color:var(--accent)] bg-[color:var(--bg-subtle)] px-2 py-1 text-[color:var(--accent)] hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
              title="重启 standalone 后端，让新 key 生效"
            >
              <RotateCw size={13} />
              重启 server
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 p-6">
        <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
          <h2 className="text-sm font-semibold">Provider API Keys</h2>
          <p className="mt-1 text-xs leading-relaxed text-[color:var(--text-muted)]">
            API key 保存在 macOS Keychain，不写入明文配置文件。新增或替换 key
            后，点击“重启 server”让后台服务重新读取环境变量；开发模式下只会提示跳过。
          </p>
        </section>

        {error && (
          <div className="rounded border border-red-800 bg-red-900/40 p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <BudgetSettingsSection />

        <CollabSettingsSection />

        <WorkflowNetworkPolicySection />
        <McpServersSection />

        <section className="text-xs text-neutral-500 leading-relaxed">
          Key 保存在系统 keychain（macOS Keychain），不写明文文件。修改后点{" "}
          <code>↻ 重启 server</code> 让新 key 注入 standalone 后端。
        </section>

        {loading ? (
          <div className="text-sm text-neutral-500">加载中…</div>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => {
              const editVal = editing[row.provider] ?? "";
              const showVal = revealed[row.provider];
              const isBusy = busy === row.provider;
              return (
                <div
                  key={row.provider}
                  className="border border-neutral-800 rounded p-3 flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-sm">{row.provider}</span>
                      {row.hasKey ? (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-900/40 border border-emerald-700 text-emerald-300">
                          ✓ stored
                        </span>
                      ) : (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-800 border border-neutral-700 text-neutral-500">
                          empty
                        </span>
                      )}
                      {row.envNames.length > 0 && (
                        <span
                          className="text-xs text-neutral-600 truncate"
                          title={row.envNames.join(", ")}
                        >
                          env: {row.envNames.join(" / ")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-xs shrink-0">
                      {row.hasKey && (
                        <>
                          <button
                            onClick={() => void revealKey(row.provider)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-900 disabled:opacity-50"
                          >
                            <Eye size={12} />
                            显示
                          </button>
                          <ConfirmButton
                            onConfirm={() => void deleteKey(row.provider)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 rounded border border-red-800 px-2 py-0.5 text-red-300 hover:bg-red-900/40 disabled:opacity-50"
                            title={`删除 ${row.provider} 的 key`}
                          >
                            <Trash2 size={12} />
                            删除
                          </ConfirmButton>
                        </>
                      )}
                    </div>
                  </div>

                  {showVal !== undefined && (
                    <div className="text-xs font-mono text-neutral-400 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 break-all">
                      {showVal ? mask(showVal) : "(empty)"}
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={editVal}
                      onChange={(e) =>
                        setEditing((s) => ({
                          ...s,
                          [row.provider]: e.target.value,
                        }))
                      }
                      placeholder={
                        row.hasKey
                          ? "覆盖现有 key（粘贴新 key）"
                          : "粘贴 key…"
                      }
                      className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:border-neutral-600"
                    />
                    <button
                      onClick={() => void saveKey(row.provider, editVal)}
                      disabled={!editVal.trim() || isBusy}
                      className="px-3 py-1 text-xs bg-blue-700 hover:bg-blue-600 rounded disabled:bg-neutral-800 disabled:text-neutral-600"
                    >
                      保存
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 自定义 provider */}
        <section className="border border-dashed border-neutral-700 rounded p-3 space-y-2">
          <div className="text-xs text-neutral-500">
            添加未列出的 provider（SDK 内置 provider 名，例：cohere/together
            等。具体看 pi 文档）
          </div>
          <div className="flex gap-2">
            <input
              value={newProvider}
              onChange={(e) => setNewProvider(e.target.value)}
              placeholder="provider id"
              list="known-providers"
              className="bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:border-neutral-600 w-48"
            />
            <datalist id="known-providers">
              {knownProviderList.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <input
              type="password"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="key"
              className="flex-1 bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:border-neutral-600"
            />
            <button
              onClick={() => void addNew()}
              disabled={!newProvider.trim() || !newKey.trim()}
              className="inline-flex items-center gap-1 rounded bg-[color:var(--accent)] px-3 py-1 text-xs text-white hover:bg-[color:var(--accent-hover)] disabled:bg-neutral-800 disabled:text-neutral-600"
            >
              <Plus size={13} />
              添加
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

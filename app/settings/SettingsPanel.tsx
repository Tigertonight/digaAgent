"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Compass,
  CreditCard,
  Eye,
  FileSliders,
  Globe2,
  Hammer,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCw,
  Shield,
  Smartphone,
  Trash2,
} from "lucide-react";
import QRCode from "qrcode";
import {
  getElectronApi,
  type ElectronApi,
  type SettingsApi,
} from "@/lib/electron-bridge";
import { ConfirmButton } from "@/app/components/ConfirmButton";
import SkillsPanel from "@/app/components/SkillsPanel";
import { BudgetSettingsSection } from "./BudgetSettingsSection";
import { CollabSettingsSection } from "./CollabSettingsSection";
import { WorkflowNetworkPolicySection } from "./WorkflowNetworkPolicySection";
import { McpServersSection } from "./McpServersSection";
import { userFacingMessage } from "@/lib/user-facing-error";

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

const PRIMARY_PROVIDER_IDS = new Set([
  "openai",
  "openai-codex",
]);

type SettingsSectionId =
  | "models"
  | "safety"
  | "usage"
  | "skills"
  | "mcp"
  | "browser"
  | "workflows"
  | "mobile";

const SETTINGS_SECTIONS: Array<{
  group: "核心" | "工具与集成" | "桌面与访问";
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: typeof Shield;
}> = [
  {
    group: "核心",
    id: "models",
    label: "模型与账号",
    description: "管理模型服务商、API 密钥、OAuth 登录和自定义模型。",
    icon: FileSliders,
  },
  {
    group: "核心",
    id: "safety",
    label: "安全与审批",
    description: "控制高风险操作、工具审批和敏感访问边界。",
    icon: Shield,
  },
  {
    group: "核心",
    id: "usage",
    label: "用量保护",
    description: "限制单次任务的费用、轮数和运行时间。",
    icon: CreditCard,
  },
  {
    group: "工具与集成",
    id: "skills",
    label: "技能",
    description: "管理 Agent 可用的 Skills、启用状态和安装来源。",
    icon: Hammer,
  },
  {
    group: "工具与集成",
    id: "mcp",
    label: "MCP 工具",
    description: "接入外部 MCP 服务，让 Agent 使用更多本地或远程工具。",
    icon: Paperclip,
  },
  {
    group: "工具与集成",
    id: "browser",
    label: "浏览器",
    description: "管理浏览器自动化、站点权限和网页操作策略。",
    icon: Compass,
  },
  {
    group: "工具与集成",
    id: "workflows",
    label: "工作流网络",
    description: "管理动态工作流的网络访问规则、模板和运行记录。",
    icon: Globe2,
  },
  {
    group: "桌面与访问",
    id: "mobile",
    label: "移动端访问",
    description: "用手机连接这台电脑上的 Diga Agent。",
    icon: Smartphone,
  },
];

const SECTION_META = Object.fromEntries(
  SETTINGS_SECTIONS.map((section) => [section.id, section])
) as Record<SettingsSectionId, (typeof SETTINGS_SECTIONS)[number]>;

function SettingsShell({
  activeSection,
  onSectionChange,
  onRefresh,
  refreshDisabled,
  onReloadServer,
  reloadDisabled,
  children,
}: {
  activeSection: SettingsSectionId;
  onSectionChange: (id: SettingsSectionId) => void;
  onRefresh: () => void;
  refreshDisabled: boolean;
  onReloadServer?: () => void;
  reloadDisabled?: boolean;
  children: ReactNode;
}) {
  const active = SECTION_META[activeSection];

  useLayoutEffect(() => {
    try {
      const stored = localStorage.getItem("pi-theme");
      if (stored === "light" || stored === "dark") {
        document.documentElement.setAttribute("data-theme", stored);
      }
    } catch {
      // Keep the root layout default when localStorage is unavailable.
    }
  }, []);

  return (
    <div
      className="settings-page flex h-screen overflow-hidden bg-[color:var(--bg)] text-[color:var(--text)]"
    >
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-[color:var(--border)] bg-[color:var(--bg-panel)] px-5 py-6">
        <Link
          href="/"
          className="mb-7 inline-flex items-center gap-2 text-base font-semibold text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
        >
          <ArrowLeft size={22} />
          返回应用
        </Link>
        <nav className="min-h-0 flex-1 overflow-y-auto pr-1">
          {(["核心", "工具与集成", "桌面与访问"] as const).map((group) => (
            <div key={group} className="mb-8">
              <div className="mb-3 px-3 text-base font-semibold text-[color:var(--text-dim)]">
                {group}
              </div>
              <div className="space-y-1.5">
                {SETTINGS_SECTIONS.filter((item) => item.group === group).map(
                  (item) => {
                    const Icon = item.icon;
                    const selected = activeSection === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onSectionChange(item.id)}
                        className={`flex w-full items-center gap-4 rounded-xl px-4 py-3 text-left text-lg transition ${
                          selected
                            ? "bg-[color:var(--bg-selected)] text-[color:var(--text)]"
                            : "text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text)]"
                        }`}
                      >
                        <Icon size={22} />
                        <span>{item.label}</span>
                      </button>
                    );
                  }
                )}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-12 py-14">
          <header className="mb-12 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-5xl font-semibold tracking-normal">
                {active.label}
              </h1>
              <p className="mt-4 text-lg text-[color:var(--text-muted)]">
                {active.description}
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                onClick={onRefresh}
                disabled={refreshDisabled}
                className="inline-flex items-center gap-1 rounded-md border border-[color:var(--border)] px-3 py-1.5 text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
              >
                <RefreshCw size={13} />
                刷新
              </button>
              {onReloadServer ? (
                <button
                  onClick={onReloadServer}
                  disabled={reloadDisabled}
                  className="inline-flex items-center gap-1 rounded-md border border-[color:var(--accent)] bg-[color:var(--bg-subtle)] px-3 py-1.5 text-[color:var(--accent)] hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
                >
                  <RotateCw size={13} />
                  重启服务
                </button>
              ) : null}
            </div>
          </header>
          <div className="space-y-6">{children}</div>
        </div>
      </main>
    </div>
  );
}

function SkillsSettingsSection() {
  const [cwd, setCwd] = useState("");

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      void (async () => {
        try {
          const res = await fetch("/api/default-cwd");
          const data = (await res.json().catch(() => ({}))) as {
            cwd?: string;
            path?: string;
          };
          if (!cancelled) setCwd(data.cwd ?? data.path ?? "");
        } catch {
          if (!cancelled) setCwd("");
        }
      })();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <SkillsPanel cwd={cwd} embedded />
  );
}

interface BrowserSitePolicyView {
  allowedOrigins?: string[];
  blockedOrigins?: string[];
}

function BrowserPolicySection() {
  const [policy, setPolicy] = useState<BrowserSitePolicyView>({
    allowedOrigins: [],
    blockedOrigins: [],
  });
  const [allowDraft, setAllowDraft] = useState("");
  const [blockDraft, setBlockDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch("/api/browser/policy");
      const data = (await res.json()) as {
        policy?: BrowserSitePolicyView;
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? res.statusText);
      setPolicy({
        allowedOrigins: data.policy?.allowedOrigins ?? [],
        blockedOrigins: data.policy?.blockedOrigins ?? [],
      });
    } catch (e) {
      setStatus(`加载失败：${userFacingMessage(e)}`);
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

  const update = useCallback(
    async (type: "allow" | "block" | "remove", origin: string) => {
      const target = origin.trim();
      if (!target) return;
      setSaving(true);
      setStatus(null);
      try {
        const res = await fetch("/api/browser/policy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type, origin: target }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!res.ok || data.error) throw new Error(data.error ?? res.statusText);
        await load();
        setStatus("已保存");
      } catch (e) {
        setStatus(`保存失败：${userFacingMessage(e)}`);
      } finally {
        setSaving(false);
      }
    },
    [load]
  );

  return (
    <section className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">浏览器站点权限</h2>
          <p className="mt-1 text-sm leading-relaxed text-[color:var(--text-muted)]">
            控制 Agent 浏览器可以直接访问哪些外部站点。未记录的外部站点会在首次访问时请求确认。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || saving}
          className="rounded-md border border-[color:var(--border)] px-2 py-1 text-xs hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
        >
          {loading ? "加载中" : "刷新"}
        </button>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <BrowserPolicyList
          title="允许访问"
          emptyText="还没有固定允许的站点。"
          items={policy.allowedOrigins ?? []}
          disabled={saving}
          removeLabel="移除允许"
          onRemove={(origin) => void update("remove", origin)}
        />
        <BrowserPolicyList
          title="禁止访问"
          emptyText="还没有固定禁止的站点。"
          items={policy.blockedOrigins ?? []}
          disabled={saving}
          removeLabel="移除禁止"
          onRemove={(origin) => void update("remove", origin)}
        />
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        <div className="flex gap-2">
          <input
            value={allowDraft}
            onChange={(e) => setAllowDraft(e.target.value)}
            placeholder="https://example.com"
            className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm font-mono outline-none focus:border-neutral-600"
          />
          <button
            type="button"
            onClick={() => {
              void update("allow", allowDraft);
              setAllowDraft("");
            }}
            disabled={saving || !allowDraft.trim()}
            className="rounded bg-blue-700 px-3 py-1 text-xs hover:bg-blue-600 disabled:bg-neutral-800 disabled:text-neutral-600"
          >
            允许
          </button>
        </div>
        <div className="flex gap-2">
          <input
            value={blockDraft}
            onChange={(e) => setBlockDraft(e.target.value)}
            placeholder="https://example.com"
            className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm font-mono outline-none focus:border-neutral-600"
          />
          <button
            type="button"
            onClick={() => {
              void update("block", blockDraft);
              setBlockDraft("");
            }}
            disabled={saving || !blockDraft.trim()}
            className="rounded border border-red-800 px-3 py-1 text-xs text-red-300 hover:bg-red-900/30 disabled:opacity-50"
          >
            禁止
          </button>
        </div>
      </div>

      {status ? <div className="mt-3 text-xs text-neutral-500">{status}</div> : null}
    </section>
  );
}

function BrowserPolicyList({
  title,
  emptyText,
  items,
  disabled,
  removeLabel,
  onRemove,
}: {
  title: string;
  emptyText: string;
  items: string[];
  disabled: boolean;
  removeLabel: string;
  onRemove: (origin: string) => void;
}) {
  return (
    <div className="rounded-md border border-[color:var(--border-soft)] bg-[color:var(--bg)] p-3">
      <div className="mb-2 text-xs font-semibold text-neutral-300">{title}</div>
      {items.length === 0 ? (
        <div className="text-xs text-neutral-600">{emptyText}</div>
      ) : (
        <div className="space-y-2">
          {items.map((origin) => (
            <div
              key={origin}
              className="flex items-center justify-between gap-2 rounded border border-neutral-800 px-2 py-1.5"
            >
              <span className="min-w-0 truncate font-mono text-xs text-neutral-300">
                {origin}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRemove(origin)}
                className="shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-900 disabled:opacity-50"
              >
                {removeLabel}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function WebSettingsPanel() {
  const [data, setData] = useState<WebAuthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [newProvider, setNewProvider] = useState("");
  const [newKey, setNewKey] = useState("");
  const [showCustomProvider, setShowCustomProvider] = useState(false);
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [activeSection, setActiveSection] =
    useState<SettingsSectionId>("models");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/auth");
      const d = (await r.json()) as WebAuthResponse & { error?: string };
      if (d.error) setError(d.error);
      else setData(d);
    } catch (e) {
      setError(userFacingMessage(e, { context: "remote" }));
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
      setError(userFacingMessage(e, { context: "settings" }));
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
      setError(userFacingMessage(e, { context: "settings" }));
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
    <SettingsShell
      activeSection={activeSection}
      onSectionChange={setActiveSection}
      onRefresh={() => void load()}
      refreshDisabled={loading || busy !== null}
    >
      {error ? (
        <div className="rounded-md border border-red-800 bg-red-900/40 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {activeSection === "models" ? (
        <>
          <section className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-5">
            <h2 className="text-sm font-semibold">模型服务账号</h2>
            <p className="mt-1 text-sm leading-relaxed text-[color:var(--text-muted)]">
              管理 OpenAI、Anthropic 等模型服务的 API 密钥。Web 模式会把密钥写入本机 auth 文件。
            </p>
          </section>
          {loading ? (
            <div className="text-sm text-neutral-500">加载中…</div>
          ) : (
            <div className="space-y-2">
              {data?.providers
                .filter(
                  (p) =>
                    showAllProviders ||
                    p.hasAuth ||
                    PRIMARY_PROVIDER_IDS.has(p.provider)
                )
                .map((p) => {
                  const editVal = editing[p.provider] ?? "";
                  const isBusy = busy === p.provider;
                  const isOAuth = p.credentialType === "oauth";
                  return (
                    <div
                      key={p.provider}
                      className="flex flex-col gap-2 rounded-md border border-neutral-800 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="font-mono text-sm">{p.provider}</span>
                          <span className="text-xs text-neutral-500">
                            {p.displayName}
                          </span>
                          <span
                            className={`rounded border px-1.5 py-0.5 text-xs ${
                              p.hasAuth
                                ? "border-emerald-700 bg-emerald-900/40 text-emerald-300"
                                : "border-neutral-700 bg-neutral-800 text-neutral-500"
                            }`}
                          >
                            {p.hasAuth ? "已保存" : "未配置"}
                          </span>
                          {p.status.source ? (
                            <span
                              className="truncate text-xs text-neutral-600"
                              title={p.status.label ?? p.status.source}
                            >
                              来源：{p.status.source}
                            </span>
                          ) : null}
                          {p.supportsOAuth && !isOAuth ? (
                            <span className="rounded border border-amber-700 px-1 py-0.5 text-xs text-amber-300">
                              支持 OAuth
                            </span>
                          ) : null}
                        </div>
                        {p.hasAuth ? (
                          <ConfirmButton
                            onConfirm={() => void deleteKey(p.provider)}
                            disabled={isBusy}
                            className="inline-flex shrink-0 items-center gap-1 rounded border border-red-800 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900/40 disabled:opacity-50"
                            title={`删除 ${p.provider} 的凭证`}
                          >
                            <Trash2 size={12} />
                            删除
                          </ConfirmButton>
                        ) : null}
                      </div>
                      {!isOAuth ? (
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
                                ? "粘贴新密钥以替换当前密钥"
                                : "粘贴 API 密钥…"
                            }
                            className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm font-mono focus:border-neutral-600 focus:outline-none"
                          />
                          <button
                            onClick={() => void saveKey(p.provider, editVal)}
                            disabled={!editVal.trim() || isBusy}
                            className="rounded bg-blue-700 px-3 py-1 text-xs hover:bg-blue-600 disabled:bg-neutral-800 disabled:text-neutral-600"
                          >
                            {isBusy ? "…" : "保存"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              {data && data.providers.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowAllProviders((v) => !v)}
                  className="w-full rounded-md border border-neutral-800 px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
                >
                  {showAllProviders
                    ? "收起不常用服务商"
                    : `显示全部模型服务（${data.providers.length} 个）`}
                </button>
              ) : null}
            </div>
          )}
          <section className="space-y-2 rounded-md border border-dashed border-neutral-700 p-3">
            <button
              type="button"
              onClick={() => setShowCustomProvider((v) => !v)}
              className="text-xs text-neutral-400 hover:text-neutral-200"
            >
              {showCustomProvider ? "收起自定义服务商" : "高级：添加自定义服务商"}
            </button>
            {showCustomProvider ? (
              <>
                <div className="text-xs text-neutral-500">
                  适用于列表中没有的模型服务。需要填写 SDK 识别的服务商标识和对应 API 密钥。
                </div>
                <div className="flex gap-2">
                  <input
                    value={newProvider}
                    onChange={(e) => setNewProvider(e.target.value)}
                    placeholder="服务商标识"
                    className="w-48 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm font-mono focus:border-neutral-600 focus:outline-none"
                  />
                  <input
                    type="password"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="API 密钥"
                    className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm font-mono focus:border-neutral-600 focus:outline-none"
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
              </>
            ) : null}
          </section>
          <section className="text-xs leading-relaxed text-neutral-500">
            Web 模式下密钥写到{" "}
            <code className="text-neutral-400">
              {data?.authPath ?? "~/.pi/auth.json"}
            </code>
            。OAuth 登录请走 CLI：
            <code className="ml-1 text-neutral-400">pi login &lt;provider&gt;</code>。
          </section>
        </>
      ) : null}

      {activeSection === "safety" ? <CollabSettingsSection /> : null}
      {activeSection === "usage" ? <BudgetSettingsSection /> : null}
      {activeSection === "skills" ? <SkillsSettingsSection /> : null}
      {activeSection === "mobile" ? (
        <RemoteAccessSection
          electronApi={null}
          disabled={loading || busy !== null}
          onReloadServer={async () => {}}
        />
      ) : null}
      {activeSection === "mcp" ? <McpServersSection /> : null}
      {activeSection === "browser" ? <BrowserPolicySection /> : null}
      {activeSection === "workflows" ? <WorkflowNetworkPolicySection /> : null}
    </SettingsShell>
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

type RemoteMode = "off" | "vpn" | "lan";

interface RemotePairStartResponse {
  code: string;
  expiresAt: number;
  payload: {
    v: 1;
    hostName: string;
    instanceId: string;
    candidates: string[];
    code: string;
    tlsFingerprint?: string;
    version: string;
  };
}

interface RemoteDeviceView {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

interface RemoteDeviceDisplay extends RemoteDeviceView {
  duplicateIds: string[];
  duplicateCount: number;
}

interface PublicTunnelStatus {
  running: boolean;
  url?: string;
  target?: string;
  startedAt?: number;
  provider: "cloudflared";
  error?: string;
}

const REMOTE_DEVICE_ONLINE_MS = 2 * 60 * 1000;
const REMOTE_DEVICE_RECENT_MS = 10 * 60 * 1000;

function normalizeRemoteDeviceName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase() || "mobile device";
}

function remoteDeviceSeenAt(device: RemoteDeviceView): number {
  return device.lastSeenAt ?? device.createdAt;
}

function remoteDeviceConnection(device: RemoteDeviceView, now = Date.now()) {
  if (device.revokedAt) {
    return {
      label: "已撤销",
      tone: "border-neutral-700 bg-neutral-900/30 text-neutral-500",
    };
  }
  const last = device.lastSeenAt;
  if (last && now - last <= REMOTE_DEVICE_ONLINE_MS) {
    return {
      label: "在线",
      tone: "border-emerald-800 bg-emerald-950/30 text-emerald-200",
    };
  }
  if (last && now - last <= REMOTE_DEVICE_RECENT_MS) {
    return {
      label: "刚刚在线",
      tone: "border-blue-800 bg-blue-950/30 text-blue-200",
    };
  }
  return {
    label: "离线",
    tone: "border-neutral-700 bg-neutral-900/30 text-neutral-400",
  };
}

function dedupeRemoteDevices(devices: RemoteDeviceView[]): RemoteDeviceDisplay[] {
  const groups = new Map<string, RemoteDeviceView[]>();
  for (const device of devices) {
    const key = `${device.revokedAt ? "revoked" : "active"}:${normalizeRemoteDeviceName(device.name)}`;
    const current = groups.get(key);
    if (current) current.push(device);
    else groups.set(key, [device]);
  }
  return Array.from(groups.values())
    .map((group) => {
      const sorted = group
        .slice()
        .sort((a, b) => remoteDeviceSeenAt(b) - remoteDeviceSeenAt(a));
      const primary = sorted[0];
      return {
        ...primary,
        duplicateIds: sorted.slice(1).map((device) => device.id),
        duplicateCount: Math.max(0, sorted.length - 1),
      };
    })
    .sort((a, b) => {
      if (!!a.revokedAt !== !!b.revokedAt) return a.revokedAt ? 1 : -1;
      return remoteDeviceSeenAt(b) - remoteDeviceSeenAt(a);
    });
}

function RemoteAccessSection({
  electronApi,
  disabled,
  onReloadServer,
}: {
  electronApi: ElectronApi | null;
  disabled: boolean;
  onReloadServer: () => Promise<void>;
}) {
  const [mode, setMode] = useState<RemoteMode>("off");
  const [port, setPort] = useState(37373);
  const [pair, setPair] = useState<RemotePairStartResponse | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [pairBaseOptions, setPairBaseOptions] = useState<string[]>([]);
  const [selectedPairBase, setSelectedPairBase] = useState("");
  const [devices, setDevices] = useState<RemoteDeviceView[]>([]);
  const [showRevokedDevices, setShowRevokedDevices] = useState(false);
  const [tunnel, setTunnel] = useState<PublicTunnelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusNow, setStatusNow] = useState(0);

  const localFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (electronApi) {
        try {
          const secret = await electronApi.getLocalSecret();
          if (secret) headers.set("x-mini-pi-local-secret", secret);
        } catch {
          // Browser/dev mode may expose part of the Electron bridge without the
          // local-secret IPC handler. In that case Next's localhost fallback is
          // enough for local settings validation.
        }
      }
      return fetch(input, {
        ...init,
        headers,
      });
    },
    [electronApi]
  );

  const loadRemote = useCallback(async () => {
    setError(null);
    try {
      const [settings, devRes] = await Promise.all([
        electronApi
          ? electronApi.settings.load()
          : localFetch("/api/remote/settings").then((res) => res.json()),
        localFetch("/api/remote/devices"),
      ]);
      setMode(settings.remoteAccess?.mode ?? settings.mode ?? "off");
      const loadedPort = settings.remoteAccess?.port ?? settings.port ?? 37373;
      const devPort =
        !electronApi && typeof window !== "undefined"
          ? Number(window.location.port)
          : NaN;
      setPort(Number.isInteger(devPort) && devPort > 0 ? devPort : loadedPort);
      const devJson = (await devRes.json().catch(() => ({}))) as {
        devices?: RemoteDeviceView[];
      };
      setDevices(Array.isArray(devJson.devices) ? devJson.devices : []);
      setStatusNow(Date.now());
      const tunnelRes = await localFetch("/api/remote/tunnel/status");
      const tunnelJson = (await tunnelRes.json().catch(() => null)) as PublicTunnelStatus | null;
      setTunnel(tunnelJson);
    } catch (e) {
      setError(userFacingMessage(e, { context: "remote" }));
    }
  }, [electronApi, localFetch]);

  const saveRemotePatch = async (patch: { mode?: RemoteMode; port?: number }) => {
    if (electronApi) {
      const current = await electronApi.settings.load();
      await electronApi.settings.save({
        remoteAccess: {
          ...(current.remoteAccess ?? {}),
          ...patch,
        },
      });
      await onReloadServer();
      return;
    }
    const res = await localFetch("/api/remote/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(await res.text());
  };

  const resetPairing = () => {
    setPair(null);
    setQr(null);
    setPairUrl(null);
    setPairBaseOptions([]);
    setSelectedPairBase("");
  };

  const makePairQr = async (url: string) =>
    QRCode.toDataURL(url, {
      margin: 1,
      width: 220,
      color: {
        dark: "#101114",
        light: "#ffffff",
      },
    });

  const pairBaseKind = (base: string): "public" | "lan" | "other" => {
    if (base.includes("trycloudflare.com")) return "public";
    if (/^https?:\/\/10\./.test(base)) return "lan";
    if (/^https?:\/\/192\.168\./.test(base)) return "lan";
    if (/^https?:\/\/172\.(1[6-9]|2\d|3[0-1])\./.test(base)) return "lan";
    return "other";
  };

  const pairBaseLabel = (base: string) => {
    const kind = pairBaseKind(base);
    if (kind === "public") return "公网";
    if (kind === "lan") {
      const firstLan = pairBaseOptions.find((item) => pairBaseKind(item) === "lan");
      return firstLan === base ? "同一 Wi-Fi" : "其他网络";
    }
    return "其他网络";
  };

  const usablePairBases = (candidates: string[]) =>
    Array.from(new Set(candidates)).filter(
      (url) => !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)
    );

  const orderPairBases = (bases: string[]) =>
    bases.slice().sort((a, b) => {
      const order = { public: 0, lan: 1, other: 2 } as const;
      return order[pairBaseKind(a)] - order[pairBaseKind(b)];
    });

  const chooseDefaultPairBase = (bases: string[]) => {
    return bases.find((base) => pairBaseKind(base) === "public") ?? bases[0] ?? "";
  };

  const applyPairTarget = async (
    data: RemotePairStartResponse,
    base: string,
    bases: string[]
  ) => {
    const nextPairUrl = `${base}/mobile/pair/${encodeURIComponent(data.code)}`;
    setPair(data);
    setPairBaseOptions(bases);
    setSelectedPairBase(base);
    setPairUrl(nextPairUrl);
    setQr(await makePairQr(nextPairUrl));
  };

  useEffect(() => {
    queueMicrotask(() => void loadRemote());
  }, [loadRemote]);

  const saveMode = async (nextMode: RemoteMode) => {
    setBusy(true);
    setError(null);
    try {
      await saveRemotePatch({ mode: nextMode, port });
      setMode(nextMode);
      resetPairing();
      await loadRemote();
    } catch (e) {
      setError(userFacingMessage(e, { context: "settings" }));
    } finally {
      setBusy(false);
    }
  };

  const savePort = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveRemotePatch({ mode, port });
      resetPairing();
      await loadRemote();
    } catch (e) {
      setError(userFacingMessage(e, { context: "settings" }));
    } finally {
      setBusy(false);
    }
  };

  const startPairing = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!electronApi) {
        await saveRemotePatch({ mode, port });
      }
      const res = await localFetch("/api/remote/pair/start", { method: "POST" });
      const data = (await res.json()) as RemotePairStartResponse & {
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? res.statusText);
      const bases = orderPairBases(usablePairBases(data.payload.candidates));
      const first = chooseDefaultPairBase(bases);
      if (!first) {
        throw new Error("没有可用的移动端访问地址，请先开启同一 Wi-Fi 或公网访问。");
      }
      await applyPairTarget(data, first, bases);
    } catch (e) {
      setError(userFacingMessage(e, { context: "pairing" }));
    } finally {
      setBusy(false);
    }
  };

  const startTunnel = async () => {
    setBusy(true);
    setError(null);
    resetPairing();
    try {
      if (!electronApi) {
        await saveRemotePatch({ mode, port });
      }
      const res = await localFetch("/api/remote/tunnel/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port }),
      });
      const data = (await res.json().catch(() => ({}))) as PublicTunnelStatus;
      setTunnel(data);
      if (!res.ok || data.error || !data.url) {
        throw new Error(
          data.error ??
            "公网启动失败。请先安装 cloudflared：brew install cloudflared"
        );
      }
    } catch (e) {
      setError(userFacingMessage(e, { context: "remote" }));
    } finally {
      setBusy(false);
    }
  };

  const stopTunnel = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await localFetch("/api/remote/tunnel/stop", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as PublicTunnelStatus;
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setTunnel(data);
      resetPairing();
    } catch (e) {
      setError(userFacingMessage(e, { context: "remote" }));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await localFetch(`/api/remote/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());
      await loadRemote();
    } catch (e) {
      setError(userFacingMessage(e, { context: "settings" }));
    } finally {
      setBusy(false);
    }
  };

  const visibleDevices = showRevokedDevices
    ? dedupeRemoteDevices(devices)
    : dedupeRemoteDevices(devices.filter((device) => !device.revokedAt));
  const revokedCount = devices.filter((device) => device.revokedAt).length;
  const activeDevices = devices.filter((device) => !device.revokedAt);
  const dedupedActiveDevices = dedupeRemoteDevices(activeDevices);
  const duplicateIds = visibleDevices.flatMap((device) => device.duplicateIds);
  const duplicateCount = duplicateIds.length;
  const onlineCount = dedupedActiveDevices.filter(
    (device) =>
      device.lastSeenAt &&
      statusNow - device.lastSeenAt <= REMOTE_DEVICE_ONLINE_MS
  ).length;
  const recentCount = dedupedActiveDevices.filter(
    (device) =>
      device.lastSeenAt &&
      statusNow - device.lastSeenAt <= REMOTE_DEVICE_RECENT_MS
  ).length;
  const modeStatus =
    mode === "off"
      ? {
          title: "未开启",
          description: "手机暂时不能连接这台电脑。",
          tone: "border-neutral-700 bg-neutral-900/20 text-neutral-400",
        }
      : mode === "vpn"
        ? {
            title: "仅 VPN 可访问",
            description: "适合 Tailscale、ZeroTier 等私有网络。",
            tone: "border-blue-800 bg-blue-950/20 text-blue-200",
          }
        : {
            title: "局域网可访问",
            description: "同一 Wi-Fi 下的设备可以扫码连接。",
            tone: "border-emerald-800 bg-emerald-950/20 text-emerald-200",
          };

  const revokeDuplicateDevices = async () => {
    if (duplicateIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const id of duplicateIds) {
        const res = await localFetch(`/api/remote/devices/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(await res.text());
      }
      await loadRemote();
    } catch (e) {
      setError(userFacingMessage(e, { context: "settings" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold">手机访问电脑端</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[color:var(--text-muted)]">
            需要用手机访问电脑上的 Agent 时开启。个人使用建议优先选择仅 VPN；局域网模式只适合可信网络。
          </p>
        </div>
        <div className="inline-flex rounded border border-[color:var(--border)] p-0.5 text-xs">
          {(["off", "vpn", "lan"] as const).map((item) => (
            <button
              key={item}
              type="button"
              disabled={disabled || busy}
              onClick={() => void saveMode(item)}
              className={`rounded px-2 py-1 ${mode === item ? "bg-[color:var(--bg-selected)] text-[color:var(--accent)]" : "hover:bg-[color:var(--bg-hover)]"}`}
            >
              {item === "off" ? "关闭" : item === "vpn" ? "仅 VPN" : "局域网"}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-3">
        <div className={`rounded border p-3 text-xs ${modeStatus.tone}`}>
          <div className="flex items-center gap-2 font-medium">
            <span className="h-2 w-2 rounded-full bg-current" />
            {modeStatus.title}
          </div>
          <div className="mt-1 leading-relaxed text-[color:var(--text-muted)]">
            {modeStatus.description}
          </div>
        </div>
        <div
          className={`rounded border p-3 text-xs ${
            tunnel?.url
              ? "border-emerald-800 bg-emerald-950/20 text-emerald-200"
              : "border-neutral-700 bg-neutral-900/20 text-neutral-400"
          }`}
        >
          <div className="flex items-center gap-2 font-medium">
            <span className="h-2 w-2 rounded-full bg-current" />
            {tunnel?.url ? "公网已连接" : "公网未开启"}
          </div>
          <div className="mt-1 truncate text-[color:var(--text-muted)]">
            {tunnel?.url ?? "默认自动开启；手动关闭后保持关闭。"}
          </div>
        </div>
        <div className="rounded border border-[color:var(--border-soft)] bg-[color:var(--bg)] p-3 text-xs">
          <div className="font-medium">设备状态</div>
          <div className="mt-1 text-[color:var(--text-muted)]">
            {dedupedActiveDevices.length} 台已授权 · {onlineCount > 0 ? `${onlineCount} 台在线` : recentCount > 0 ? `${recentCount} 台刚刚在线` : "暂无在线设备"}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-2">
          <span className="text-[color:var(--text-muted)]">端口</span>
          <input
            type="number"
            min={1024}
            max={65535}
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
            className="w-24 rounded border border-[color:var(--border)] bg-[color:var(--bg)] px-2 py-1"
          />
        </label>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => void savePort()}
          className="rounded border border-[color:var(--border)] px-2 py-1 hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
        >
          保存端口并重启
        </button>
        <button
          type="button"
          disabled={disabled || busy || (mode === "off" && !tunnel?.url)}
          onClick={() => void startPairing()}
          className="rounded bg-[color:var(--accent)] px-3 py-1 text-white hover:bg-[color:var(--accent-hover)] disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          生成扫码配对
        </button>
      </div>

      <div className="mt-3 rounded border border-[color:var(--border-soft)] bg-[color:var(--bg)] p-3 text-xs">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-medium">
              <Globe2 size={14} />
              高级：公网访问
              {tunnel?.url ? (
                <span className="rounded border border-emerald-800 bg-emerald-950/30 px-1.5 py-0.5 text-[11px] text-emerald-200">
                  已开启
                </span>
              ) : null}
            </div>
            <p className="mt-1 leading-relaxed text-[color:var(--text-muted)]">
              用 Cloudflare Quick Tunnel 生成 HTTPS 地址，手机 5G 也能打开。默认自动开启；点击关闭后会记住你的选择。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {tunnel?.url ? (
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => void stopTunnel()}
                className="rounded border border-red-800 px-2 py-1 text-red-300 hover:bg-red-900/30 disabled:opacity-50"
              >
                关闭公网
              </button>
            ) : (
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => void startTunnel()}
                className="rounded border border-[color:var(--accent)] bg-[color:var(--bg-selected)] px-2 py-1 text-[color:var(--accent)] hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
              >
                开启公网
              </button>
            )}
          </div>
        </div>
        {tunnel?.url ? (
          <div
            className="mt-2 truncate rounded border border-[color:var(--border-soft)] px-2 py-1 font-mono"
            title={tunnel.url}
          >
            {tunnel.url}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="mt-3 rounded border border-red-800 bg-red-900/30 p-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      {pair ? (
        <div className="mt-4 grid gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
          <div className="rounded border border-[color:var(--border-soft)] bg-white p-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- QR code is a local data URL generated at runtime. */}
            {qr ? <img src={qr} alt="移动端配对二维码" className="h-auto w-full" /> : null}
          </div>
          <div className="min-w-0 space-y-2 text-xs">
            <div className="text-[color:var(--text-muted)]">
              二维码 {new Date(pair.expiresAt).toLocaleTimeString()} 过期。用手机系统相机扫码会自动打开配对页，进入后点击“开始配对”。
            </div>
            {pairUrl ? (
              <div
                className="truncate rounded border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-2 py-1 font-mono text-[11px]"
                title={pairUrl}
              >
                扫码链接：{pairUrl}
              </div>
            ) : null}
            {pairBaseOptions.length > 1 ? (
              <div className="flex flex-wrap gap-1">
                {pairBaseOptions.map((base) => {
                  const selected = base === selectedPairBase;
                  return (
                    <button
                      key={base}
                      type="button"
                      onClick={() => void applyPairTarget(pair, base, pairBaseOptions)}
                      className={`rounded border px-2 py-1 text-[11px] ${
                        selected
                          ? "border-[color:var(--accent)] bg-[color:var(--bg-selected)] text-[color:var(--accent)]"
                          : "border-[color:var(--border)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)]"
                      }`}
                      title={base}
                    >
                      {pairBaseLabel(base)}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="leading-relaxed text-[color:var(--text-muted)]">
              Safari 提示找不到服务器时，切换到「同一 Wi-Fi」二维码，并确认手机和电脑在同一 Wi-Fi；不在同一网络时使用「公网」。
            </div>
            <div className="space-y-1">
              {pair.payload.candidates.map((url) => (
                <div
                  key={url}
                  className="truncate rounded border border-[color:var(--border-soft)] px-2 py-1 font-mono"
                  title={url}
                >
                  {url}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-medium text-[color:var(--text-muted)]">
            已配对设备
          </div>
          {duplicateCount > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void revokeDuplicateDevices()}
              className="rounded border border-amber-700 px-2 py-1 text-xs text-amber-300 hover:bg-amber-950/30 disabled:opacity-50"
            >
              清理重复授权（{duplicateCount}）
            </button>
          ) : null}
        </div>
        {visibleDevices.length === 0 ? (
          <div className="text-xs text-[color:var(--text-muted)]">暂无设备。</div>
        ) : (
          visibleDevices.map((device) => {
            const connection = remoteDeviceConnection(device, statusNow);
            return (
            <div
              key={device.id}
              className="flex items-center justify-between gap-2 rounded border border-[color:var(--border-soft)] px-3 py-2 text-xs"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{device.name}</span>
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${connection.tone}`}
                  >
                    {connection.label}
                  </span>
                  {device.duplicateCount > 0 ? (
                    <span className="shrink-0 rounded border border-amber-700 bg-amber-950/20 px-1.5 py-0.5 text-[11px] text-amber-300">
                      已合并 {device.duplicateCount} 条重复授权
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-[color:var(--text-muted)]">
                  配对时间 {new Date(device.createdAt).toLocaleString()}
                  {device.lastSeenAt ? ` · 最近使用 ${new Date(device.lastSeenAt).toLocaleString()}` : ""}
                  {device.revokedAt ? ` · 已撤销 ${new Date(device.revokedAt).toLocaleString()}` : ""}
                </div>
              </div>
              {!device.revokedAt ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void revoke(device.id)}
                  className="shrink-0 rounded border border-red-800 px-2 py-1 text-red-300 hover:bg-red-900/30"
                >
                  撤销
                </button>
              ) : null}
            </div>
          );
          })
        )}
        {revokedCount > 0 ? (
          <button
            type="button"
            onClick={() => setShowRevokedDevices((v) => !v)}
            className="rounded border border-[color:var(--border)] px-2 py-1 text-xs text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)]"
          >
            {showRevokedDevices
              ? "隐藏已撤销设备"
              : `显示已撤销设备（${revokedCount}）`}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}

export default function SettingsPanel() {
  const [electronApi, setElectronApi] = useState<ElectronApi | null>(null);
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
  const [showCustomProvider, setShowCustomProvider] = useState(false);
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [activeSection, setActiveSection] =
    useState<SettingsSectionId>("models");

  // 注意：getElectronApi 在 SSR 时返回 null，必须 mount 后再访问
  useEffect(() => {
    const ea = getElectronApi();
    if (!ea) {
      queueMicrotask(() => setLoading(false));
      return;
    }
    queueMicrotask(() => {
      setElectronApi(ea);
      setApi(ea.settings);
    });
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
      setError(userFacingMessage(e, { context: "settings" }));
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
      setError(userFacingMessage(e, { context: "settings" }));
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
      setError(userFacingMessage(e, { context: "settings" }));
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
      setError(userFacingMessage(e, { context: "settings" }));
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
      setError(userFacingMessage(e, { context: "settings" }));
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
    <SettingsShell
      activeSection={activeSection}
      onSectionChange={setActiveSection}
      onRefresh={() => void refresh()}
      refreshDisabled={busy !== null}
      onReloadServer={() => void reloadServer()}
      reloadDisabled={busy !== null}
    >
      {error ? (
        <div className="rounded-md border border-red-800 bg-red-900/40 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {activeSection === "models" ? (
        <>
          <section className="rounded-md border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-5">
            <h2 className="text-sm font-semibold">模型服务账号</h2>
            <p className="mt-1 text-sm leading-relaxed text-[color:var(--text-muted)]">
              管理 OpenAI、Anthropic 等模型服务的 API 密钥。密钥保存在 macOS Keychain，不写入明文配置文件。
            </p>
          </section>
          {loading ? (
            <div className="text-sm text-neutral-500">加载中…</div>
          ) : (
            <div className="space-y-2">
              {rows
                .filter(
                  (row) =>
                    showAllProviders ||
                    row.hasKey ||
                    PRIMARY_PROVIDER_IDS.has(row.provider)
                )
                .map((row) => {
                  const editVal = editing[row.provider] ?? "";
                  const showVal = revealed[row.provider];
                  const isBusy = busy === row.provider;
                  return (
                    <div
                      key={row.provider}
                      className="flex flex-col gap-2 rounded-md border border-neutral-800 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="font-mono text-sm">{row.provider}</span>
                          <span
                            className={`rounded border px-1.5 py-0.5 text-xs ${
                              row.hasKey
                                ? "border-emerald-700 bg-emerald-900/40 text-emerald-300"
                                : "border-neutral-700 bg-neutral-800 text-neutral-500"
                            }`}
                          >
                            {row.hasKey ? "已保存" : "未配置"}
                          </span>
                          {row.envNames.length > 0 ? (
                            <span
                              className="truncate text-xs text-neutral-600"
                              title={row.envNames.join(", ")}
                            >
                              来源：{row.envNames.join(" / ")}
                            </span>
                          ) : null}
                        </div>
                        {row.hasKey ? (
                          <div className="flex shrink-0 items-center gap-1 text-xs">
                            <button
                              onClick={() => void revealKey(row.provider)}
                              disabled={isBusy}
                              className="inline-flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-900 disabled:opacity-50"
                            >
                              <Eye size={12} />
                              查看摘要
                            </button>
                            <ConfirmButton
                              onConfirm={() => void deleteKey(row.provider)}
                              disabled={isBusy}
                              className="inline-flex items-center gap-1 rounded border border-red-800 px-2 py-0.5 text-red-300 hover:bg-red-900/40 disabled:opacity-50"
                              title={`删除 ${row.provider} 的密钥`}
                            >
                              <Trash2 size={12} />
                              删除
                            </ConfirmButton>
                          </div>
                        ) : null}
                      </div>
                      {showVal !== undefined ? (
                        <div className="break-all rounded border border-neutral-800 bg-neutral-950 px-2 py-1 font-mono text-xs text-neutral-400">
                          {showVal ? mask(showVal) : "(empty)"}
                        </div>
                      ) : null}
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
                              ? "粘贴新密钥以替换当前密钥"
                              : "粘贴 API 密钥…"
                          }
                          className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm font-mono focus:border-neutral-600 focus:outline-none"
                        />
                        <button
                          onClick={() => void saveKey(row.provider, editVal)}
                          disabled={!editVal.trim() || isBusy}
                          className="rounded bg-blue-700 px-3 py-1 text-xs hover:bg-blue-600 disabled:bg-neutral-800 disabled:text-neutral-600"
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  );
                })}
              {rows.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowAllProviders((v) => !v)}
                  className="w-full rounded-md border border-neutral-800 px-2 py-1.5 text-xs text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
                >
                  {showAllProviders
                    ? "收起不常用服务商"
                    : `显示全部模型服务（${rows.length} 个）`}
                </button>
              ) : null}
            </div>
          )}
          <section className="space-y-2 rounded-md border border-dashed border-neutral-700 p-3">
            <button
              type="button"
              onClick={() => setShowCustomProvider((v) => !v)}
              className="text-xs text-neutral-400 hover:text-neutral-200"
            >
              {showCustomProvider ? "收起自定义服务商" : "高级：添加自定义服务商"}
            </button>
            {showCustomProvider ? (
              <>
                <div className="text-xs text-neutral-500">
                  适用于列表中没有的模型服务。需要填写 SDK 识别的服务商标识和对应 API 密钥。
                </div>
                <div className="flex gap-2">
                  <input
                    value={newProvider}
                    onChange={(e) => setNewProvider(e.target.value)}
                    placeholder="服务商标识"
                    list="known-providers"
                    className="w-48 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm font-mono focus:border-neutral-600 focus:outline-none"
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
                    placeholder="API 密钥"
                    className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm font-mono focus:border-neutral-600 focus:outline-none"
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
              </>
            ) : null}
          </section>
          <section className="text-xs leading-relaxed text-neutral-500">
            修改密钥后，点击顶部的 <code>重启服务</code> 让后台服务读取新配置。
          </section>
        </>
      ) : null}

      {activeSection === "safety" ? <CollabSettingsSection /> : null}
      {activeSection === "usage" ? <BudgetSettingsSection /> : null}
      {activeSection === "skills" ? <SkillsSettingsSection /> : null}
      {activeSection === "mobile" && electronApi ? (
        <RemoteAccessSection
          electronApi={electronApi}
          disabled={busy !== null}
          onReloadServer={reloadServer}
        />
      ) : null}
      {activeSection === "mcp" ? <McpServersSection /> : null}
      {activeSection === "browser" ? <BrowserPolicySection /> : null}
      {activeSection === "workflows" ? <WorkflowNetworkPolicySection /> : null}
    </SettingsShell>
  );
}

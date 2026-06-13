"use client";

/**
 * Auth 管理弹层。
 * - 列出所有 provider 的认证状态（hasAuth / source / credential type）
 * - 支持设置 API key（PUT /api/auth）
 * - 支持删除凭证（DELETE /api/auth?provider=...）
 * - OAuth 标记 supportsOAuth=true 的 provider 支持在此处打开授权登录
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, KeyRound } from "lucide-react";
import {
  AuthProviderRow,
  type AuthTestResult,
} from "./auth/AuthProviderRow";
import { OAuthLoginModal } from "./auth/OAuthLoginModal";
import { useProviderStatus } from "@/app/hooks/useProviderStatus";
import { userFacingMessage } from "@/lib/user-facing-error";

interface Props {
  onClose: () => void;
  onBack?: () => void;
  initialProvider?: string | null;
  /** 任何变更后调用，方便父组件刷新 providers/models */
  onChanged?: () => void;
}

export default function AuthPanel({
  onClose,
  onBack,
  initialProvider,
  onChanged,
}: Props) {
  const {
    authData: data,
    authProviders,
    authLoading: loading,
    authError,
    reloadAuth: load,
  } = useProviderStatus({ autoLoadAuth: true });
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  // 行内编辑：哪个 provider 在编辑，及其 input 值
  const [editing, setEditing] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, AuthTestResult>>(
    {}
  );

  // OAuth 登录弹层：当前正在登录哪个 provider
  const [oauthProvider, setOauthProvider] = useState<string | null>(null);
  const initialProviderRef = useRef(initialProvider?.trim() || null);

  useEffect(() => {
    if (authError) setError(authError);
  }, [authError]);

  useEffect(() => {
    const provider = initialProviderRef.current;
    if (!provider || !data) return;
    const hit = data.providers.find((p) => p.provider === provider);
    if (!hit) return;
    setSearch(provider);
    setShowAll(true);
    if (hit.supportsOAuth && provider === "openai-codex") {
      setOauthProvider(provider);
    } else {
      setEditing(provider);
      setKeyInput("");
    }
    initialProviderRef.current = null;
  }, [data]);

  const filtered = useMemo(() => {
    if (!authProviders) return [];
    const q = search.trim().toLowerCase();
    let list = authProviders;
    if (!showAll) list = list.filter((p) => p.hasAuth || p.supportsOAuth);
    if (q) {
      list = list.filter(
        (p) =>
          p.provider.toLowerCase().includes(q) ||
          p.displayName.toLowerCase().includes(q)
      );
    }
    return list;
  }, [authProviders, search, showAll]);

  const startEdit = useCallback((provider: string) => {
    setEditing(provider);
    setKeyInput("");
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setKeyInput("");
  }, []);

  const testAuth = useCallback(async (provider: string) => {
    setTesting(provider);
    setError(null);
    setTestResult((cur) => {
      const next = { ...cur };
      delete next[provider];
      return next;
    });
    try {
      const r = await fetch("/api/auth/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const d = (await r.json()) as AuthTestResult;
      setTestResult((cur) => ({
        ...cur,
        [provider]: {
          ...d,
          ok: Boolean(d.ok && r.ok),
          error: d.error ?? (!r.ok ? `HTTP ${r.status}` : undefined),
        },
      }));
    } catch (e) {
      setTestResult((cur) => ({
        ...cur,
        [provider]: { ok: false, error: String(e) },
      }));
    } finally {
      setTesting(null);
    }
  }, []);

  const saveKey = useCallback(
    async (provider: string) => {
      const k = keyInput.trim();
      if (!k) return;
      setBusy(provider);
      setError(null);
      try {
        const r = await fetch("/api/auth", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, apiKey: k }),
        });
        const d = await r.json();
        if (d.error) setError(userFacingMessage(d.error, { context: "settings" }));
        else {
          setEditing(null);
          setKeyInput("");
          await load();
          onChanged?.();
          void testAuth(provider);
        }
      } catch (e) {
        setError(userFacingMessage(e, { context: "settings" }));
      } finally {
        setBusy(null);
      }
    },
    [keyInput, load, onChanged, testAuth]
  );

  const removeKey = useCallback(
    async (provider: string) => {
      setBusy(provider);
      setError(null);
      try {
        const r = await fetch(
          `/api/auth?provider=${encodeURIComponent(provider)}`,
          { method: "DELETE" }
        );
        const d = await r.json();
        if (d.error) setError(userFacingMessage(d.error, { context: "settings" }));
        else {
          await load();
          onChanged?.();
        }
      } catch (e) {
        setError(userFacingMessage(e, { context: "settings" }));
      } finally {
        setBusy(null);
      }
    },
    [load, onChanged]
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md w-full max-w-2xl max-h-[80vh] flex flex-col"
        style={{
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          color: "var(--fg)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="px-4 py-2 flex items-center justify-between border-b"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <span className="text-sm font-semibold inline-flex items-center gap-1.5">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded border hover:opacity-80"
                style={{ borderColor: "var(--border)" }}
                aria-label="返回上一级"
                title="返回上一级"
              >
                <ArrowLeft size={13} />
              </button>
            )}
            <KeyRound size={14} />
            Auth
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="px-2 py-0.5 text-xs rounded border hover:opacity-80 disabled:opacity-50"
              style={{ borderColor: "var(--border)" }}
            >
              {loading ? "…" : "↻"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-2 py-0.5 text-xs rounded border hover:opacity-80"
              style={{ borderColor: "var(--border)" }}
            >
              ✕
            </button>
          </div>
        </header>

        <div
          className="px-4 py-2 border-b flex items-center gap-2"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索 provider"
            className="flex-1 rounded px-2 py-1 text-xs border outline-none"
            style={{
              background: "var(--bg-panel-2)",
              borderColor: "var(--border)",
              color: "var(--fg)",
            }}
          />
          <label className="flex items-center gap-1 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="accent-blue-600"
            />
            show all
          </label>
        </div>

        {error && (
          <div
            className="m-3 p-2 rounded text-xs"
            style={{
              background: "var(--color-danger-bg)",
              border: "1px solid var(--color-danger)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
          {filtered.map((p) => {
            const isEditing = editing === p.provider;
            const isBusy = busy === p.provider;
            const isTesting = testing === p.provider;
            const result = testResult[p.provider];
            return (
              <AuthProviderRow
                key={p.provider}
                provider={p}
                isEditing={isEditing}
                isBusy={isBusy}
                isTesting={isTesting}
                result={result}
                keyInput={keyInput}
                onStartEdit={startEdit}
                onTestAuth={(provider) => void testAuth(provider)}
                onRemoveKey={(provider) => void removeKey(provider)}
                onOpenOAuth={setOauthProvider}
                onKeyInputChange={setKeyInput}
                onSaveKey={(provider) => void saveKey(provider)}
                onCancelEdit={cancelEdit}
              />
            );
          })}
          {filtered.length === 0 && !loading && (
            <div
              className="text-xs text-center py-8"
              style={{ color: "var(--fg-faint)" }}
            >
              (无匹配；勾选 show all 查看所有 provider)
            </div>
          )}
        </div>

        {data?.authPath && (
          <div
            className="border-t px-4 py-2 text-token-xs"
            style={{
              borderColor: "var(--border-soft)",
              color: "var(--fg-faint)",
            }}
          >
            存储位置：{data.authPath}
          </div>
        )}
      </div>

      {oauthProvider && (
        <OAuthLoginModal
          provider={oauthProvider}
          onClose={() => setOauthProvider(null)}
          onSuccess={async () => {
            setOauthProvider(null);
            await load();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

"use client";

/**
 * Auth 管理弹层。
 * - 列出所有 provider 的认证状态（hasAuth / source / credential type）
 * - 支持设置 API key（PUT /api/auth）
 * - 支持删除凭证（DELETE /api/auth?provider=...）
 * - OAuth 标记 supportsOAuth=true 的会显示提示，但不在此处登录（需 CLI）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, Check } from "lucide-react";
import { ProviderIcon } from "./ProviderIcon";
import { ConfirmButton } from "./ConfirmButton";
import { useProviderStatus } from "@/app/hooks/useProviderStatus";

interface Props {
  onClose: () => void;
  /** 任何变更后调用，方便父组件刷新 providers/models */
  onChanged?: () => void;
}

interface AuthTestResult {
  ok: boolean;
  error?: string;
  latencyMs?: number;
  status?: number;
  model?: { provider: string; id: string; name?: string };
}

export default function AuthPanel({ onClose, onChanged }: Props) {
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

  useEffect(() => {
    if (authError) setError(authError);
  }, [authError]);

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
        if (d.error) setError(d.error);
        else {
          setEditing(null);
          setKeyInput("");
          await load();
          onChanged?.();
          void testAuth(provider);
        }
      } catch (e) {
        setError(String(e));
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
        if (d.error) setError(d.error);
        else {
          await load();
          onChanged?.();
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [load, onChanged]
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.55)" }}
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
              background: "rgba(220,38,38,0.15)",
              border: "1px solid rgba(220,38,38,0.5)",
              color: "#fca5a5",
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
              <div
                key={p.provider}
                className="rounded px-2 py-1.5 text-xs"
                style={{
                  background: "var(--bg-panel-2)",
                  border: "1px solid var(--border-soft)",
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="relative inline-flex items-center justify-center"
                    title={
                      p.hasAuth
                        ? `auth via ${p.status.source ?? "?"}`
                        : "no auth"
                    }
                  >
                    <ProviderIcon provider={p.provider} size={18} />
                    {p.hasAuth && (
                      <Check
                        size={10}
                        className="absolute -bottom-1 -right-1 rounded-full"
                        style={{
                          background: "var(--accent)",
                          color: "white",
                          padding: 1,
                        }}
                      />
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <div className="font-medium truncate">{p.displayName}</div>
                    <div
                      className="text-[10px] truncate"
                      style={{ color: "var(--fg-faint)" }}
                    >
                      {p.provider}
                      {p.status.source &&
                        ` · source: ${p.status.source}`}
                      {p.status.label && ` (${p.status.label})`}
                      {p.credentialType && ` · stored: ${p.credentialType}`}
                      {p.supportsOAuth && " · oauth available (use CLI: pi login)"}
                    </div>
                  </span>
                  {!isEditing && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => startEdit(p.provider)}
                        disabled={isBusy}
                        className="px-1.5 py-0.5 text-[10px] rounded border hover:opacity-80 disabled:opacity-50"
                        style={{ borderColor: "var(--border)" }}
                        title={
                          p.credentialType === "api_key"
                            ? "替换 API key"
                            : "设置 API key"
                        }
                      >
                        {p.credentialType === "api_key" ? "Replace" : "Set"}
                      </button>
                      {(p.credentialType === "api_key" ||
                        p.credentialType === "oauth") && (
                        <button
                          type="button"
                          onClick={() => void testAuth(p.provider)}
                          disabled={isBusy || isTesting}
                          className="px-1.5 py-0.5 text-[10px] rounded border hover:opacity-80 disabled:opacity-50"
                          style={{ borderColor: "var(--border)" }}
                          title={`验证 ${p.provider} 凭证是否可调用模型`}
                        >
                          {isTesting ? "…" : "Test"}
                        </button>
                      )}
                      {(p.credentialType === "api_key" ||
                        p.credentialType === "oauth") && (
                        <ConfirmButton
                          onConfirm={() => void removeKey(p.provider)}
                          disabled={isBusy}
                          className="px-1.5 py-0.5 text-[10px] rounded border hover:opacity-80 disabled:opacity-50"
                          style={{
                            borderColor: "var(--border)",
                            color: "#fca5a5",
                          }}
                          title={`删除 ${p.provider} 的凭证`}
                        >
                          ✕
                        </ConfirmButton>
                      )}
                    </div>
                  )}
                </div>
                {result && (
                  <div
                    className="mt-2 rounded border px-2 py-1 text-[10px]"
                    style={{
                      borderColor: result.ok
                        ? "rgba(34,197,94,0.45)"
                        : "rgba(248,113,113,0.45)",
                      background: result.ok
                        ? "rgba(34,197,94,0.10)"
                        : "rgba(248,113,113,0.10)",
                      color: result.ok ? "#86efac" : "#fca5a5",
                    }}
                  >
                    {result.ok
                      ? `Test passed${
                          result.model?.id ? ` · ${result.model.id}` : ""
                        }${
                          result.latencyMs ? ` · ${result.latencyMs}ms` : ""
                        }`
                      : `Test failed: ${result.error ?? "unknown error"}`}
                  </div>
                )}
                {p.supportsOAuth && !isEditing && (
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setOauthProvider(p.provider)}
                      disabled={isBusy}
                      className="px-2 py-1 text-[11px] rounded text-white disabled:opacity-50"
                      style={{ background: "var(--accent)" }}
                      title={
                        p.credentialType === "oauth"
                          ? "Re-login to refresh tokens"
                          : "Login via OAuth in browser"
                      }
                    >
                      🔐 {p.credentialType === "oauth" ? "Re-login" : "Login"}
                    </button>
                    <span
                      className="text-[10px]"
                      style={{ color: "var(--fg-faint)" }}
                    >
                      {p.credentialType === "oauth"
                        ? "Already connected. You can re-login or disconnect."
                        : "OAuth"}
                    </span>
                  </div>
                )}
                {isEditing && (
                  <div className="flex items-center gap-1 mt-2">
                    <input
                      type="password"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      placeholder="API key"
                      autoFocus
                      disabled={isBusy}
                      className="flex-1 rounded px-2 py-1 text-xs border outline-none font-mono"
                      style={{
                        background: "var(--bg-panel)",
                        borderColor: "var(--border)",
                        color: "var(--fg)",
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveKey(p.provider);
                        if (e.key === "Escape") cancelEdit();
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void saveKey(p.provider)}
                      disabled={isBusy || !keyInput.trim()}
                      className="px-2 py-1 text-xs rounded text-white disabled:opacity-50"
                      style={{ background: "var(--accent)" }}
                    >
                      {isBusy ? "…" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEdit}
                      disabled={isBusy}
                      className="px-2 py-1 text-xs rounded border hover:opacity-80 disabled:opacity-50"
                      style={{ borderColor: "var(--border)" }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
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
            className="px-4 py-2 border-t text-[10px]"
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

/* ===================== OAuth Login Modal ===================== */

type OAuthEvent =
  | { type: "session"; sessionId: string }
  | { type: "auth"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string }
  | {
      type: "prompt_request";
      token: string;
      prompt: { message: string; placeholder?: string };
    }
  | {
      type: "select_request";
      token: string;
      prompt: {
        message: string;
        options: { id: string; label: string }[];
      };
    }
  | { type: "manualCode_request"; token: string }
  | { type: "success"; provider: string }
  | { type: "error"; message: string }
  | { type: "cancelled"; provider: string };

interface OAuthModalProps {
  provider: string;
  onClose: () => void;
  onSuccess: () => void;
}

function OAuthLoginModal({ provider, onClose, onSuccess }: OAuthModalProps) {
  const [events, setEvents] = useState<OAuthEvent[]>([]);
  const [status, setStatus] = useState<
    "connecting" | "running" | "done" | "error" | "cancelled"
  >("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 当前等待用户输入的事件（prompt / select / manualCode）
  const [pending, setPending] = useState<{
    token: string;
    kind: "prompt" | "select" | "manualCode";
    prompt?: { message: string; placeholder?: string };
    options?: { id: string; label: string }[];
  } | null>(null);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const ev = new EventSource(
      `/api/auth/login/${encodeURIComponent(provider)}`
    );
    setStatus("running");

    const push = (e: OAuthEvent) => setEvents((prev) => [...prev, e]);

    ev.addEventListener("session", (m) => {
      push({ type: "session", ...JSON.parse((m as MessageEvent).data) });
    });
    ev.addEventListener("auth", (m) => {
      const data = JSON.parse((m as MessageEvent).data);
      push({ type: "auth", ...data });
      // 自动开新窗口
      try {
        window.open(data.url, "_blank", "noopener,noreferrer");
      } catch {
        // ignore
      }
    });
    ev.addEventListener("device_code", (m) => {
      push({ type: "device_code", ...JSON.parse((m as MessageEvent).data) });
    });
    ev.addEventListener("progress", (m) => {
      push({ type: "progress", ...JSON.parse((m as MessageEvent).data) });
    });
    ev.addEventListener("prompt_request", (m) => {
      const data = JSON.parse((m as MessageEvent).data);
      push({ type: "prompt_request", ...data });
      setPending({ token: data.token, kind: "prompt", prompt: data.prompt });
      setAnswer("");
    });
    ev.addEventListener("select_request", (m) => {
      const data = JSON.parse((m as MessageEvent).data);
      push({ type: "select_request", ...data });
      setPending({
        token: data.token,
        kind: "select",
        prompt: { message: data.prompt.message },
        options: data.prompt.options,
      });
      setAnswer("");
    });
    ev.addEventListener("manualCode_request", (m) => {
      const data = JSON.parse((m as MessageEvent).data);
      push({ type: "manualCode_request", ...data });
      setPending({
        token: data.token,
        kind: "manualCode",
        prompt: {
          message: "如果浏览器没自动打开，把回调 URL 或授权码粘贴到这里",
          placeholder: "authorization code or redirect URL",
        },
      });
      setAnswer("");
    });
    ev.addEventListener("success", (m) => {
      push({ type: "success", ...JSON.parse((m as MessageEvent).data) });
      setStatus("done");
      ev.close();
      setTimeout(() => onSuccess(), 600);
    });
    ev.addEventListener("error", (m) => {
      const data = JSON.parse((m as MessageEvent).data);
      push({ type: "error", ...data });
      setErrorMsg(data.message);
      setStatus("error");
      ev.close();
    });
    ev.addEventListener("cancelled", (m) => {
      push({ type: "cancelled", ...JSON.parse((m as MessageEvent).data) });
      setStatus("cancelled");
      ev.close();
    });
    ev.onerror = () => {
      // EventSource 出错时不一定带 message，只在没拿到 success/error 时上报
      if (status === "running") {
        setErrorMsg("连接中断");
        setStatus("error");
      }
      ev.close();
    };

    return () => {
      ev.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const submit = useCallback(
    async (response: string | undefined, cancel = false) => {
      if (!pending) return;
      setSubmitting(true);
      try {
        await fetch(`/api/auth/login/${encodeURIComponent(provider)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: pending.token, response, cancel }),
        });
        setPending(null);
        setAnswer("");
      } catch (e) {
        setErrorMsg(String(e));
      } finally {
        setSubmitting(false);
      }
    },
    [pending, provider]
  );

  const latestDeviceCode = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "device_code") return e;
    }
    return null;
  }, [events]);

  const latestAuth = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "auth") return e;
    }
    return null;
  }, [events]);

  const progressMessages = useMemo(
    () => events.filter((e) => e.type === "progress") as Extract<OAuthEvent, { type: "progress" }>[],
    [events]
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.7)" }}
      onClick={onClose}
    >
      <div
        className="rounded-md w-full max-w-lg max-h-[85vh] flex flex-col"
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
          <span className="text-sm font-semibold">
            🔐 OAuth 登录 — {provider}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-0.5 text-xs rounded border hover:opacity-80"
            style={{ borderColor: "var(--border)" }}
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          <div
            className="text-xs"
            style={{ color: "var(--fg-muted)" }}
          >
            状态：
            {status === "connecting" && "连接中…"}
            {status === "running" && "进行中…"}
            {status === "done" && (
              <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-400">
                <Check size={12} /> 登录成功，凭证已保存
              </span>
            )}
            {status === "error" && (
              <span className="text-red-600 dark:text-red-400">失败</span>
            )}
            {status === "cancelled" && "已取消"}
          </div>

          {latestAuth && (
            <div
              className="p-2 rounded text-xs space-y-1"
              style={{
                background: "var(--bg-panel-2)",
                border: "1px solid var(--border-soft)",
              }}
            >
              <div className="font-semibold">在浏览器中打开授权页：</div>
              <a
                href={latestAuth.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block break-all underline"
                style={{ color: "var(--accent)" }}
              >
                {latestAuth.url}
              </a>
              {latestAuth.instructions && (
                <div style={{ color: "var(--fg-faint)" }}>
                  {latestAuth.instructions}
                </div>
              )}
            </div>
          )}

          {latestDeviceCode && (
            <div
              className="p-2 rounded text-xs space-y-1"
              style={{
                background: "var(--bg-panel-2)",
                border: "1px solid var(--border-soft)",
              }}
            >
              <div className="font-semibold">设备码登录：</div>
              <div>
                打开{" "}
                <a
                  href={latestDeviceCode.verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                  style={{ color: "var(--accent)" }}
                >
                  {latestDeviceCode.verificationUri}
                </a>
              </div>
              <div>
                输入用户码：
                <code
                  className="ml-1 px-2 py-0.5 rounded font-mono text-sm"
                  style={{
                    background: "var(--bg-panel)",
                    color: "var(--fg)",
                  }}
                >
                  {latestDeviceCode.userCode}
                </code>
              </div>
            </div>
          )}

          {progressMessages.length > 0 && (
            <div
              className="text-[11px] font-mono space-y-0.5"
              style={{ color: "var(--fg-faint)" }}
            >
              {progressMessages.slice(-5).map((p, i) => (
                <div key={i}>· {p.message}</div>
              ))}
            </div>
          )}

          {pending && (
            <div
              className="p-2 rounded text-xs space-y-2"
              style={{
                background: "var(--bg-panel-2)",
                border: "1px solid var(--accent)",
              }}
            >
              <div className="font-semibold">{pending.prompt?.message}</div>
              {pending.kind === "select" && pending.options ? (
                <div className="space-y-1">
                  {pending.options.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => void submit(opt.id)}
                      disabled={submitting}
                      className="w-full text-left px-2 py-1.5 rounded border hover:opacity-80 disabled:opacity-50"
                      style={{
                        borderColor: "var(--border)",
                        background: "var(--bg-panel)",
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <input
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    placeholder={pending.prompt?.placeholder || ""}
                    autoFocus
                    disabled={submitting}
                    className="flex-1 rounded px-2 py-1 text-xs border outline-none font-mono"
                    style={{
                      background: "var(--bg-panel)",
                      borderColor: "var(--border)",
                      color: "var(--fg)",
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && answer.trim())
                        void submit(answer.trim());
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void submit(answer.trim())}
                    disabled={submitting || !answer.trim()}
                    className="px-2 py-1 text-xs rounded text-white disabled:opacity-50"
                    style={{ background: "var(--accent)" }}
                  >
                    {submitting ? "…" : "提交"}
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => void submit(undefined, true)}
                disabled={submitting}
                className="text-[10px] underline opacity-70 hover:opacity-100"
                style={{ color: "var(--fg-faint)" }}
              >
                取消这一步
              </button>
            </div>
          )}

          {errorMsg && (
            <div
              className="p-2 rounded text-xs"
              style={{
                background: "rgba(220,38,38,0.15)",
                border: "1px solid rgba(220,38,38,0.5)",
                color: "#fca5a5",
              }}
            >
              {errorMsg}
            </div>
          )}
        </div>

        <footer
          className="px-4 py-2 border-t flex items-center justify-end gap-2"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-xs rounded border hover:opacity-80"
            style={{ borderColor: "var(--border)" }}
          >
            {status === "done" ? "关闭" : "中止"}
          </button>
        </footer>
      </div>
    </div>
  );
}

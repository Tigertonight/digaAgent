"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";

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

export function OAuthLoginModal({
  provider,
  onClose,
  onSuccess,
}: OAuthModalProps) {
  const [events, setEvents] = useState<OAuthEvent[]>([]);
  const [status, setStatus] = useState<
    "connecting" | "running" | "done" | "error" | "cancelled"
  >("connecting");
  const statusRef = useRef(status);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [pending, setPending] = useState<{
    token: string;
    kind: "prompt" | "select" | "manualCode";
    prompt?: { message: string; placeholder?: string };
    options?: { id: string; label: string }[];
  } | null>(null);
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const ev = new EventSource(
      `/api/auth/login/${encodeURIComponent(provider)}`
    );
    queueMicrotask(() => setStatus("running"));
    statusRef.current = "running";

    const push = (e: OAuthEvent) => setEvents((prev) => [...prev, e]);

    ev.addEventListener("session", (m) => {
      push({ type: "session", ...JSON.parse((m as MessageEvent).data) });
    });
    ev.addEventListener("auth", (m) => {
      const data = JSON.parse((m as MessageEvent).data);
      push({ type: "auth", ...data });
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
      statusRef.current = "done";
      ev.close();
      setTimeout(() => onSuccess(), 600);
    });
    ev.addEventListener("error", (m) => {
      const data = JSON.parse((m as MessageEvent).data);
      push({ type: "error", ...data });
      setErrorMsg(data.message);
      setStatus("error");
      statusRef.current = "error";
      ev.close();
    });
    ev.addEventListener("cancelled", (m) => {
      push({ type: "cancelled", ...JSON.parse((m as MessageEvent).data) });
      setStatus("cancelled");
      statusRef.current = "cancelled";
      ev.close();
    });
    ev.onerror = () => {
      if (statusRef.current === "running") {
        setErrorMsg("连接中断");
        setStatus("error");
        statusRef.current = "error";
      }
      ev.close();
    };

    return () => {
      ev.close();
    };
     
  }, [onSuccess, provider]);

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
    () =>
      events.filter((e) => e.type === "progress") as Extract<
        OAuthEvent,
        { type: "progress" }
      >[],
    [events]
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: "var(--color-overlay)" }}
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
          <div className="text-xs" style={{ color: "var(--fg-muted)" }}>
            状态：
            {status === "connecting" && "连接中…"}
            {status === "running" && "进行中…"}
            {status === "done" && (
              <span
                className="inline-flex items-center gap-1"
                style={{ color: "var(--color-success)" }}
              >
                <Check size={12} /> 登录成功，凭证已保存
              </span>
            )}
            {status === "error" && (
              <span style={{ color: "var(--color-danger)" }}>失败</span>
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
              className="space-y-0.5 text-token-xs font-mono"
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
                    className="rounded px-2 py-1 text-xs disabled:opacity-50"
                    style={{
                      background: "var(--accent)",
                      color: "var(--color-bg)",
                    }}
                  >
                    {submitting ? "…" : "提交"}
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => void submit(undefined, true)}
                disabled={submitting}
                className="text-token-xs underline opacity-70 hover:opacity-100"
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
                background: "var(--color-danger-bg)",
                border: "1px solid var(--color-danger)",
                color: "var(--color-danger)",
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

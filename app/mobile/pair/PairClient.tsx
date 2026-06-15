"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Check, Loader2, WifiOff } from "lucide-react";
import { userFacingMessage } from "@/lib/user-facing-error";

interface PairPayload {
  v: 1;
  hostName: string;
  instanceId: string;
  candidates: string[];
  code: string;
  tlsFingerprint?: string;
  version: string;
}

async function probeCandidate(base: string): Promise<boolean> {
  // R2：/api/remote/ping 现在是公开 health endpoint，手机未配对前也能调。
  // 带上一个随机后缀参数，防中间代理误缓存。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const cacheBuster = Math.random().toString(36).slice(2, 8);
    const res = await fetch(
      `${base}/api/remote/ping?probe=${cacheBuster}`,
      {
        signal: controller.signal,
        cache: "no-store",
      }
    );
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default function MobilePairClient({
  initialCode = "",
  initialPayload = null,
  initialError = "",
}: {
  initialCode?: string;
  initialPayload?: PairPayload | null;
  initialError?: string;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "pairing" | "done" | "error">(
    initialError ? "error" : "idle"
  );
  const [message, setMessage] = useState(initialError);
  const [codePayload, setCodePayload] = useState<PairPayload | null>(initialPayload);
  const autoPairAttemptedRef = useRef(false);
  const code = useMemo(() => {
    if (initialCode) return initialCode;
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("code") ?? "";
  }, [initialCode]);
  const inlinePayload = useMemo<PairPayload | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("p");
    if (!raw) return null;
    try {
      return JSON.parse(decodeURIComponent(raw)) as PairPayload;
    } catch {
      return null;
    }
  }, []);
  const payload = codePayload ?? inlinePayload;

  const loadPayloadByCode = useCallback(async () => {
    if (codePayload) return;
    if (!code) return;
    setStatus("loading");
    setMessage("正在读取配对信息…");
    try {
      const res = await fetch(
        `/api/remote/pair/info?code=${encodeURIComponent(code)}`,
        { cache: "no-store" }
      );
      const data = (await res.json()) as { payload?: PairPayload; error?: string };
      if (!res.ok || !data.payload) {
        throw new Error(data.error ?? "配对二维码已过期或无效");
      }
      setCodePayload(data.payload);
      setStatus("idle");
      setMessage("");
    } catch (e) {
      setStatus("error");
      setMessage(userFacingMessage(e, { context: "pairing" }));
    }
  }, [code, codePayload]);

  useEffect(() => {
    queueMicrotask(() => void loadPayloadByCode());
  }, [loadPayloadByCode]);

  const pair = useCallback(async () => {
    if (!payload) return;
    setStatus("pairing");
    setMessage("正在探测主机地址…");
    try {
      let base = "";
      const candidates = Array.from(
        new Set([window.location.origin, ...payload.candidates])
      );
      for (const candidate of candidates) {
        setMessage("正在寻找可用连接…");
        if (await probeCandidate(candidate)) {
          base = candidate;
          break;
        }
      }
      if (!base) throw new Error("所有候选地址都不可达");
      const res = await fetch(`${base}/api/remote/pair/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: payload.code,
          deviceName: navigator.userAgent.slice(0, 80),
        }),
      });
      const data = (await res.json()) as {
        token?: string;
        deviceId?: string;
        error?: string;
      };
      if (!res.ok || !data.token || !data.deviceId) {
        throw new Error(data.error ?? "配对失败");
      }
      localStorage.setItem(
        "diga-agent-remote",
        JSON.stringify({
          token: data.token,
          deviceId: data.deviceId,
          baseUrl: base,
          candidates,
          instanceId: payload.instanceId,
          tlsFingerprint: payload.tlsFingerprint,
          pairedAt: Date.now(),
        })
      );
      setStatus("done");
      setMessage("配对完成，正在进入移动端工作台…");
      window.location.href = "/mobile";
    } catch (e) {
      setStatus("error");
      setMessage(userFacingMessage(e, { context: "pairing" }));
    }
  }, [payload]);

  useEffect(() => {
    if (!code || !payload || status !== "idle" || autoPairAttemptedRef.current) return;
    autoPairAttemptedRef.current = true;
    queueMicrotask(() => void pair());
  }, [code, pair, payload, status]);

  return (
    <main className="min-h-screen bg-[color:var(--bg)] px-5 py-8 text-[color:var(--text)]">
      <section className="mx-auto max-w-md space-y-5">
        <div>
          <h1 className="text-token-title font-semibold">连接 Diga Agent</h1>
          <p className="mt-2 text-token-body leading-relaxed text-[color:var(--text-muted)]">
            扫码配对后，这台移动设备会保存一个长期设备令牌。你可以在桌面端设置里随时撤销。
          </p>
        </div>

        {!payload && !code ? (
          <div className="space-y-4 rounded border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded border border-[color:var(--border-soft)] bg-[color:var(--bg)]">
                <Camera size={17} />
              </span>
              <div className="min-w-0">
                <div className="text-token-body font-medium">如何扫码</div>
                <ol className="mt-2 list-decimal space-y-1 pl-4 text-token-xs leading-relaxed text-[color:var(--text-muted)]">
                  <li>回到电脑端，刷新设置页或扫码弹窗。</li>
                  <li>重新点击“生成扫码配对”。</li>
                  <li>用手机系统相机扫描新的二维码。</li>
                  <li>新二维码链接会带有配对码路径，打开后会自动连接并进入移动端。</li>
                </ol>
              </div>
            </div>

            <div
              className="rounded-token border p-3 text-token-xs leading-relaxed"
              style={{
                background: "var(--color-warning-bg)",
                borderColor: "var(--color-warning)",
                color: "var(--color-warning)",
              }}
            >
              当前打开的链接缺少配对码，无法自动连接。请不要粘贴 payload，直接重新生成二维码再扫码。
            </div>
          </div>
        ) : !payload ? (
          <div className="space-y-4 rounded border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
            <div className="flex items-center gap-2 text-token-body text-[color:var(--text-muted)]">
              <Loader2 size={15} className="animate-spin" />
              正在读取二维码里的配对信息…
            </div>
          </div>
        ) : code ? (
          <div className="space-y-4 rounded border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
            <div className="space-y-1 text-token-body">
              <div className="font-medium">{payload.hostName}</div>
              <div className="text-token-xs text-[color:var(--text-muted)]">
                instance {payload.instanceId}
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-token border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-3 py-2 text-token-body text-[color:var(--text-muted)]">
              {status === "done" ? (
                <Check
                  size={15}
                  className="shrink-0"
                  style={{ color: "var(--color-success)" }}
                />
              ) : status === "error" ? (
                <WifiOff
                  size={15}
                  className="shrink-0"
                  style={{ color: "var(--color-danger)" }}
                />
              ) : (
                <Loader2 size={15} className="shrink-0 animate-spin" />
              )}
              <span>
                {status === "done"
                  ? "配对完成，正在进入移动端工作台…"
                  : status === "error"
                    ? "自动配对失败"
                    : message || "正在自动配对…"}
              </span>
            </div>
            {status === "error" ? (
              <button
                type="button"
                onClick={() => void pair()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-token bg-[color:var(--accent)] px-3 py-2 text-token-body font-medium"
                style={{ color: "var(--color-bg)" }}
              >
                重试自动配对
              </button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4 rounded border border-[color:var(--border)] bg-[color:var(--bg-panel)] p-4">
            <div className="space-y-1 text-token-body">
              <div className="font-medium">{payload.hostName}</div>
              <div className="text-token-xs text-[color:var(--text-muted)]">
                instance {payload.instanceId}
              </div>
            </div>
            <div className="space-y-1">
              {payload.candidates.map((candidate) => (
                <div
                  key={candidate}
                  className="truncate rounded-token border border-[color:var(--border-soft)] px-2 py-1 font-mono text-token-xs"
                >
                  {candidate}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void pair()}
              disabled={status === "pairing" || status === "done"}
              className="inline-flex w-full items-center justify-center gap-2 rounded-token bg-[color:var(--accent)] px-3 py-2 text-token-body font-medium disabled:opacity-50"
              style={{ color: "var(--color-bg)" }}
            >
              {status === "pairing" ? <Loader2 size={15} className="animate-spin" /> : status === "done" ? <Check size={15} /> : null}
              开始配对
            </button>
          </div>
        )}

        {message && (!code || status === "error") ? (
          <div
            className={`flex items-start gap-2 rounded-token border p-3 text-token-body ${
              status === "error"
                ? ""
                : "border-[color:var(--border)] bg-[color:var(--bg-panel)] text-[color:var(--text-muted)]"
            }`}
            style={
              status === "error"
                ? {
                    background: "var(--color-danger-bg)",
                    borderColor: "var(--color-danger)",
                    color: "var(--color-danger)",
                  }
                : undefined
            }
          >
            {status === "error" ? <WifiOff size={15} className="mt-0.5 shrink-0" /> : null}
            <span>{message}</span>
          </div>
        ) : null}
      </section>
    </main>
  );
}

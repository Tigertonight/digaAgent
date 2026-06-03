"use client";

import { useEffect, useState } from "react";
import { Camera, Globe, RefreshCw, Square, X } from "lucide-react";
import type { BrowserSiteCheck, BrowserSnapshot } from "@/lib/browser/types";

interface BrowserPanelProps {
  agentId: string | null;
  snapshot: BrowserSnapshot;
  width: number;
  onClose: () => void;
}

export function BrowserPanel({
  agentId,
  snapshot,
  width,
  onClose,
}: BrowserPanelProps) {
  const [url, setUrl] = useState(snapshot.url ?? "http://localhost:3000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState<BrowserSiteCheck | null>(null);

  useEffect(() => {
    if (snapshot.url) setUrl(snapshot.url);
  }, [snapshot.url]);

  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed) {
      setSite(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/browser/policy?url=${encodeURIComponent(trimmed)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: BrowserSiteCheck | null) => {
          if (!cancelled) setSite(data);
        })
        .catch(() => {
          if (!cancelled) setSite(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [url]);

  const run = async (type: "open" | "screenshot" | "close") => {
    if (!agentId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/browser/${agentId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(type === "open" ? { type, url } : { type }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? r.statusText);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const updateSitePolicy = async (type: "allow" | "block" | "remove") => {
    if (!site) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/browser/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, origin: site.origin }),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? r.statusText);
      const next = await fetch(
        `/api/browser/policy?url=${encodeURIComponent(url)}`
      );
      setSite((await next.json()) as BrowserSiteCheck);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="h-full min-h-0 border-l flex flex-col"
      style={{
        width,
        minWidth: 320,
        maxWidth: "80vw",
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        color: "var(--text)",
      }}
    >
      <div
        className="h-9 shrink-0 border-b px-2 flex items-center gap-2"
        style={{ borderColor: "var(--border-soft)" }}
      >
        <Globe size={15} style={{ color: "var(--text-muted)" }} />
        <form
          className="min-w-0 flex-1 flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            void run("open");
          }}
        >
          <input
            aria-label="Browser URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={!agentId || busy}
            className="h-6 min-w-0 flex-1 rounded border px-2 text-xs outline-none"
            style={{
              background: "var(--bg)",
              borderColor: "var(--border)",
              color: "var(--text)",
            }}
            placeholder={agentId ? "http://localhost:3000" : "Start a session first"}
          />
          <button
            type="submit"
            disabled={!agentId || busy}
            className="h-6 w-7 rounded border inline-flex items-center justify-center disabled:opacity-50"
            style={{ borderColor: "var(--border)" }}
            title="Open URL"
          >
            <RefreshCw size={13} />
          </button>
        </form>
        <button
          type="button"
          disabled={!agentId || busy}
          onClick={() => void run("screenshot")}
          className="h-6 w-7 rounded border inline-flex items-center justify-center disabled:opacity-50"
          style={{ borderColor: "var(--border)" }}
          title="Capture screenshot"
        >
          <Camera size={13} />
        </button>
        <button
          type="button"
          disabled={!agentId || busy}
          onClick={() => void run("close")}
          className="h-6 w-7 rounded border inline-flex items-center justify-center disabled:opacity-50"
          style={{ borderColor: "var(--border)" }}
          title="Close browser session"
        >
          <Square size={12} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-6 w-7 rounded border inline-flex items-center justify-center"
          style={{ borderColor: "var(--border)" }}
          title="Close panel"
        >
          <X size={13} />
        </button>
      </div>

      <div
        className="shrink-0 border-b px-2 py-1 text-[11px] flex items-center gap-2"
        style={{ borderColor: "var(--border-soft)", color: "var(--text-muted)" }}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: statusColor(snapshot.status) }}
        />
        <span className="uppercase">{snapshot.status}</span>
        {snapshot.title && <span className="truncate">· {snapshot.title}</span>}
      </div>

      <div
        className="shrink-0 border-b px-2 py-1.5 flex items-center gap-2 text-[11px]"
        style={{ borderColor: "var(--border-soft)" }}
      >
        <span
          className="rounded border px-1.5 py-0.5 uppercase"
          style={{
            borderColor: siteBorder(site?.decision),
            color: siteColor(site?.decision),
            background: siteBg(site?.decision),
          }}
        >
          {site?.decision ?? "checking"}
        </span>
        <span
          className="min-w-0 flex-1 truncate"
          title={site?.origin ?? url}
          style={{ color: "var(--text-muted)" }}
        >
          {site?.origin ?? url}
        </span>
        {site && site.decision !== "local" && (
          <>
            <button
              type="button"
              disabled={busy || site.decision === "allowed"}
              onClick={() => void updateSitePolicy("allow")}
              className="rounded border px-1.5 py-0.5 disabled:opacity-45"
              style={{ borderColor: "var(--border)" }}
              title="Allow this site for browser use"
            >
              Allow
            </button>
            <button
              type="button"
              disabled={busy || site.decision === "blocked"}
              onClick={() => void updateSitePolicy("block")}
              className="rounded border px-1.5 py-0.5 disabled:opacity-45"
              style={{ borderColor: "var(--border)" }}
              title="Block this site"
            >
              Block
            </button>
            {(site.decision === "allowed" || site.decision === "blocked") && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void updateSitePolicy("remove")}
                className="rounded border px-1.5 py-0.5 disabled:opacity-45"
                style={{ borderColor: "var(--border)" }}
                title="Reset this site's policy"
              >
                Reset
              </button>
            )}
          </>
        )}
      </div>

      {(error || snapshot.error) && (
        <div
          className="mx-2 mt-2 rounded border px-2 py-1.5 text-xs"
          style={{
            borderColor: "rgba(239,68,68,0.45)",
            color: "#fca5a5",
            background: "rgba(239,68,68,0.10)",
          }}
        >
          {error ?? snapshot.error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden p-2">
        {snapshot.screenshotDataUrl ? (
          <img
            src={snapshot.screenshotDataUrl}
            alt="Browser screenshot"
            className="w-full h-full object-contain rounded border"
            style={{ borderColor: "var(--border-soft)", background: "#fff" }}
          />
        ) : (
          <div
            className="h-full rounded border flex items-center justify-center text-xs text-center px-6"
            style={{
              borderColor: "var(--border-soft)",
              color: "var(--text-muted)",
              background: "var(--bg)",
            }}
          >
            {agentId
              ? "Open a URL or ask the agent to use browser_open."
              : "Start a session before using the browser."}
          </div>
        )}
      </div>

      <div
        className="h-40 shrink-0 border-t overflow-auto"
        style={{ borderColor: "var(--border-soft)" }}
      >
        <div className="px-2 py-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Browser actions
        </div>
        {snapshot.logs.length === 0 ? (
          <div className="px-2 pb-2 text-xs" style={{ color: "var(--fg-faint)" }}>
            No browser actions yet.
          </div>
        ) : (
          <div className="px-2 pb-2 space-y-1">
            {snapshot.logs.map((log) => (
              <div
                key={log.id}
                className="rounded border px-2 py-1 text-xs"
                style={{
                  borderColor: "var(--border-soft)",
                  background: "var(--bg-panel-2)",
                }}
              >
                <div className="flex items-center gap-2">
                  <span style={{ color: statusColor(log.status) }}>●</span>
                  <span className="font-medium">{log.action}</span>
                  <span className="truncate" style={{ color: "var(--text-muted)" }}>
                    {log.label}
                  </span>
                </div>
                {log.error && (
                  <div className="mt-0.5" style={{ color: "#fca5a5" }}>
                    {log.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function statusColor(status: string) {
  if (status === "ready" || status === "done") return "#22c55e";
  if (status === "busy" || status === "launching" || status === "running")
    return "#f59e0b";
  if (status === "error") return "#ef4444";
  return "#737373";
}

function siteColor(decision?: string) {
  if (decision === "local" || decision === "allowed") return "#86efac";
  if (decision === "blocked") return "#fca5a5";
  if (decision === "unknown") return "#fcd34d";
  return "var(--text-muted)";
}

function siteBorder(decision?: string) {
  if (decision === "local" || decision === "allowed") return "rgba(34,197,94,0.45)";
  if (decision === "blocked") return "rgba(239,68,68,0.45)";
  if (decision === "unknown") return "rgba(245,158,11,0.50)";
  return "var(--border)";
}

function siteBg(decision?: string) {
  if (decision === "local" || decision === "allowed") return "rgba(34,197,94,0.10)";
  if (decision === "blocked") return "rgba(239,68,68,0.10)";
  if (decision === "unknown") return "rgba(245,158,11,0.10)";
  return "transparent";
}

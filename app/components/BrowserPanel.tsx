"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Copy,
  Globe,
  MousePointer2,
  Radio,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import type {
  BrowserPointerState,
  BrowserSiteCheck,
  BrowserSnapshot,
  BrowserStepSnapshot,
} from "@/lib/browser/types";

interface BrowserPanelProps {
  agentId: string | null;
  snapshot: BrowserSnapshot;
  width: number;
  openRequest?: { id: number; url: string } | null;
  onClose: () => void;
  onAnnotate: (text: string) => void;
}

export function BrowserPanel({
  agentId,
  snapshot,
  width,
  openRequest,
  onClose,
  onAnnotate,
}: BrowserPanelProps) {
  const [url, setUrl] = useState(snapshot.url ?? "http://localhost:3000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState<BrowserSiteCheck | null>(null);
  const [live, setLive] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [dragRect, setDragRect] = useState<Rect | null>(null);
  const [draftComment, setDraftComment] = useState("");
  const [pointerTrail, setPointerTrail] = useState<PointerTrail | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const previousPointerRef = useRef<BrowserPointerState | null>(null);
  const steps = snapshot.steps ?? [];

  const selectedStep = useMemo(
    () => steps.find((step) => step.id === selectedStepId) ?? null,
    [selectedStepId, steps]
  );
  const displayShot = selectedStep?.screenshotDataUrl ?? snapshot.screenshotDataUrl;
  const displayUrl = selectedStep?.url ?? snapshot.url;
  const displayTitle = selectedStep?.title ?? snapshot.title;
  const displayPointer = selectedStep?.pointer ?? snapshot.pointer ?? null;

  useEffect(() => {
    if (snapshot.url) setUrl(snapshot.url);
  }, [snapshot.url]);

  useEffect(() => {
    if (!selectedStepId) return;
    if (!steps.some((step) => step.id === selectedStepId)) {
      setSelectedStepId(null);
    }
  }, [selectedStepId, steps]);

  useEffect(() => {
    if (!displayPointer) {
      setPointerTrail(null);
      previousPointerRef.current = null;
      return;
    }
    const prev = previousPointerRef.current;
    setPointerTrail({
      from: prev ? { x: prev.x, y: prev.y } : null,
      to: { x: displayPointer.x, y: displayPointer.y },
    });
    previousPointerRef.current = displayPointer;
  }, [displayPointer]);

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

  const run = async (
    type: "open" | "screenshot" | "close",
    targetUrl?: string
  ) => {
    if (!agentId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/browser/${agentId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          type === "open" ? { type, url: targetUrl ?? url } : { type }
        ),
      });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error ?? r.statusText);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!openRequest?.url) return;
    setUrl(openRequest.url);
    void run("open", openRequest.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest?.id]);

  useEffect(() => {
    if (!live || !agentId) return;
    const t = setInterval(() => {
      void fetch(`/api/browser/${agentId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "refresh" }),
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [agentId, live]);

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

  const startAnnotation = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!displayShot) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = clamp((e.clientX - box.left) / box.width);
    const y = clamp((e.clientY - box.top) / box.height);
    dragStartRef.current = { x, y };
    setDragRect({ x, y, w: 0, h: 0 });
  };

  const moveAnnotation = (e: React.MouseEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x2 = clamp((e.clientX - box.left) / box.width);
    const y2 = clamp((e.clientY - box.top) / box.height);
    setDragRect({
      x: Math.min(start.x, x2),
      y: Math.min(start.y, y2),
      w: Math.abs(x2 - start.x),
      h: Math.abs(y2 - start.y),
    });
  };

  const finishAnnotation = () => {
    dragStartRef.current = null;
  };

  const submitAnnotation = () => {
    if (!dragRect || !draftComment.trim()) return;
    const area = `${pct(dragRect.x)},${pct(dragRect.y)} ${pct(dragRect.w)}x${pct(dragRect.h)}`;
    onAnnotate(
      [
        `Browser annotation on ${displayUrl ?? "(no url)"}`,
        displayTitle ? `Title: ${displayTitle}` : null,
        `Area: ${area}`,
        `Comment: ${draftComment.trim()}`,
      ]
        .filter(Boolean)
        .join("\n")
    );
    setDraftComment("");
    setDragRect(null);
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
          disabled={!displayUrl}
          onClick={() => {
            if (!displayUrl) return;
            void navigator.clipboard?.writeText(displayUrl).catch(() => {});
          }}
          className="h-6 w-7 rounded border inline-flex items-center justify-center disabled:opacity-50"
          style={{ borderColor: "var(--border)" }}
          title="Copy current browser URL"
        >
          <Copy size={13} />
        </button>
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
          disabled={!agentId}
          onClick={() => setLive((v) => !v)}
          className="h-6 w-7 rounded border inline-flex items-center justify-center disabled:opacity-50"
          style={{
            borderColor: live ? "rgba(34,197,94,0.55)" : "var(--border)",
            color: live ? "#86efac" : "var(--text)",
          }}
          title={live ? "Stop live refresh" : "Start near-live refresh"}
        >
          <Radio size={13} />
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
        {displayTitle && <span className="truncate">· {displayTitle}</span>}
        {selectedStep && (
          <span className="rounded border px-1 py-0.5" style={{ borderColor: "var(--border)" }}>
            replay
          </span>
        )}
        {snapshot.task && (
          <span
            className="rounded border px-1 py-0.5"
            style={{
              borderColor: "var(--border)",
              color: statusColor(snapshot.task.status),
            }}
            title={snapshot.task.id}
          >
            task {shortTaskId(snapshot.task.id)} · {snapshot.task.status}
          </span>
        )}
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
        {displayShot ? (
          <div
            className="relative w-full h-full rounded border overflow-hidden"
            style={{ borderColor: "var(--border-soft)", background: "#fff" }}
            onMouseDown={startAnnotation}
            onMouseMove={moveAnnotation}
            onMouseUp={finishAnnotation}
            onMouseLeave={finishAnnotation}
            title="Drag to annotate an area"
          >
            <img
              src={displayShot}
              alt="Browser screenshot"
              className="w-full h-full object-contain select-none"
              draggable={false}
            />
            {pointerTrail && displayPointer && (
              <VirtualPointer
                pointer={displayPointer}
                trail={pointerTrail}
              />
            )}
            {dragRect && dragRect.w > 0.01 && dragRect.h > 0.01 && (
              <div
                className="absolute border-2"
                style={{
                  left: `${dragRect.x * 100}%`,
                  top: `${dragRect.y * 100}%`,
                  width: `${dragRect.w * 100}%`,
                  height: `${dragRect.h * 100}%`,
                  borderColor: "var(--accent)",
                  background: "rgba(59,130,246,0.12)",
                }}
              />
            )}
          </div>
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

      {dragRect && dragRect.w > 0.01 && dragRect.h > 0.01 && (
        <div
          className="shrink-0 border-t p-2 flex items-center gap-2"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <input
            aria-label="Browser annotation comment"
            value={draftComment}
            onChange={(e) => setDraftComment(e.target.value)}
            className="h-7 min-w-0 flex-1 rounded border px-2 text-xs outline-none"
            style={{
              background: "var(--bg)",
              borderColor: "var(--border)",
              color: "var(--text)",
            }}
            placeholder="Comment on selected area"
          />
          <button
            type="button"
            onClick={submitAnnotation}
            className="h-7 rounded border px-2 text-xs"
            style={{ borderColor: "var(--border)" }}
          >
            Add
          </button>
        </div>
      )}

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
                  {log.taskId && (
                    <span
                      className="rounded border px-1 py-0.5 text-[10px]"
                      style={{
                        borderColor: "var(--border-soft)",
                        color: "var(--text-muted)",
                      }}
                    >
                      {shortTaskId(log.taskId)}
                    </span>
                  )}
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

      {steps.length > 0 && (
        <div
          className="h-28 shrink-0 border-t overflow-x-auto"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <div className="px-2 py-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
            Step timeline
          </div>
          <div className="px-2 pb-2 flex gap-2">
            {steps.map((step: BrowserStepSnapshot) => (
              <button
                key={step.id}
                type="button"
                onClick={() =>
                  setSelectedStepId((cur) => (cur === step.id ? null : step.id))
                }
                className="w-28 shrink-0 rounded border p-1 text-left"
                style={{
                  borderColor:
                    selectedStepId === step.id ? "var(--accent)" : "var(--border-soft)",
                  background: "var(--bg-panel-2)",
                }}
                title={step.label}
              >
                <div
                  className="h-12 rounded overflow-hidden border mb-1"
                  style={{ borderColor: "var(--border-soft)", background: "#fff" }}
                >
                  {step.screenshotDataUrl && (
                    <img
                      src={step.screenshotDataUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
                <div className="truncate text-[11px] font-medium">{step.action}</div>
                <div className="flex items-center gap-1 min-w-0">
                  <span
                    className="shrink-0 text-[10px]"
                    style={{ color: statusColor(step.status) }}
                  >
                    ●
                  </span>
                  <span
                    className="truncate text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {step.taskId ? `${shortTaskId(step.taskId)} · ` : ""}
                    {step.label}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

interface PointerTrail {
  from: Point | null;
  to: Point;
}

function VirtualPointer({
  pointer,
  trail,
}: {
  pointer: BrowserPointerState;
  trail: PointerTrail;
}) {
  const from = trail.from ?? trail.to;
  return (
    <div
      aria-label="Browser virtual cursor"
      className="pointer-events-none absolute inset-0"
    >
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <line
          x1={from.x * 100}
          y1={from.y * 100}
          x2={trail.to.x * 100}
          y2={trail.to.y * 100}
          stroke="rgba(59,130,246,0.75)"
          strokeWidth="0.45"
          strokeDasharray="1.4 1.2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div
        className="absolute -translate-x-1 -translate-y-1 transition-[left,top] duration-500 ease-out"
        style={{ left: `${pointer.x * 100}%`, top: `${pointer.y * 100}%` }}
      >
        <div className="relative">
          <MousePointer2
            size={24}
            fill="rgba(59,130,246,0.95)"
            strokeWidth={2.4}
            style={{
              color: "#eff6ff",
              filter: "drop-shadow(0 2px 5px rgba(15,23,42,0.45))",
            }}
          />
          <span
            className="absolute left-5 top-4 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              borderColor: "rgba(59,130,246,0.40)",
              background: "rgba(15,23,42,0.86)",
              color: "#dbeafe",
            }}
          >
            {pointer.action}
          </span>
        </div>
      </div>
    </div>
  );
}

function clamp(n: number) {
  return Math.max(0, Math.min(1, n));
}

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

function shortTaskId(taskId: string) {
  return taskId.replace(/^bt_/, "").slice(-6);
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

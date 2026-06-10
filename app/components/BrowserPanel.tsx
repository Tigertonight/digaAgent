"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FlaskConical,
  Globe,
  Hand,
  MessageSquare,
  MousePointer2,
  Radio,
  RefreshCw,
  Send,
  Square,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import type {
  BrowserAnnotation,
  BrowserPointerState,
  BrowserSiteCheck,
  BrowserSnapshot,
  BrowserStepSnapshot,
} from "@/lib/browser/types";
import type { RuntimeIdentity } from "@/lib/runtime/identity";
import { InAppBrowserSurface } from "./InAppBrowserSurface";
import { RuntimeTimeline } from "./RuntimeTimeline";
import { WebviewPocPanel } from "./WebviewPocPanel";
import { userFacingMessage } from "@/lib/user-facing-error";

/** [PoC] 是否在 Electron 桌面环境（webview PoC 仅此环境可用） */
function isElectronEnv(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { miniPi?: unknown }).miniPi
  );
}

function isCurrentAppRootUrl(url: string | null | undefined): boolean {
  if (!url || typeof window === "undefined") return false;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin && parsed.pathname === "/";
  } catch {
    return false;
  }
}

function normalizeAddressInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^about:blank$/i.test(trimmed)) return "about:blank";
  if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

function browserDisplayUrl(url: string | null | undefined): string {
  return isCurrentAppRootUrl(url) ? "about:blank" : (url ?? "about:blank");
}

interface BrowserPanelProps {
  agentId: string | null;
  runtimeIdentity?: RuntimeIdentity;
  snapshot: BrowserSnapshot;
  width: number;
  openRequest?: { id: number; url: string } | null;
  onClose: () => void;
  /**
   * 把一条或多条页面批注作为视觉任务喂给 composer。
   * 阶段 D：批注已结构化并持久化在 runtime，这里只负责把它转成给 agent 的任务文本。
   */
  onAnnotate: (annotations: BrowserAnnotation[]) => void;
}

export function BrowserPanel({
  agentId,
  runtimeIdentity,
  snapshot,
  width,
  openRequest,
  onClose,
  onAnnotate,
}: BrowserPanelProps) {
  // browserId 由 RuntimeIdentity 统一派生，避免历史会话/草稿态误绑到 agent。
  const browserId =
    runtimeIdentity?.browserId ??
    (agentId ? `agent:${agentId}` : "standalone:default");
  const [localSnapshot, setLocalSnapshot] = useState<BrowserSnapshot | null>(
    null
  );
  const effectiveSnapshot = useMemo(() => {
    if (!localSnapshot) return snapshot;
    const localUpdatedAt = localSnapshot.updatedAt ?? 0;
    const propUpdatedAt = snapshot.updatedAt ?? 0;
    return localUpdatedAt >= propUpdatedAt ? localSnapshot : snapshot;
  }, [localSnapshot, snapshot]);
  const initialBrowserUrl = browserDisplayUrl(effectiveSnapshot.url);
  const [addressDraft, setAddressDraft] = useState(initialBrowserUrl);
  const [surfaceUrl, setSurfaceUrl] = useState(initialBrowserUrl);
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [addressDirty, setAddressDirty] = useState(false);
  const pendingOpenUrlRef = useRef<string | null>(null);
  const processedOpenRequestIdRef = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // [PoC] webview 容器实验模式（仅 Electron 环境可见可用）
  const [pocMode, setPocMode] = useState(false);
  const electronEnv = isElectronEnv();
  const [site, setSite] = useState<BrowserSiteCheck | null>(null);
  const [live, setLive] = useState(false);
  // 方案 A：后端默认 headed（真实窗口）。headless 时回退到截图流接管。
  const [headless, setHeadless] = useState(false);
  // 接管模式（仅 headless 兜底用）：显示实时画面并把输入回放过去
  const [takeover, setTakeover] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  // 底部详情抽屉（actions + timeline）默认折叠，把高度留给画面
  const [showDetails, setShowDetails] = useState(false);
  // 批注抽屉默认展开（批注是主动交互，存在时希望被看到）
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [dragRect, setDragRect] = useState<Rect | null>(null);
  const [draftComment, setDraftComment] = useState("");
  const [screenshotReview, setScreenshotReview] = useState(false);
  // 当前高亮的批注（在截图上突出显示对应框）
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(
    null
  );
  const [pointerTrail, setPointerTrail] = useState<PointerTrail | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const previousPointerRef = useRef<BrowserPointerState | null>(null);
  useEffect(() => {
    queueMicrotask(() => {
      setLocalSnapshot(null);
      setScreenshotReview(false);
      setSelectedStepId(null);
    });
  }, [browserId]);
  const steps = useMemo(
    () => effectiveSnapshot.steps ?? [],
    [effectiveSnapshot.steps]
  );

  const selectedStep = useMemo(
    () => steps.find((step) => step.id === selectedStepId) ?? null,
    [selectedStepId, steps]
  );
  // 验收统计：把带 passed 判定的步骤数出来，作为面板头部的 PASS/FAIL 徽章。
  const verifyStats = useMemo(() => {
    let passed = 0;
    let failed = 0;
    for (const step of steps) {
      if (step.passed === true) passed += 1;
      else if (step.passed === false) failed += 1;
    }
    return { passed, failed, total: passed + failed };
  }, [steps]);
  const annotations = effectiveSnapshot.annotations ?? [];
  const openAnnotationCount = annotations.filter(
    (a) => a.status !== "resolved"
  ).length;
  const displayShot =
    selectedStep?.screenshotDataUrl ?? effectiveSnapshot.screenshotDataUrl;
  const displayUrl = selectedStep?.url ?? effectiveSnapshot.url;
  const displayTitle = selectedStep?.title ?? effectiveSnapshot.title;
  const displayPointer =
    selectedStep?.pointer ?? effectiveSnapshot.pointer ?? null;
  useEffect(() => {
    if (effectiveSnapshot.url && !isCurrentAppRootUrl(effectiveSnapshot.url)) {
      if (
        pendingOpenUrlRef.current &&
        pendingOpenUrlRef.current !== "about:blank"
      ) {
        return;
      }
      const snapshotUrl = effectiveSnapshot.url;
      const nextSnapshotUrl = browserDisplayUrl(effectiveSnapshot.url);
      if (nextSnapshotUrl === "about:blank" && surfaceUrl !== "about:blank") {
        return;
      }
      if (!isEditingAddress && (!addressDirty || addressDraft === "about:blank")) {
        queueMicrotask(() => setAddressDraft(snapshotUrl));
      }
    }
  }, [addressDraft, effectiveSnapshot.url, addressDirty, isEditingAddress, surfaceUrl]);

  useEffect(() => {
    if (!selectedStepId) return;
    if (!steps.some((step) => step.id === selectedStepId)) {
      queueMicrotask(() => setSelectedStepId(null));
    }
  }, [selectedStepId, steps]);

  useEffect(() => {
    if (!displayPointer) {
      queueMicrotask(() => setPointerTrail(null));
      previousPointerRef.current = null;
      return;
    }
    const prev = previousPointerRef.current;
    queueMicrotask(() => {
      setPointerTrail({
        from: prev ? { x: prev.x, y: prev.y } : null,
        to: { x: displayPointer.x, y: displayPointer.y },
      });
    });
    previousPointerRef.current = displayPointer;
  }, [displayPointer]);

  useEffect(() => {
    const trimmed = addressDraft.trim();
    if (!trimmed) {
      queueMicrotask(() => setSite(null));
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
  }, [addressDraft]);

  // 读取后端浏览器是否 headless（决定"接管"按钮的行为与文案）
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/browser/${browserId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { headless?: boolean; snapshot?: BrowserSnapshot } | null) => {
        if (!cancelled && d && typeof d.headless === "boolean") {
          setHeadless(d.headless);
        }
        if (!cancelled && !agentId && d?.snapshot) {
          setLocalSnapshot(d.snapshot);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentId, browserId]);

  // 方案 A：把真实浏览器窗口带到前台，供用户直接操作
  const bringBrowserToFront = async () => {
    try {
      await fetch(`/api/browser/${browserId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "bring_to_front" }),
      });
    } catch {
      /* ignore */
    }
  };

  const ensureInAppHost = useCallback(async () => {
    if (!electronEnv) return;
    await fetch(`/api/browser/${browserId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "host_register" }),
    }).catch(() => null);
  }, [browserId, electronEnv]);

  const run = useCallback(async (
    type: "open" | "screenshot" | "close",
    targetUrl?: string
  ) => {
    setBusy(true);
    setError(null);
    const openUrl =
      type === "open" ? normalizeAddressInput(targetUrl ?? addressDraft) : "";
    if (type === "open") {
      if (!openUrl) {
        setError("url required");
        setBusy(false);
        return;
      }
      setScreenshotReview(false);
      setSelectedStepId(null);
      setAddressDraft(openUrl);
      setSurfaceUrl(openUrl);
      setIsEditingAddress(false);
      setAddressDirty(false);
      pendingOpenUrlRef.current = openUrl;
    }
    try {
      await ensureInAppHost();
      const r = await fetch(`/api/browser/${browserId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          type === "open" ? { type, url: openUrl } : { type }
        ),
      });
      const data = (await r.json().catch(() => ({}))) as {
        error?: string;
        snapshot?: BrowserSnapshot;
      };
      if (!r.ok) throw new Error(data.error ?? r.statusText);
      pendingOpenUrlRef.current = null;
      if (data.snapshot) setLocalSnapshot(data.snapshot);
      if (type === "screenshot") setScreenshotReview(true);
    } catch (e) {
      pendingOpenUrlRef.current = null;
      setError(userFacingMessage(e));
    } finally {
      setBusy(false);
    }
  }, [addressDraft, browserId, ensureInAppHost]);

  useEffect(() => {
    if (!openRequest?.url) return;
    if (processedOpenRequestIdRef.current === openRequest.id) return;
    processedOpenRequestIdRef.current = openRequest.id;
    const nextUrl = normalizeAddressInput(openRequest.url);
    queueMicrotask(() => {
      setAddressDraft(nextUrl);
      setSurfaceUrl(nextUrl);
      setIsEditingAddress(false);
      setAddressDirty(false);
    });
    pendingOpenUrlRef.current = nextUrl;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void run("open", nextUrl);
    });
    return () => {
      cancelled = true;
    };
     
  }, [openRequest?.id, openRequest?.url, run]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      void fetch(`/api/browser/${browserId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "refresh" }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { snapshot?: BrowserSnapshot } | null) => {
          if (d?.snapshot) setLocalSnapshot(d.snapshot);
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [agentId, browserId, live]);

  const showScreenshotSurface = Boolean(
    displayShot && (screenshotReview || selectedStep)
  );

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
        `/api/browser/policy?url=${encodeURIComponent(addressDraft)}`
      );
      setSite((await next.json()) as BrowserSiteCheck);
    } catch (e) {
      setError(userFacingMessage(e));
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

  // 提交批注：落库到 runtime（持久化 + 随 SSE 同步），而不是直接拼文本。
  const submitAnnotation = async () => {
    if (!dragRect || !draftComment.trim()) return;
    const rect = dragRect;
    const comment = draftComment.trim();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/browser/${browserId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "annotate",
          rect,
          comment,
          url: displayUrl ?? undefined,
          title: displayTitle ?? undefined,
          screenshotDataUrl: displayShot ?? undefined,
        }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        error?: string;
        snapshot?: BrowserSnapshot;
      };
      if (!r.ok) throw new Error(data.error ?? r.statusText);
      if (data.snapshot) setLocalSnapshot(data.snapshot);
      setDraftComment("");
      setDragRect(null);
      setShowAnnotations(true);
    } catch (e) {
      setError(userFacingMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // 删除一条批注。
  const removeAnnotation = async (annotationId: string) => {
    try {
      const r = await fetch(`/api/browser/${browserId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "annotation_remove", annotationId }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        snapshot?: BrowserSnapshot;
      };
      if (data.snapshot) setLocalSnapshot(data.snapshot);
    } catch {
      /* ignore */
    }
  };

  // 标记批注已处理 / 重新打开。
  const toggleAnnotationResolved = async (
    annotationId: string,
    nextResolved: boolean
  ) => {
    try {
      const r = await fetch(`/api/browser/${browserId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "annotation_resolve",
          annotationId,
          status: nextResolved ? "resolved" : "open",
        }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        snapshot?: BrowserSnapshot;
      };
      if (data.snapshot) setLocalSnapshot(data.snapshot);
    } catch {
      /* ignore */
    }
  };

  // 把批注作为视觉任务喂给 agent（插入 composer）。
  // toSend：传单条则只喂该条，否则喂全部未处理批注。
  const sendAnnotations = (toSend?: BrowserAnnotation) => {
    const list = toSend
      ? [toSend]
      : annotations.filter((a) => a.status !== "resolved");
    if (list.length === 0) return;
    onAnnotate(list);
  };

  // [PoC] webview 容器实验模式：整块替换为 WebviewPocPanel，便于独立验证
  if (pocMode) {
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
          className="h-10 shrink-0 border-b px-2.5 flex items-center gap-2"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <FlaskConical size={14} style={{ color: "var(--accent)" }} />
          <span className="text-xs font-medium">Webview 容器实验 (PoC)</span>
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            CDP 控制原生 webview
          </span>
          <button
            type="button"
            onClick={() => setPocMode(false)}
            className="ml-auto h-7 rounded-full border px-2.5 text-[11px]"
            style={{ borderColor: "var(--border)", color: "var(--text)" }}
            title="返回截图流面板"
          >
            返回
          </button>
          <IconBtn onClick={onClose} title="关闭面板">
            <X size={13} />
          </IconBtn>
        </div>
        <div className="flex-1 min-h-0">
          <WebviewPocPanel />
        </div>
      </div>
    );
  }

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
        className="h-10 shrink-0 border-b px-2.5 flex items-center gap-2"
        style={{ borderColor: "var(--border-soft)" }}
      >
        {/* 地址栏：胶囊样式，占主导 */}
        <form
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border px-3"
          style={{ background: "var(--bg)", borderColor: "var(--border)" }}
          onSubmit={(e) => {
            e.preventDefault();
            void run("open");
          }}
        >
          <Globe size={13} className="shrink-0" style={{ color: "var(--text-muted)" }} />
          <input
            aria-label="Browser URL"
            value={addressDraft}
            onFocus={() => setIsEditingAddress(true)}
            onBlur={() => setIsEditingAddress(false)}
            onChange={(e) => {
              setAddressDraft(e.target.value);
              setAddressDirty(true);
            }}
            disabled={busy}
            className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none"
            style={{ color: "var(--text)" }}
            placeholder="输入网址并回车…"
          />
          <button
            type="button"
            disabled={!displayUrl}
            onClick={() => {
              if (!displayUrl) return;
              void navigator.clipboard?.writeText(displayUrl).catch(() => {});
            }}
            className="shrink-0 disabled:opacity-40"
            style={{ color: "var(--text-muted)" }}
            title="复制当前网址"
          >
            <Copy size={12} />
          </button>
        </form>

        {/* 接管：Electron in-app 模式下页面就在面板里；非 Electron 才回退真实窗口/截图流。 */}
        <button
          type="button"
          onClick={() => {
            if (electronEnv) {
              setTakeover((v) => !v);
              return;
            }
            if (headless) {
              setTakeover((v) => !v);
            } else {
              void bringBrowserToFront();
            }
          }}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium disabled:opacity-50"
          style={{
            borderColor:
              !headless || takeover ? "rgba(59,130,246,0.7)" : "var(--border)",
            color: !headless || takeover ? "#fff" : "var(--text)",
            background: !headless || takeover ? "var(--accent)" : "transparent",
          }}
          title={
            electronEnv
              ? takeover
                ? "退出接管"
                : "接管 in-app 浏览器页面"
              : headless
              ? takeover
                ? "退出接管（停止实时画面）"
                : "接管：显示实时画面并可直接操作（无头模式）"
              : "接管：把真实浏览器窗口带到前台，直接用鼠标操作（过验证码等）"
          }
        >
          <Hand size={13} />
          {electronEnv
            ? takeover
              ? "接管中"
              : "接管"
            : headless
              ? takeover
                ? "接管中"
                : "接管"
              : "接管窗口"}
        </button>

        {/* [PoC] webview 容器实验入口：仅 Electron 桌面环境显示 */}
        {electronEnv && (
          <button
            type="button"
            onClick={() => setPocMode(true)}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium"
            style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
            title="打开 webview/CDP 诊断面板"
          >
            <FlaskConical size={13} />
            诊断
          </button>
        )}

        {/* 次要操作：刷新 / 截图 / 近实时 / 关闭会话 / 关闭面板 */}
        <div className="flex shrink-0 items-center gap-0.5" style={{ color: "var(--text-muted)" }}>
          <IconBtn
            disabled={busy}
            onClick={() => void run("open")}
            title="重新打开当前地址"
          >
            <RefreshCw size={13} />
          </IconBtn>
          <IconBtn
            disabled={busy}
            onClick={() => void run("screenshot")}
            title="截图"
          >
            <Camera size={13} />
          </IconBtn>
          <IconBtn
            active={live}
            activeColor="#86efac"
            onClick={() => setLive((v) => !v)}
            title={live ? "停止近实时刷新" : "开启近实时刷新"}
          >
            <Radio size={13} />
          </IconBtn>
          <IconBtn
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void fetch(`/api/browser/${browserId}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ type: "close_all" }),
              })
                .catch(() => {})
                .finally(() => {
                  setBusy(false);
                  setTakeover(false);
                });
            }}
            title="关闭所有浏览器窗口（清理残留）"
          >
            <Square size={12} />
          </IconBtn>
          <IconBtn onClick={onClose} title="关闭面板">
            <X size={13} />
          </IconBtn>
        </div>
      </div>

      <div
        className="shrink-0 border-b px-2.5 py-1.5 flex items-center gap-2 text-[11px]"
        style={{ borderColor: "var(--border-soft)" }}
      >
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: statusColor(effectiveSnapshot.status) }}
          title={effectiveSnapshot.status}
        />
        <span
          className="shrink-0 rounded border px-1.5 py-0.5 uppercase"
          style={{
            borderColor: siteBorder(site?.decision),
            color: siteColor(site?.decision),
            background: siteBg(site?.decision),
          }}
          title={site?.origin ?? addressDraft}
        >
          {site?.decision ?? "···"}
        </span>
        <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text-muted)" }}>
          {displayTitle || site?.origin || addressDraft}
        </span>
        {selectedStep && (
          <span
            className="shrink-0 rounded border px-1 py-0.5"
            style={{ borderColor: "var(--border)" }}
          >
            replay
          </span>
        )}
        {effectiveSnapshot.task && (
          <span
            className="shrink-0 rounded border px-1 py-0.5"
            style={{
              borderColor: "var(--border)",
              color: statusColor(effectiveSnapshot.task.status),
            }}
            title={effectiveSnapshot.task.id}
          >
            {shortTaskId(effectiveSnapshot.task.id)} · {effectiveSnapshot.task.status}
          </span>
        )}
        {site && site.decision !== "local" && (
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={busy || site.decision === "allowed"}
              onClick={() => void updateSitePolicy("allow")}
              className="rounded border px-1.5 py-0.5 disabled:opacity-40"
              style={{ borderColor: "var(--border)" }}
              title="Allow this site"
            >
              Allow
            </button>
            <button
              type="button"
              disabled={busy || site.decision === "blocked"}
              onClick={() => void updateSitePolicy("block")}
              className="rounded border px-1.5 py-0.5 disabled:opacity-40"
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
                className="rounded border px-1.5 py-0.5 disabled:opacity-40"
                style={{ borderColor: "var(--border)" }}
                title="Reset this site's policy"
              >
                Reset
              </button>
            )}
          </span>
        )}
      </div>

      {(error || effectiveSnapshot.error) && (
        <div
          className="mx-2 mt-2 rounded border px-2 py-1.5 text-xs"
          style={{
            borderColor: "rgba(239,68,68,0.45)",
            color: "#fca5a5",
            background: "rgba(239,68,68,0.10)",
          }}
        >
          {error ?? effectiveSnapshot.error}
        </div>
      )}

      <div
        className="flex-1 min-h-0 overflow-hidden"
        style={{ background: "var(--bg)" }}
      >
        {showScreenshotSurface ? (
          <div
            className="relative h-full w-full overflow-hidden"
            style={{ background: "#0b0b0c" }}
            onMouseDown={startAnnotation}
            onMouseMove={moveAnnotation}
            onMouseUp={finishAnnotation}
            onMouseLeave={finishAnnotation}
            title="拖拽框选可对画面区域做标注"
          >
            <Image
              src={displayShot!}
              alt="Browser screenshot"
              width={1280}
              height={720}
              unoptimized
              className="h-full w-full object-contain select-none"
              draggable={false}
            />
            {pointerTrail && displayPointer && (
              <VirtualPointer
                pointer={displayPointer!}
                trail={pointerTrail!}
              />
            )}
            {dragRect && dragRect!.w > 0.01 && dragRect!.h > 0.01 && (
              <div
                className="absolute border-2"
                style={{
                  left: `${dragRect!.x * 100}%`,
                  top: `${dragRect!.y * 100}%`,
                  width: `${dragRect!.w * 100}%`,
                  height: `${dragRect!.h * 100}%`,
                  borderColor: "var(--accent)",
                  background: "rgba(59,130,246,0.12)",
                }}
              />
            )}
            {/* 已落库批注的可视化叠加：框 + 序号（Codex 风格） */}
            {annotations.map((a, i) => {
              const resolved = a.status === "resolved";
              const active = activeAnnotationId === a.id;
              const stroke = resolved
                ? "rgba(34,197,94,0.85)"
                : "rgba(245,158,11,0.95)";
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveAnnotationId(a.id);
                  }}
                  className="absolute text-left"
                  style={{
                    left: `${a.rect.x * 100}%`,
                    top: `${a.rect.y * 100}%`,
                    width: `${a.rect.w * 100}%`,
                    height: `${a.rect.h * 100}%`,
                    border: `2px solid ${stroke}`,
                    background: active
                      ? resolved
                        ? "rgba(34,197,94,0.22)"
                        : "rgba(245,158,11,0.24)"
                      : resolved
                        ? "rgba(34,197,94,0.10)"
                        : "rgba(245,158,11,0.12)",
                    boxShadow: active ? `0 0 0 2px ${stroke}` : "none",
                  }}
                  title={a.comment}
                >
                  <span
                    className="absolute -left-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold shadow"
                    style={{
                      background: resolved ? "#22c55e" : "#f59e0b",
                      color: "#111827",
                    }}
                  >
                    {i + 1}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <InAppBrowserSurface
            browserId={browserId}
            url={browserDisplayUrl(surfaceUrl)}
            onSnapshot={(next) => {
              setLocalSnapshot(next);
            }}
            onError={setError}
          />
        )}
      </div>

      {dragRect && dragRect.w > 0.01 && dragRect.h > 0.01 && (
        <div
          className="shrink-0 border-t p-2 flex items-center gap-2"
          style={{ borderColor: "var(--border-soft)" }}
        >
          <MessageSquare size={13} className="shrink-0" style={{ color: "var(--accent)" }} />
          <input
            aria-label="Browser annotation comment"
            value={draftComment}
            onChange={(e) => setDraftComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submitAnnotation();
              } else if (e.key === "Escape") {
                setDragRect(null);
                setDraftComment("");
              }
            }}
            autoFocus
            disabled={busy}
            className="h-7 min-w-0 flex-1 rounded border px-2 text-xs outline-none disabled:opacity-50"
            style={{
              background: "var(--bg)",
              borderColor: "var(--border)",
              color: "var(--text)",
            }}
            placeholder="对框选区域留言，回车添加批注…"
          />
          <button
            type="button"
            onClick={() => void submitAnnotation()}
            disabled={busy || !draftComment.trim()}
            className="inline-flex h-7 items-center gap-1 rounded border px-2 text-xs font-medium disabled:opacity-40"
            style={{
              borderColor: "rgba(59,130,246,0.6)",
              background: "var(--accent)",
              color: "#fff",
            }}
          >
            添加
          </button>
          <button
            type="button"
            onClick={() => {
              setDragRect(null);
              setDraftComment("");
            }}
            className="h-7 rounded border px-2 text-xs"
            style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
          >
            取消
          </button>
        </div>
      )}

      {/* 阶段 D：页面批注抽屉。框选+留言落库后在此累积，可删除/标记完成/喂给 agent */}
      {annotations.length > 0 && (
        <div className="shrink-0 border-t" style={{ borderColor: "var(--border-soft)" }}>
          <div
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            <button
              type="button"
              onClick={() => setShowAnnotations((v) => !v)}
              className="flex flex-1 items-center gap-2 hover:opacity-80"
            >
              {showAnnotations ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
              <MessageSquare size={13} style={{ color: "var(--accent)" }} />
              <span className="font-medium">页面批注</span>
              <span style={{ color: "var(--fg-faint)" }}>
                {annotations.length} 条
                {openAnnotationCount > 0 ? ` · ${openAnnotationCount} 待处理` : ""}
              </span>
            </button>
            {openAnnotationCount > 0 && (
              <button
                type="button"
                onClick={() => sendAnnotations()}
                className="inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  borderColor: "rgba(59,130,246,0.6)",
                  background: "var(--accent)",
                  color: "#fff",
                }}
                title="把所有未处理批注作为任务喂给 agent"
              >
                <Send size={10} /> 全部喂给 agent
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                void fetch(`/api/browser/${browserId}`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ type: "annotation_clear" }),
                })
                  .then((r) => (r.ok ? r.json() : null))
                  .then((d: { snapshot?: BrowserSnapshot } | null) => {
                    if (d?.snapshot) setLocalSnapshot(d.snapshot);
                  })
                  .catch(() => {});
              }}
              className="shrink-0 rounded border px-1.5 py-0.5 text-[10px]"
              style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
              title="清空全部批注"
            >
              清空
            </button>
          </div>

          {showAnnotations && (
            <div
              className="max-h-44 overflow-auto border-t px-2.5 py-2"
              style={{ borderColor: "var(--border-soft)" }}
            >
              {annotations.map((a, i) => {
                const resolved = a.status === "resolved";
                return (
                  <div
                    key={a.id}
                    className="mb-1 rounded border px-2 py-1.5"
                    style={{
                      borderColor:
                        activeAnnotationId === a.id
                          ? "var(--accent)"
                          : "var(--border-soft)",
                      background: "var(--bg-panel-2)",
                      opacity: resolved ? 0.6 : 1,
                    }}
                    onMouseEnter={() => setActiveAnnotationId(a.id)}
                    onMouseLeave={() => setActiveAnnotationId(null)}
                  >
                    <div className="flex items-start gap-1.5">
                      <span
                        className="mt-0.5 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[9px] font-bold"
                        style={{
                          background: resolved
                            ? "rgba(34,197,94,0.85)"
                            : "rgba(245,158,11,0.95)",
                          color: "#0b0b0c",
                        }}
                      >
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div
                          className="text-[11px]"
                          style={{
                            color: "var(--text)",
                            textDecoration: resolved ? "line-through" : "none",
                          }}
                        >
                          {a.comment}
                        </div>
                        {a.url && (
                          <div
                            className="truncate text-[10px]"
                            style={{ color: "var(--fg-faint)" }}
                            title={a.url}
                          >
                            {a.url}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => sendAnnotations(a)}
                          className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-[color:var(--bg-hover)]"
                          style={{ color: "var(--accent)" }}
                          title="把这条批注喂给 agent"
                        >
                          <Send size={11} />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void toggleAnnotationResolved(a.id, !resolved)
                          }
                          className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-[color:var(--bg-hover)]"
                          style={{
                            color: resolved ? "#86efac" : "var(--text-muted)",
                          }}
                          title={resolved ? "重新打开" : "标记已处理"}
                        >
                          <Check size={11} />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeAnnotation(a.id)}
                          className="inline-flex h-5 w-5 items-center justify-center rounded hover:bg-[color:var(--bg-hover)]"
                          style={{ color: "var(--text-muted)" }}
                          title="删除批注"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 底部验收证据面板：步骤时间线 + 选中步骤详情，默认折叠把高度留给画面 */}
      <div className="shrink-0 border-t" style={{ borderColor: "var(--border-soft)" }}>
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11px] hover:bg-[color:var(--bg-hover)]"
          style={{ color: "var(--text-muted)" }}
        >
          {showDetails ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          <span className="font-medium">验收证据</span>
          <span style={{ color: "var(--fg-faint)" }}>
            {steps.length > 0 ? `${steps.length} 步` : `${effectiveSnapshot.logs.length} 条`}
          </span>
          {/* 验收通过/失败统计徽章 */}
          {verifyStats.total > 0 && (
            <span className="flex shrink-0 items-center gap-1">
              {verifyStats.passed > 0 && (
                <span
                  className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium"
                  style={{ background: "rgba(34,197,94,0.14)", color: "#86efac" }}
                >
                  <CheckCircle2 size={10} /> {verifyStats.passed}
                </span>
              )}
              {verifyStats.failed > 0 && (
                <span
                  className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium"
                  style={{ background: "rgba(239,68,68,0.14)", color: "#fca5a5" }}
                >
                  <XCircle size={10} /> {verifyStats.failed}
                </span>
              )}
            </span>
          )}
          {/* 折叠态也显示最近一步摘要 */}
          {!showDetails && steps[0] && (
            <span className="ml-auto flex min-w-0 items-center gap-1.5">
              <span
                className="shrink-0"
                style={{ color: statusColor(steps[0].status) }}
              >
                ●
              </span>
              <span className="truncate" style={{ maxWidth: 170 }}>
                {actionLabel(steps[0].action)} · {steps[0].label}
              </span>
            </span>
          )}
        </button>

        {showDetails && (
          <div
            className="max-h-72 overflow-auto border-t"
            style={{ borderColor: "var(--border-soft)" }}
          >
            <RuntimeTimeline
              agentId={agentId}
              browserId={browserId}
              enabled={showDetails}
            />
            {steps.length === 0 ? (
              <div className="px-2.5 py-3 text-xs" style={{ color: "var(--fg-faint)" }}>
                暂无浏览器操作。让 agent 使用浏览器，或在地址栏手动打开网页，每一步都会作为验收证据记录在这里。
              </div>
            ) : (
              <>
                {/* 选中步骤详情卡：截图 + url/title + 验收结论/证据正文 */}
                {selectedStep && (
                  <div
                    className="border-b px-2.5 py-2"
                    style={{ borderColor: "var(--border-soft)", background: "var(--bg-panel-2)" }}
                  >
                    <div className="mb-1.5 flex items-center gap-2 text-[11px]">
                      <span
                        className="font-medium"
                        style={{ color: "var(--text)" }}
                      >
                        {actionLabel(selectedStep.action)}
                      </span>
                      <VerdictBadge step={selectedStep} />
                      <span style={{ color: "var(--fg-faint)" }}>
                        {formatStepTime(selectedStep.createdAt)}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedStepId(null);
                          setScreenshotReview(false);
                        }}
                        className="ml-auto rounded border px-1.5 py-0.5 text-[10px]"
                        style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
                        title="取消选中，回到实时画面"
                      >
                        实时
                      </button>
                    </div>
                    {selectedStep.url && (
                      <div className="mb-1 flex items-center gap-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
                        <Globe size={10} className="shrink-0" />
                        <span className="truncate" title={selectedStep.url}>
                          {selectedStep.url}
                        </span>
                      </div>
                    )}
                    {selectedStep.error && (
                      <div className="mb-1 text-[11px]" style={{ color: "#fca5a5" }}>
                        {selectedStep.error}
                      </div>
                    )}
                    {selectedStep.extractedText && (
                      <div
                        className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded border px-1.5 py-1 text-[10px] leading-relaxed"
                        style={{
                          borderColor: "var(--border-soft)",
                          color: "var(--text-muted)",
                          background: "var(--bg)",
                        }}
                      >
                        {selectedStep.extractedText.slice(0, 600)}
                        {selectedStep.extractedText.length > 600 ? "…" : ""}
                      </div>
                    )}
                  </div>
                )}

                {/* 步骤时间线：每步 action/状态/PASS-FAIL/时间/url，点击切换选中 */}
                <div className="px-2.5 py-2">
                  {steps.map((step: BrowserStepSnapshot) => {
                    const isSelected = selectedStepId === step.id;
                    return (
                      <button
                        key={step.id}
                        type="button"
                        onClick={() =>
                          setSelectedStepId((cur) =>
                            cur === step.id ? null : step.id
                          )
                        }
                        className="mb-1 flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left"
                        style={{
                          borderColor: isSelected
                            ? "var(--accent)"
                            : "var(--border-soft)",
                          background: isSelected
                            ? "rgba(59,130,246,0.08)"
                            : "var(--bg-panel-2)",
                        }}
                        title={step.label}
                      >
                        {/* 缩略图 */}
                        <div
                          className="h-9 w-12 shrink-0 overflow-hidden rounded border"
                          style={{ borderColor: "var(--border-soft)", background: "#fff" }}
                        >
                          {step.screenshotDataUrl && (
                            <Image
                              src={step.screenshotDataUrl}
                              alt=""
                              width={48}
                              height={36}
                              unoptimized
                              className="h-full w-full object-cover"
                            />
                          )}
                        </div>
                        {/* 文字证据 */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-[11px]">
                            <span
                              className="shrink-0"
                              style={{ color: statusColor(step.status) }}
                            >
                              ●
                            </span>
                            <span className="font-medium" style={{ color: "var(--text)" }}>
                              {actionLabel(step.action)}
                            </span>
                            <VerdictBadge step={step} />
                            <span className="ml-auto shrink-0 text-[10px]" style={{ color: "var(--fg-faint)" }}>
                              {formatStepTime(step.createdAt)}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-[10px]" style={{ color: "var(--text-muted)" }}>
                            {step.taskId ? `${shortTaskId(step.taskId)} · ` : ""}
                            {step.label}
                          </div>
                          {step.url && (
                            <div className="truncate text-[10px]" style={{ color: "var(--fg-faint)" }}>
                              {step.url}
                            </div>
                          )}
                          {step.error && (
                            <div className="mt-0.5 truncate text-[10px]" style={{ color: "#fca5a5" }}>
                              {step.error}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 工具栏统一的弱化图标按钮：方形、悬停高亮、可选 active 态 */
function IconBtn({
  children,
  onClick,
  disabled,
  title,
  active,
  activeColor,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  active?: boolean;
  activeColor?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-[color:var(--bg-hover)] disabled:opacity-40"
      style={{ color: active ? activeColor ?? "var(--accent)" : "inherit" }}
    >
      {children}
    </button>
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

function shortTaskId(taskId: string) {
  return taskId.replace(/^bt_/, "").slice(-6);
}

/** 把 runtime 的 action key 映射成简短中文标签（验收证据时间线用）。 */
function actionLabel(action: string) {
  const map: Record<string, string> = {
    open: "打开",
    screenshot: "截图",
    click: "点击",
    click_text: "点击文本",
    fill: "填写",
    type: "输入",
    search: "搜索",
    wait: "等待",
    wait_for: "等待条件",
    extract: "提取",
    verify: "验收",
    close: "关闭",
    result_select: "选择结果",
    clipboard_write: "复制",
  };
  return map[action] ?? action;
}

/** 步骤时间戳格式化为 HH:MM:SS（验收证据需要可追溯的时间）。 */
function formatStepTime(ts: number) {
  try {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}

/** 验收结论徽章：仅对带 passed 判定的步骤显示 PASS / FAIL。 */
function VerdictBadge({ step }: { step: BrowserStepSnapshot }) {
  if (step.passed === undefined) return null;
  return step.passed ? (
    <span
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium"
      style={{ background: "rgba(34,197,94,0.16)", color: "#86efac" }}
    >
      <CheckCircle2 size={10} /> PASS
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium"
      style={{ background: "rgba(239,68,68,0.16)", color: "#fca5a5" }}
    >
      <XCircle size={10} /> FAIL
    </span>
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

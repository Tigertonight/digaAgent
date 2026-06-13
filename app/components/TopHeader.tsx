"use client";

import { useEffect, useState } from "react";
import {
  FileText,
  GitBranch,
  Globe2,
  Loader2,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Smartphone,
  Wrench,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import { BrandLogo } from "./BrandLogo";
import { Button, TokenIconButton } from "./DesignPrimitives";
import { IconButton, iconSizeMap } from "./IconButton";
import { HudMeter } from "./HudMeter";
import { BudgetIndicator } from "./BudgetIndicator";
import type { SseStatus, StatsSnapshot } from "@/lib/session-runner";
import type { ElectronApi } from "@/lib/electron-bridge";
import type {
  BudgetSpent,
  BudgetStatus,
  SessionBudget,
} from "@/lib/budget/types";
import { userFacingMessage } from "@/lib/user-facing-error";

interface TopHeaderProps {
  sidebarOpen: boolean;
  theme: "light" | "dark";
  agentId: string | null;
  stats: StatsSnapshot | null;
  sseStatus: SseStatus;
  electronApi: ElectronApi | null;
  currentSessionFile: string | null;
  hasSessionContext: boolean;
  showTools: boolean;
  showWorkbench: boolean;
  updateStatus?: "idle" | "checking" | "available" | "not-available" | "skipped" | "error";
  updateLatestVersion?: string | null;
  openCommandMenuRequest?: number;
  /** RFC-2 Phase A：Budget 当前生效配置 + 实时状态（来自 useBudget） */
  budget: SessionBudget;
  budgetSpent: BudgetSpent;
  budgetStatus: BudgetStatus;
  budgetHasOverride: boolean;
  hasAuthedProviders: boolean;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
  onOpenBranches: () => void;
  onOpenSystemPrompt: () => void;
  onOpenWorkflows: () => void;
  onRevealInFinder: () => void;
  onOpenProviderSetup: () => void;
  onOpenAuth: () => void;
  onOpenSettings: (section?: "mobile") => void;
  onReconnectSession: () => void;
  onToggleTools: () => void;
  onToggleWorkbench: () => void;
  onCheckForUpdates?: () => void;
  onDownloadUpdate?: () => void;
  onSkipUpdateVersion?: () => void;
}

interface RemoteStatusResponse {
  enabled: boolean;
  mode: "off" | "vpn" | "lan";
  hostName: string;
  port: number;
  candidates?: Array<{ url: string } | string>;
  publicTunnel?: {
    running: boolean;
    url?: string;
    error?: string;
  };
}

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

function candidateUrl(candidate: { url: string } | string): string {
  return typeof candidate === "string" ? candidate : candidate.url;
}

function isCloudflaredMissingError(message: string | null): boolean {
  return Boolean(
    message &&
      /cloudflared/i.test(message) &&
      /(未安装|install|not found|ENOENT)/i.test(message)
  );
}

function MobilePairDialog({
  electronApi,
  onClose,
  onOpenSettings,
}: {
  electronApi: ElectronApi | null;
  onClose: () => void;
  onOpenSettings: (section?: "mobile") => void;
}) {
  const [status, setStatus] = useState<RemoteStatusResponse | null>(null);
  const [pair, setPair] = useState<RemotePairStartResponse | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [pairBaseOptions, setPairBaseOptions] = useState<string[]>([]);
  const [selectedPairBase, setSelectedPairBase] = useState("");
  const [busy, setBusy] = useState(false);
  const [installingCloudflared, setInstallingCloudflared] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const localFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (electronApi) {
      try {
        const secret = await electronApi.getLocalSecret();
        if (secret) headers.set("x-diga-agent-local-secret", secret);
      } catch {
        // In browser/dev mode the preload bridge can exist without the
        // getLocalSecret IPC handler. Localhost remains allowed by the API.
      }
    }
    return fetch(input, { ...init, headers });
  };

  const loadStatus = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await localFetch("/api/remote/status");
      const data = (await res.json()) as RemoteStatusResponse & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? res.statusText);
      setStatus(data);
      return data;
    } catch (e) {
      setError(userFacingMessage(e, { context: "remote" }));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const makeQr = async (url: string) =>
    QRCode.toDataURL(url, {
      margin: 1,
      width: 360,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    });

  const usablePairBases = (candidates: string[]) =>
    Array.from(new Set(candidates)).filter(
      (url) => !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)
    );

  const pairBaseKind = (base: string): "public" | "lan" | "other" => {
    if (base.includes("trycloudflare.com")) return "public";
    if (/^https?:\/\/10\./.test(base)) return "lan";
    if (/^https?:\/\/192\.168\./.test(base)) return "lan";
    if (/^https?:\/\/172\.(1[6-9]|2\d|3[0-1])\./.test(base)) return "lan";
    return "other";
  };

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
    const pairUrl = `${base}/mobile/pair/${encodeURIComponent(data.code)}`;
    setPair(data);
    setPairBaseOptions(bases);
    setSelectedPairBase(base);
    setPairUrl(pairUrl);
    setQr(await makeQr(pairUrl));
  };

  const pairBaseLabel = (base: string, bases = pairBaseOptions) => {
    const kind = pairBaseKind(base);
    if (kind === "public") return "公网";
    if (kind === "lan") {
      const firstLan = bases.find((item) => pairBaseKind(item) === "lan");
      return firstLan === base ? "同一 Wi-Fi" : "其他网络";
    }
    return "其他网络";
  };

  const startPairing = async (knownStatus?: RemoteStatusResponse | null) => {
    setBusy(true);
    setError(null);
    try {
      const res = await localFetch("/api/remote/pair/start", { method: "POST" });
      const data = (await res.json()) as RemotePairStartResponse & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? res.statusText);
      const bases = orderPairBases(usablePairBases([
        ...data.payload.candidates,
        ...(knownStatus?.publicTunnel?.url ? [knownStatus.publicTunnel.url] : []),
        ...(knownStatus?.enabled ? [window.location.origin] : []),
      ]));
      const first = chooseDefaultPairBase(bases);
      if (!first) {
        throw new Error("远程访问尚未开启，请先管理连接后再生成二维码。");
      }
      await applyPairTarget(data, first, bases);
    } catch (e) {
      setError(userFacingMessage(e, { context: "pairing" }));
    } finally {
      setBusy(false);
    }
  };

  const startPublicTunnelAndPair = async () => {
    setBusy(true);
    setError(null);
    try {
      const devPort =
        typeof window !== "undefined" ? Number(window.location.port) : NaN;
      const port = Number.isInteger(devPort) && devPort > 0 ? devPort : status?.port;
      const tunnelRes = await localFetch("/api/remote/tunnel/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port }),
      });
      const tunnel = (await tunnelRes.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!tunnelRes.ok || !tunnel.url) {
        throw new Error(
          tunnel.error ??
            "公网启动失败。请先安装 cloudflared：brew install cloudflared"
        );
      }
      const statusRes = await localFetch("/api/remote/status");
      const nextStatus = (await statusRes.json()) as RemoteStatusResponse;
      setStatus(nextStatus);
      const pairRes = await localFetch("/api/remote/pair/start", { method: "POST" });
      const pairData = (await pairRes.json()) as RemotePairStartResponse & {
        error?: string;
      };
      if (!pairRes.ok || pairData.error) {
        throw new Error(pairData.error ?? pairRes.statusText);
      }
      const bases = orderPairBases(usablePairBases([tunnel.url, ...pairData.payload.candidates]));
      const first = bases[0] ?? tunnel.url;
      await applyPairTarget(pairData, first, bases);
    } catch (e) {
      setError(userFacingMessage(e, { context: "pairing" }));
    } finally {
      setBusy(false);
    }
  };

  const installCloudflaredAndRetry = async () => {
    if (!electronApi?.dependencies?.installCloudflared) {
      setError("当前环境无法自动安装 cloudflared，请在终端运行：brew install cloudflared");
      return;
    }
    setInstallingCloudflared(true);
    setError(null);
    try {
      const result = await electronApi.dependencies.installCloudflared();
      if (!result.ok || !result.installed) {
        throw new Error(
          result.error ??
            "cloudflared 自动安装失败，请在终端运行：brew install cloudflared"
        );
      }
      await startPublicTunnelAndPair();
    } catch (e) {
      setError(userFacingMessage(e, { context: "remote" }));
    } finally {
      setInstallingCloudflared(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      void (async () => {
        const nextStatus = await loadStatus();
        if (cancelled || !nextStatus) return;
        if (nextStatus.enabled || nextStatus.publicTunnel?.running) {
          await startPairing(nextStatus);
        }
      })();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- modal load once on open
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const candidates = status?.candidates?.map(candidateUrl) ?? [];
  const enabled = Boolean(status?.enabled);
  const tunnelRunning = Boolean(status?.publicTunnel?.running && status.publicTunnel.url);
  const canPair = enabled || tunnelRunning;
  const modeLabel =
    status?.mode === "lan"
      ? "LAN"
      : status?.mode === "vpn"
        ? "VPN"
        : tunnelRunning
          ? "公网"
          : "未开启";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--color-overlay)] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="relative flex max-h-[min(660px,88vh)] w-full max-w-[500px] flex-col overflow-hidden rounded-token-lg border border-[color:var(--border)] bg-[color:var(--bg-panel)] text-[color:var(--text)] shadow-modal">
        <header className="absolute right-3 top-3 z-10 flex items-center gap-2">
          <TokenIconButton
            type="button"
            onClick={() => void (canPair ? startPairing(status) : loadStatus())}
            disabled={busy}
            size="md"
            variant="outline"
            icon={busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            title="刷新二维码"
          />
          <TokenIconButton
            type="button"
            onClick={onClose}
            size="md"
            variant="outline"
            icon={<X size={15} />}
            title="关闭"
          />
        </header>

        <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-6 pt-14 text-center">
          <div className="text-token-title font-semibold tracking-tight">Diga Agent 移动版</div>
          <p className="mt-2 max-w-sm text-token-body text-[color:var(--text-muted)]">
            扫描二维码以设置新手机或管理现有连接
          </p>

          {error ? (
            <div className="mt-4 w-full max-w-[420px] rounded-token border border-[color:var(--color-danger)] bg-[color:var(--color-danger-bg)] px-3 py-2 text-left text-token-sm text-[color:var(--color-danger)]">
              <div>{error}</div>
              {isCloudflaredMissingError(error) ? (
                <Button
                  type="button"
                  disabled={busy || installingCloudflared}
                  onClick={() => void installCloudflaredAndRetry()}
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  leading={
                    installingCloudflared ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Wrench size={15} />
                    )
                  }
                >
                  安装 cloudflared 并重试
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="mt-6 w-full max-w-[360px] rounded-token-lg border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-5 py-5">
            {pair && qr ? (
              <div className="mx-auto max-w-[250px]">
                <div className="relative rounded-sheet border border-[color:var(--border-soft)] bg-[color:var(--color-bg)] p-4 shadow-popover">
                  <span className="absolute left-3 top-3 h-6 w-6 rounded-tl-[var(--radius-lg)] border-l-2 border-t-2 border-[color:var(--accent)]" />
                  <span className="absolute right-3 top-3 h-6 w-6 rounded-tr-[var(--radius-lg)] border-r-2 border-t-2 border-[color:var(--accent)]" />
                  <span className="absolute bottom-3 left-3 h-6 w-6 rounded-bl-[var(--radius-lg)] border-b-2 border-l-2 border-[color:var(--accent)]" />
                  <span className="absolute bottom-3 right-3 h-6 w-6 rounded-br-[var(--radius-lg)] border-b-2 border-r-2 border-[color:var(--accent)]" />
                  {/* eslint-disable-next-line @next/next/no-img-element -- QR code is generated as a local data URL. */}
                  <img src={qr} alt="手机扫码配对二维码" className="h-auto w-full" />
                  <span className="absolute left-1/2 top-1/2 inline-flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-token-lg border border-[color:var(--color-bg)] bg-[color:var(--accent)] shadow-popover">
                    <BrandLogo size={28} />
                  </span>
                </div>
                <div className="mt-5 flex items-center justify-center gap-6 text-sm font-medium">
                  <span>iPhone</span>
                  <span className="text-[color:var(--text-muted)]">安卓</span>
                </div>
                {pairBaseOptions.length > 1 ? (
                  <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                    {pairBaseOptions.map((base) => {
                      const selected = base === selectedPairBase;
                      return (
                        <button
                          key={base}
                          type="button"
                          onClick={() => void applyPairTarget(pair, base, pairBaseOptions)}
                          className={`rounded-full border px-2.5 py-1 text-token-xs transition-colors ${
                            selected
                              ? "border-[color:var(--accent)] bg-[color:var(--bg-selected)] text-[color:var(--accent)]"
                              : "border-[color:var(--border-soft)] text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)]"
                          }`}
                          title={base}
                        >
                          {pairBaseLabel(base, pairBaseOptions)}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : canPair ? (
              <div className="flex min-h-[272px] flex-col items-center justify-center gap-4 text-[color:var(--text-muted)]">
                <Loader2 size={24} className="animate-spin" />
                <span className="text-sm">正在生成二维码…</span>
              </div>
            ) : (
              <div className="flex min-h-[272px] flex-col items-center justify-center gap-3">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-token-lg border border-[color:var(--border-soft)] bg-[color:var(--bg-panel)] text-[color:var(--text-muted)]">
                  <Smartphone size={26} />
                </div>
                <div className="text-base font-medium">远程访问未开启</div>
                <p className="max-w-xs text-xs leading-5 text-[color:var(--text-muted)]">
                  开启 VPN、同一 Wi-Fi 或公网连接后，小手机入口会直接展示扫码二维码。
                </p>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void startPublicTunnelAndPair()}
                  size="sm"
                  variant="outline"
                  leading={busy ? <Loader2 size={15} className="animate-spin" /> : <Globe2 size={15} />}
                >
                  开启公网
                </Button>
              </div>
            )}
          </div>

          <div className="mt-5 flex w-full max-w-[420px] flex-col items-center gap-2 text-xs text-[color:var(--text-muted)]">
            <div className="flex max-w-full items-center gap-2">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: canPair ? "var(--color-success)" : "var(--text-dim)" }}
              />
              <span className="truncate">
                {status ? `${status.hostName} · ${modeLabel}` : "正在读取远程访问状态"}
              </span>
              {pair ? <span>· {new Date(pair.expiresAt).toLocaleTimeString()} 过期</span> : null}
            </div>
            {pairUrl ? (
              <div className="max-w-full truncate rounded-full border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-3 py-1 font-mono" title={pairUrl}>
                {pairUrl}
              </div>
            ) : candidates.length > 0 ? (
              <div className="max-w-full truncate rounded-full border border-[color:var(--border-soft)] bg-[color:var(--bg)] px-3 py-1 font-mono" title={candidates[0]}>
                {candidates[0]}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => onOpenSettings("mobile")}
              className="mt-3 text-sm font-medium text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
            >
              管理连接
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

// 历史上 TopHeader 是动作菜单入口；P1 重构后全部收敛到左侧 Sidebar header 的
// “…” 菜单了。这里仍然保留原有 Props 类型契约，避免上游 ChatApp 调用点
// 全部变动；函数体内只使用真正还在用的字段。
export function TopHeader({
  sidebarOpen,
  agentId,
  stats,
  sseStatus,
  showTools,
  showWorkbench,
  updateStatus,
  updateLatestVersion,
  electronApi,
  hasSessionContext,
  budget,
  budgetSpent,
  budgetStatus,
  budgetHasOverride,
  onToggleSidebar,
  onReconnectSession,
  onToggleTools,
  onToggleWorkbench,
  onOpenBranches,
  onOpenSystemPrompt,
  onOpenSettings,
  onCheckForUpdates,
}: TopHeaderProps) {
  const [hydrated, setHydrated] = useState(false);
  const [mobilePairOpen, setMobilePairOpen] = useState(false);
  const hydratedAgentId = hydrated ? agentId : null;
  const sessionActionsEnabled = hydrated && hasSessionContext;
  const sseLabel =
    sseStatus === "active"
      ? "Live"
      : sseStatus === "lost"
        ? "Disconnected"
        : null;

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);


  return (
    <header
      className="border-b grid items-center text-xs"
      style={{
        height: 36,
        borderColor: "var(--border)",
        color: "var(--text-muted)",
        paddingLeft: 8,
        paddingRight: 8,
        // 三列:左/中/右,各占自己的 grid track,绝不互相挤压。
        // 右列 minmax(0,auto) 让 token meter 长起来时不撑爆中列。
        gridTemplateColumns: "auto 1fr auto",
        columnGap: 8,
      }}
    >
      {/* 左：layout toggle。动作菜单已收敛到 Sidebar header，避免重复入口。 */}
      <span className="flex items-center gap-1 shrink-0 min-w-0">
        {!sidebarOpen ? (
          <IconButton
            onClick={onToggleSidebar}
            title="展开侧栏"
            aria-label="展开侧栏"
            icon={<PanelLeft size={iconSizeMap.sm} />}
          />
        ) : null}
      </span>

      {/* 中：session-level actions. Global settings stay in Settings. */}
      <span className="min-w-0">
        {hydrated ? (
          <span className="inline-flex max-w-full items-center gap-1 overflow-hidden">
            <button
              type="button"
              onClick={onOpenBranches}
              disabled={!sessionActionsEnabled}
              className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-token-sm text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text)] disabled:cursor-not-allowed disabled:text-[color:var(--text-dim)] disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-dim)]"
              title={sessionActionsEnabled ? "查看 / 切换分支" : "需先选择 session"}
            >
              <GitBranch size={13} className="shrink-0" />
              <span className="truncate">Branches</span>
            </button>
            <button
              type="button"
              onClick={onOpenSystemPrompt}
              disabled={!sessionActionsEnabled}
              className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-token-sm text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text)] disabled:cursor-not-allowed disabled:text-[color:var(--text-dim)] disabled:hover:bg-transparent disabled:hover:text-[color:var(--text-dim)]"
              title={sessionActionsEnabled ? "查看当前会话系统提示" : "需先选择 session"}
            >
              <FileText size={13} className="shrink-0" />
              <span className="truncate">System prompt</span>
            </button>
          </span>
        ) : null}
      </span>

      {/* 右：token meter + 辅助操作 + panel toggle */}
      <span className="flex items-center gap-2 justify-end min-w-0">
        {stats && stats.total > 0 && <HudMeter stats={stats} />}
        <BudgetIndicator
          budget={budget}
          spent={budgetSpent}
          status={budgetStatus}
          hasOverride={budgetHasOverride}
        />
        {sseLabel && (
          <span
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 shrink-0"
            style={{
              borderColor:
                sseStatus === "active"
                  ? "var(--color-success)"
                  : "var(--color-danger)",
              color: sseStatus === "active" ? "var(--color-success)" : "var(--color-danger)",
              background:
                sseStatus === "active"
                  ? "var(--color-success-bg)"
                  : "var(--color-danger-bg)",
            }}
            title={
              sseStatus === "active"
                ? "Live sync active"
                : "Connection lost. Session may still be running in background."
            }
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                background: sseStatus === "active" ? "var(--color-success)" : "var(--color-danger)",
              }}
            />
            <span>{sseLabel}</span>
          </span>
        )}
        {hydrated && sseStatus === "lost" && (
          <IconButton
            onClick={onReconnectSession}
            disabled={!hydratedAgentId}
            title="重连当前 session 的事件流"
            aria-label="重连当前 session"
            icon={<RefreshCw size={iconSizeMap.sm} />}
          />
        )}
        {hydrated && (
          <>
            {onCheckForUpdates ? (
              <IconButton
                onClick={onCheckForUpdates}
                disabled={updateStatus === "checking"}
                title={
                  updateStatus === "available" && updateLatestVersion
                    ? `发现新版本 ${updateLatestVersion}`
                    : updateStatus === "checking"
                      ? "正在检查更新"
                      : "检查更新"
                }
                aria-label="检查更新"
                icon={
                  updateStatus === "checking" ? (
                    <Loader2 size={iconSizeMap.sm} className="animate-spin" />
                  ) : (
                    <RefreshCw size={iconSizeMap.sm} />
                  )
                }
              />
            ) : null}
            <IconButton
              onClick={() => setMobilePairOpen(true)}
              title="手机扫码连接"
              aria-label="手机扫码连接"
              icon={<Smartphone size={iconSizeMap.sm} />}
            />
            <IconButton
              onClick={onToggleTools}
              disabled={!hydratedAgentId}
              title={
                !hydratedAgentId
                  ? "需先发送一条消息以建立 session"
                  : showTools
                    ? "关闭 Tools 面板"
                    : "打开 Tools 面板"
              }
              aria-label="Tools 面板"
              active={showTools}
              icon={<Wrench size={iconSizeMap.sm} />}
            />
            <IconButton
              onClick={onToggleWorkbench}
              title={showWorkbench ? "关闭 Workbench" : "打开 Workbench"}
              aria-label="Workbench 面板"
              active={showWorkbench}
              icon={<PanelRight size={iconSizeMap.sm} />}
            />
          </>
        )}
      </span>
      {mobilePairOpen ? (
        <MobilePairDialog
          electronApi={electronApi}
          onClose={() => setMobilePairOpen(false)}
          onOpenSettings={() => {
            setMobilePairOpen(false);
            onOpenSettings("mobile");
          }}
        />
      ) : null}
    </header>
  );
}

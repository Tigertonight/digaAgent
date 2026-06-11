import "server-only";
import { spawn, type ChildProcess } from "node:child_process";

export interface PublicTunnelStatus {
  running: boolean;
  url?: string;
  target?: string;
  startedAt?: number;
  lastCheckedAt?: number;
  healthy?: boolean;
  provider: "cloudflared";
  error?: string;
}

export interface PublicTunnelTarget {
  port: number;
  host?: string;
}

interface PublicTunnelState {
  child: ChildProcess | null;
  status: PublicTunnelStatus;
  waiters: Array<(status: PublicTunnelStatus) => void>;
}

const g = globalThis as unknown as { __miniPiPublicTunnel?: PublicTunnelState };
if (!g.__miniPiPublicTunnel) {
  g.__miniPiPublicTunnel = {
    child: null,
    status: { running: false, provider: "cloudflared" },
    waiters: [],
  };
}

const state = g.__miniPiPublicTunnel;

function updateStatus(patch: Partial<PublicTunnelStatus>) {
  state.status = { ...state.status, ...patch, provider: "cloudflared" };
  if (state.status.url || state.status.error) {
    const waiters = state.waiters.splice(0);
    for (const resolve of waiters) resolve(state.status);
  }
}

function extractTunnelUrl(text: string): string | null {
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? match[0] : null;
}

export function getPublicTunnelStatus(): PublicTunnelStatus {
  const running = Boolean(state.child && !state.child.killed);
  if (!running && state.status.running) {
    state.status = { ...state.status, running: false };
  }
  return state.status;
}

export async function checkPublicTunnelHealth(
  timeoutMs = 2500
): Promise<boolean> {
  const current = getPublicTunnelStatus();
  if (!current.running || !current.url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${current.url}/api/remote/ping`, {
      signal: controller.signal,
      cache: "no-store",
    });
    const healthy = res.ok;
    updateStatus({
      healthy,
      lastCheckedAt: Date.now(),
      error: healthy ? undefined : `公网健康检查失败 (${res.status})`,
    });
    return healthy;
  } catch (e) {
    updateStatus({
      healthy: false,
      lastCheckedAt: Date.now(),
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTunnelTarget(target: number | PublicTunnelTarget): Required<PublicTunnelTarget> {
  if (typeof target === "number") return { host: "127.0.0.1", port: target };
  return { host: target.host || "127.0.0.1", port: target.port };
}

export async function ensurePublicTunnel(
  target: number | PublicTunnelTarget
): Promise<PublicTunnelStatus> {
  const normalized = normalizeTunnelTarget(target);
  const current = getPublicTunnelStatus();
  const nextTarget = `http://${normalized.host}:${normalized.port}`;
  if (current.running && current.url && current.target && current.target !== nextTarget) {
    await stopPublicTunnel();
    return startPublicTunnel(normalized);
  }
  if (!current.running || !current.url) return startPublicTunnel(normalized);
  if (
    current.healthy &&
    current.lastCheckedAt &&
    Date.now() - current.lastCheckedAt < 15000
  ) {
    return current;
  }
  if (await checkPublicTunnelHealth()) return getPublicTunnelStatus();
  await stopPublicTunnel();
  return startPublicTunnel(normalized);
}

export async function startPublicTunnel(
  target: number | PublicTunnelTarget
): Promise<PublicTunnelStatus> {
  const normalized = normalizeTunnelTarget(target);
  const current = getPublicTunnelStatus();
  const targetUrl = `http://${normalized.host}:${normalized.port}`;
  if (current.running && current.url && current.target === targetUrl) return current;

  await stopPublicTunnel();

  state.status = {
    running: true,
    provider: "cloudflared",
    target: targetUrl,
    startedAt: Date.now(),
  };

  let child: ChildProcess;
  try {
    child = spawn("cloudflared", ["tunnel", "--url", targetUrl], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    updateStatus({
      running: false,
      error: e instanceof Error ? e.message : String(e),
    });
    return state.status;
  }

  state.child = child;

  const onData = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    const url = extractTunnelUrl(text);
    if (url) updateStatus({ running: true, url, error: undefined });
  };

  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (e) => {
    updateStatus({
      running: false,
      error:
        "code" in e && e.code === "ENOENT"
          ? "cloudflared 未安装。请先运行：brew install cloudflared"
          : e.message,
    });
  });
  child.on("exit", (code, signal) => {
    if (state.child === child) state.child = null;
    updateStatus({
      running: false,
      error:
        state.status.url || code === 0
          ? undefined
          : `cloudflared exited (${signal ?? code ?? "unknown"})`,
    });
  });

  return await new Promise<PublicTunnelStatus>((resolve) => {
    const timer = setTimeout(() => {
      updateStatus({
        running: Boolean(state.child),
        error:
          "cloudflared did not produce a public URL. Is cloudflared installed and allowed to connect?",
      });
      resolve(state.status);
    }, 20000);
    state.waiters.push((status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
}

export async function stopPublicTunnel(): Promise<PublicTunnelStatus> {
  const child = state.child;
  if (child) {
    state.child = null;
    child.kill("SIGTERM");
  }
  state.status = { running: false, provider: "cloudflared" };
  const waiters = state.waiters.splice(0);
  for (const resolve of waiters) resolve(state.status);
  return state.status;
}

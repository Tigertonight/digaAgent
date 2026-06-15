import "server-only";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  PairingCodeRecord,
  RemoteAccessSettings,
  RemoteDevice,
  RemotePairPayload,
} from "./types";
import { DEFAULT_REMOTE_PORT, listRemoteCandidates } from "./network";
import {
  ensurePublicTunnel,
  getPublicTunnelStatus,
  type PublicTunnelTarget,
} from "./public-tunnel";

const PAIR_TTL_MS = 10 * 60 * 1000;

type SettingsEnvelope = {
  remoteAccess?: Partial<RemoteAccessSettings>;
  [key: string]: unknown;
};

interface PairStore {
  codes: Map<string, PairingCodeRecord>;
}

const g = globalThis as unknown as { __digaAgentRemotePairs?: PairStore };
if (!g.__digaAgentRemotePairs) {
  g.__digaAgentRemotePairs = { codes: new Map() };
}
const pairStore = g.__digaAgentRemotePairs;

function settingsPath(): string {
  return (
    process.env.DIGA_AGENT_SETTINGS_FILE ||
    path.join(os.homedir(), ".diga-agent", "settings.json")
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function normalizeRemoteAccess(raw?: Partial<RemoteAccessSettings>): RemoteAccessSettings {
  return {
    mode: raw?.mode === "vpn" || raw?.mode === "lan" ? raw.mode : "off",
    port:
      typeof raw?.port === "number" && Number.isInteger(raw.port) && raw.port > 0
        ? raw.port
        : DEFAULT_REMOTE_PORT,
    instanceId:
      typeof raw?.instanceId === "string" && raw.instanceId.length > 0
        ? raw.instanceId
        : `pi-${randomUUID()}`,
    tlsFingerprint:
      typeof raw?.tlsFingerprint === "string" ? raw.tlsFingerprint : undefined,
    publicTunnelDisabled: raw?.publicTunnelDisabled === true,
    devices: Array.isArray(raw?.devices)
      ? raw.devices.filter((d): d is RemoteDevice => {
          return (
            !!d &&
            typeof d.id === "string" &&
            typeof d.name === "string" &&
            typeof d.tokenHash === "string" &&
            typeof d.createdAt === "number"
          );
        })
      : [],
  };
}

async function readEnvelope(): Promise<SettingsEnvelope> {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    return JSON.parse(raw) as SettingsEnvelope;
  } catch {
    return {};
  }
}

async function writeEnvelope(next: SettingsEnvelope): Promise<void> {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
}

export async function getRemoteAccessSettings(): Promise<RemoteAccessSettings> {
  const envelope = await readEnvelope();
  const normalized = normalizeRemoteAccess(envelope.remoteAccess);
  if (!envelope.remoteAccess || envelope.remoteAccess.instanceId !== normalized.instanceId) {
    envelope.remoteAccess = normalized;
    await writeEnvelope(envelope);
  }
  return normalized;
}

export async function updateRemoteAccessSettings(
  patch: Partial<RemoteAccessSettings>
): Promise<RemoteAccessSettings> {
  const envelope = await readEnvelope();
  const current = normalizeRemoteAccess(envelope.remoteAccess);
  const next = normalizeRemoteAccess({ ...current, ...patch });
  envelope.remoteAccess = next;
  await writeEnvelope(envelope);
  return next;
}

export async function createPairingPayload(
  version = "0.1.1",
  tunnelTarget?: PublicTunnelTarget
): Promise<{
  code: string;
  expiresAt: number;
  payload: RemotePairPayload;
}> {
  const settings = await getRemoteAccessSettings();
  const code = randomToken(18);
  const codeHash = sha256(code);
  const candidates = listRemoteCandidates({
    mode: settings.mode,
    port: settings.port,
    protocol: "http",
  }).map((c) => c.url);
  // R6：不要 await ensurePublicTunnel。它最多能阻塞 20s — 用户只是想生成同
  // Wi-Fi 二维码也要等。预期：
  //   - tunnel 已跑且 healthy → 直接拼进 candidates。
  //   - tunnel 未跑 / unhealthy → 在后台启动 / 修复，本次先返 LAN+VPN candidates
  //     让手机先连同 Wi-Fi。下一次 createPairingPayload 或 ensurePublicTunnel
  //     在设置面被调时会拿到公网 URL。
  const tunnel = getPublicTunnelStatus();
  if (tunnel.running && tunnel.url && tunnel.healthy !== false) {
    candidates.unshift(tunnel.url);
  } else if (!settings.publicTunnelDisabled) {
    // 后台启动，不阻塞本次。
    void ensurePublicTunnel(tunnelTarget ?? settings.port).catch(() => {
      // 失败也不报错：本次 payload 已报了同 Wi-Fi/VPN candidates。
    });
  }
  const payload: RemotePairPayload = {
    v: 1,
    hostName: os.hostname(),
    instanceId: settings.instanceId,
    candidates,
    code,
    tlsFingerprint: settings.tlsFingerprint,
    version,
  };
  const expiresAt = Date.now() + PAIR_TTL_MS;
  pairStore.codes.set(codeHash, { codeHash, payload, expiresAt });
  return { code, expiresAt, payload };
}

export function getPairingPayloadByCode(code: string): {
  expiresAt: number;
  payload: RemotePairPayload;
} | null {
  if (!code) return null;
  const record = pairStore.codes.get(sha256(code));
  if (!record || record.usedAt || record.expiresAt < Date.now()) return null;
  return { expiresAt: record.expiresAt, payload: record.payload };
}

export async function completePairing(params: {
  code: string;
  deviceName?: string;
  userAgent?: string | null;
}): Promise<{ token: string; device: Omit<RemoteDevice, "tokenHash"> }> {
  const codeHash = sha256(params.code);
  const record = pairStore.codes.get(codeHash);
  if (!record || record.usedAt || record.expiresAt < Date.now()) {
    throw new Error("pairing code expired or already used");
  }
  record.usedAt = Date.now();
  pairStore.codes.delete(codeHash);

  const token = randomToken(32);
  const device: RemoteDevice = {
    id: randomUUID(),
    name:
      params.deviceName?.trim().slice(0, 80) ||
      params.userAgent?.slice(0, 80) ||
      "Mobile device",
    tokenHash: sha256(token),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  const settings = await getRemoteAccessSettings();
  await updateRemoteAccessSettings({
    devices: [...settings.devices, device],
  });
  const publicDevice = {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
  };
  return { token, device: publicDevice };
}

export async function verifyRemoteToken(token: string): Promise<RemoteDevice | null> {
  if (!token) return null;
  const hash = sha256(token);
  const settings = await getRemoteAccessSettings();
  for (const device of settings.devices) {
    if (device.revokedAt) continue;
    const a = Buffer.from(device.tokenHash, "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length === b.length && timingSafeEqual(a, b)) {
      device.lastSeenAt = Date.now();
      await updateRemoteAccessSettings({ devices: settings.devices });
      return device;
    }
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * R5：SSE stream ticket。
 *
 * EventSource 不支持自定义 header，所以必须走 query。为了不让设备长期
 * token 走进 URL（进访问日志 / 代理 / 浏览器历史），前端先拿 device token
 * 换一个短期、一次性、仅限 SSE 使用的 ticket，在 SSE URL 里传它。
 * ticket 被占用或过期后不能再用。
 *
 * 不持久化：进程重启后所有 ticket 失效是预期的（前端会重拉一个新 ticket）。
 * ------------------------------------------------------------------------ */

interface SseTicket {
  ticketHash: string;
  deviceId: string;
  expiresAt: number;
  used?: boolean;
}

interface SseTicketStore {
  tickets: Map<string, SseTicket>;
}

const gSse = globalThis as unknown as {
  __digaAgentSseTickets?: SseTicketStore;
};
if (!gSse.__digaAgentSseTickets) {
  gSse.__digaAgentSseTickets = { tickets: new Map() };
}
const sseStore = gSse.__digaAgentSseTickets;

const SSE_TICKET_TTL_MS = 5 * 60 * 1000;

function sweepExpiredTickets(now: number): void {
  for (const [hash, t] of sseStore.tickets) {
    if (t.expiresAt <= now || t.used) sseStore.tickets.delete(hash);
  }
}

export async function issueRemoteSseTicket(
  token: string
): Promise<{ ticket: string; expiresAt: number } | null> {
  const device = await verifyRemoteToken(token);
  if (!device) return null;
  const ticket = randomToken(24);
  const ticketHash = sha256(ticket);
  const now = Date.now();
  sweepExpiredTickets(now);
  sseStore.tickets.set(ticketHash, {
    ticketHash,
    deviceId: device.id,
    expiresAt: now + SSE_TICKET_TTL_MS,
  });
  return { ticket, expiresAt: now + SSE_TICKET_TTL_MS };
}

/**
 * 验证并消费 SSE ticket。返回 deviceId 供上层检查设备是否仍未被吊销。
 * 一次性：验证后立即标记 used + 删除，同一 ticket 不能再走。
 */
export function consumeRemoteSseTicket(ticket: string): {
  deviceId: string;
} | null {
  if (!ticket) return null;
  const hash = sha256(ticket);
  const now = Date.now();
  sweepExpiredTickets(now);
  const entry = sseStore.tickets.get(hash);
  if (!entry || entry.used || entry.expiresAt <= now) return null;
  entry.used = true;
  sseStore.tickets.delete(hash);
  return { deviceId: entry.deviceId };
}

/** 测试用：清空 SSE ticket store。 */
export function __resetSseTicketsForTest(): void {
  sseStore.tickets.clear();
}

export async function listRemoteDevices(): Promise<Array<Omit<RemoteDevice, "tokenHash">>> {
  const settings = await getRemoteAccessSettings();
  return settings.devices.map((device) => ({
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
  }));
}

export async function revokeRemoteDevice(id: string): Promise<boolean> {
  const settings = await getRemoteAccessSettings();
  let changed = false;
  const devices = settings.devices.map((device) => {
    if (device.id !== id || device.revokedAt) return device;
    changed = true;
    return { ...device, revokedAt: Date.now() };
  });
  if (changed) await updateRemoteAccessSettings({ devices });
  return changed;
}

export async function revokeAllRemoteDevices(): Promise<void> {
  const settings = await getRemoteAccessSettings();
  await updateRemoteAccessSettings({
    devices: settings.devices.map((device) =>
      device.revokedAt ? device : { ...device, revokedAt: Date.now() }
    ),
  });
}

/**
 * 仅读 Authorization 头。R5 已下架 ?remoteToken= 查询参数路径，避免设备 token
 * 走进访问日志 / 代理 / 浏览器历史。所有 fetch 调用需使用 Authorization；
 * SSE 走一次性 ?sseTicket=...（见 issueRemoteSseTicket / consumeRemoteSseTicket）。
 */
export function parseBearer(req: Request): string | null {
  const value = req.headers.get("authorization");
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * 判断请求是否来自「受信本地 origin」。
 *
 * 安全模型变化（fix-S2）：
 *   - 原实现：没有 secret 时，仅依赖 Host 头判断 localhost
 *     → 远程攻击者可以伪造 `Host: localhost:3000` 直接绕过。
 *   - 现在：必须有 DIGA_AGENT_LOCAL_SECRET，且 header `x-diga-agent-local-secret` 命中。
 *     - Electron 主进程通过 webRequest.onBeforeSendHeaders 给同源请求注入。
 *     - 纯 web 模式（next dev / next start）需要在启动脚本里 export 该 secret，
 *       并通过开发者工具或浏览器扩展手工带 header 才能命中——降低误开放风险。
 *
 * 注：仅判断 "local"，不替代 token 鉴权。`assertRemoteAuth` 在远程路径里仍要求 token。
 */
export function isLocalRequest(req: Request): boolean {
  const secret = process.env.DIGA_AGENT_LOCAL_SECRET;
  if (secret) {
    return req.headers.get("x-diga-agent-local-secret") === secret;
  }
  // dev fallback：仅在 NODE_ENV=development 且未设置 secret 时，
  // 才依赖 host 判断 localhost。生产 / Electron 包装后 secret 一定存在，
  // 不会走进这个分支。next dev 在本机调试时依赖它保持顺手。
  if (process.env.NODE_ENV !== "development") return false;
  const host = req.headers.get("host") ?? "";
  return (
    host.startsWith("localhost:") ||
    host.startsWith("127.0.0.1:") ||
    host.startsWith("[::1]:")
  );
}

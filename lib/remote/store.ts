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

const g = globalThis as unknown as { __miniPiRemotePairs?: PairStore };
if (!g.__miniPiRemotePairs) {
  g.__miniPiRemotePairs = { codes: new Map() };
}
const pairStore = g.__miniPiRemotePairs;

function settingsPath(): string {
  return (
    process.env.MINI_PI_SETTINGS_FILE ||
    path.join(os.homedir(), ".mini-pi", "settings.json")
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
  let tunnel = getPublicTunnelStatus();
  if (
    !settings.publicTunnelDisabled &&
    (!tunnel.running || !tunnel.url || tunnel.healthy === false)
  ) {
    tunnel = await ensurePublicTunnel(tunnelTarget ?? settings.port);
  }
  if (tunnel.running && tunnel.url) {
    candidates.unshift(tunnel.url);
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

export function parseBearer(req: Request): string | null {
  const value = req.headers.get("authorization");
  if (value) {
    const match = value.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("remoteToken");
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function isLocalRequest(req: Request): boolean {
  const secret = process.env.MINI_PI_LOCAL_SECRET;
  if (secret && req.headers.get("x-mini-pi-local-secret") === secret) {
    return true;
  }
  if (secret) return false;
  const host = req.headers.get("host") ?? "";
  return (
    host.startsWith("localhost:") ||
    host.startsWith("127.0.0.1:") ||
    host.startsWith("[::1]:")
  );
}

export type RemoteAccessMode = "off" | "vpn" | "lan";

export interface RemoteDevice {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export interface RemoteAccessSettings {
  mode: RemoteAccessMode;
  port: number;
  instanceId: string;
  tlsFingerprint?: string;
  publicTunnelDisabled?: boolean;
  devices: RemoteDevice[];
}

export interface RemoteCandidate {
  url: string;
  kind: "public-tunnel" | "tailscale-dns" | "tailscale-ip" | "lan" | "localhost";
  label: string;
}

export interface RemotePairPayload {
  v: 1;
  hostName: string;
  instanceId: string;
  candidates: string[];
  code: string;
  tlsFingerprint?: string;
  version: string;
}

export interface PairingCodeRecord {
  codeHash: string;
  payload: RemotePairPayload;
  expiresAt: number;
  usedAt?: number;
}

export interface RemoteStatus {
  enabled: boolean;
  mode: RemoteAccessMode;
  hostName: string;
  instanceId: string;
  candidates: RemoteCandidate[];
  port: number;
  version: string;
}

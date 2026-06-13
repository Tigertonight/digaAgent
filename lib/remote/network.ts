import os from "node:os";
import type { RemoteAccessMode, RemoteCandidate } from "./types";

const DEFAULT_REMOTE_PORT = 37373;

function isIPv4Private(ip: string): boolean {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}

export function isTailscaleIPv4(ip: string): boolean {
  const parts = ip.split(".").map((x) => Number(x));
  return (
    parts.length === 4 &&
    parts.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) &&
    parts[0] === 100 &&
    parts[1] >= 64 &&
    parts[1] <= 127
  );
}

export function listRemoteCandidates(opts: {
  mode: RemoteAccessMode;
  port?: number;
  protocol?: "http" | "https";
}): RemoteCandidate[] {
  const port = opts.port ?? DEFAULT_REMOTE_PORT;
  const protocol = opts.protocol ?? "http";
  if (opts.mode === "off") {
    return [
      {
        url: `http://127.0.0.1:${port}`,
        kind: "localhost",
        label: "Localhost",
      },
    ];
  }

  const candidates: RemoteCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: RemoteCandidate) => {
    if (seen.has(candidate.url)) return;
    seen.add(candidate.url);
    candidates.push(candidate);
  };

  const host = os.hostname();
  const nets = os.networkInterfaces();
  for (const [name, entries] of Object.entries(nets)) {
    for (const item of entries ?? []) {
      if (item.internal || item.family !== "IPv4") continue;
      if (isTailscaleIPv4(item.address)) {
        add({
          url: `${protocol}://${item.address}:${port}`,
          kind: "tailscale-ip",
          label: `Tailscale ${item.address}`,
        });
      } else if (opts.mode === "lan" && isIPv4Private(item.address)) {
        add({
          url: `${protocol}://${item.address}:${port}`,
          kind: "lan",
          label: `${name} ${item.address}`,
        });
      }
    }
  }

  if (opts.mode === "vpn") {
    const tailnetName = process.env.DIGA_AGENT_TAILSCALE_DNS;
    if (tailnetName) {
      candidates.unshift({
        url: `${protocol}://${tailnetName}:${port}`,
        kind: "tailscale-dns",
        label: "Tailscale MagicDNS",
      });
    } else if (host) {
      add({
        url: `${protocol}://${host}:${port}`,
        kind: "tailscale-dns",
        label: "Host name",
      });
    }
  }

  add({
    url: `http://localhost:${port}`,
    kind: "localhost",
    label: "Localhost",
  });

  return candidates;
}

export function recommendedRemoteMode(): Exclude<RemoteAccessMode, "off"> {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries ?? []) {
      if (!item.internal && item.family === "IPv4" && isTailscaleIPv4(item.address)) {
        return "vpn";
      }
    }
  }
  return "lan";
}

export function bindHostForRemoteMode(mode: RemoteAccessMode): string {
  if (mode === "off") return "127.0.0.1";
  if (mode === "lan") return "0.0.0.0";
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries ?? []) {
      if (!item.internal && item.family === "IPv4" && isTailscaleIPv4(item.address)) {
        return item.address;
      }
    }
  }
  return "127.0.0.1";
}

export { DEFAULT_REMOTE_PORT };

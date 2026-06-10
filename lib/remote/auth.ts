import "server-only";
import { NextResponse } from "next/server";
import { getRemoteAccessSettings, isLocalRequest, parseBearer, verifyRemoteToken } from "./store";
import { listRemoteCandidates } from "./network";
import { getPublicTunnelStatus } from "./public-tunnel";

function originHost(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

export async function assertRemoteAuth(req: Request): Promise<NextResponse | null> {
  if (isLocalRequest(req)) return null;

  const settings = await getRemoteAccessSettings();
  const tunnel = getPublicTunnelStatus();
  const tunnelActive = Boolean(tunnel.running && tunnel.url);
  if (settings.mode === "off" && !tunnelActive) {
    return NextResponse.json({ error: "remote access disabled" }, { status: 403 });
  }

  const allowedHosts = new Set(
    listRemoteCandidates({ mode: settings.mode, port: settings.port }).map((c) => {
      try {
        return new URL(c.url).host;
      } catch {
        return "";
      }
    })
  );
  if (tunnelActive && tunnel.url) {
    try {
      allowedHosts.add(new URL(tunnel.url).host);
    } catch {
      // ignore malformed tunnel URL
    }
  }
  const host = req.headers.get("host") ?? "";
  if (allowedHosts.size > 0 && host && !allowedHosts.has(host)) {
    return NextResponse.json({ error: "host not allowed" }, { status: 403 });
  }
  const origin = originHost(req.headers.get("origin"));
  if (origin && !allowedHosts.has(origin)) {
    return NextResponse.json({ error: "origin not allowed" }, { status: 403 });
  }

  const token = parseBearer(req);
  const device = token ? await verifyRemoteToken(token) : null;
  if (!device) {
    return NextResponse.json({ error: "remote token required" }, { status: 401 });
  }
  return null;
}

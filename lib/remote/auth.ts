import "server-only";
import { NextResponse } from "next/server";
import {
  consumeRemoteSseTicket,
  getRemoteAccessSettings,
  isLocalRequest,
  parseBearer,
  verifyRemoteToken,
} from "./store";
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

  // R5：SSE 走一次性 ticket（?sseTicket=...）。ticket 被验证一下就作废，
  // 不会沉积到访问日志里拿手重放。仅 GET（SSE）采用。
  if (req.method === "GET") {
    try {
      const url = new URL(req.url);
      const ticketRaw = url.searchParams.get("sseTicket");
      if (ticketRaw) {
        const consumed = consumeRemoteSseTicket(ticketRaw);
        if (consumed) {
          // 成功：sse ticket 已刷。不再检查 token。
          return null;
        }
        return NextResponse.json(
          { error: "sse ticket invalid or expired" },
          { status: 401 }
        );
      }
    } catch {
      // 错误 URL 下划走后面的 token 检查。
    }
  }

  const token = parseBearer(req);
  const device = token ? await verifyRemoteToken(token) : null;
  if (!device) {
    return NextResponse.json({ error: "remote token required" }, { status: 401 });
  }
  return null;
}

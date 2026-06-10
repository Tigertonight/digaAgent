import { NextResponse } from "next/server";
import {
  getRemoteAccessSettings,
  isLocalRequest,
  updateRemoteAccessSettings,
} from "@/lib/remote/store";
import type { RemoteAccessMode } from "@/lib/remote/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validMode(value: unknown): value is RemoteAccessMode {
  return value === "off" || value === "vpn" || value === "lan";
}

export async function GET(req: Request) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "local access required" }, { status: 403 });
  }
  const settings = await getRemoteAccessSettings();
  return NextResponse.json({
    mode: settings.mode,
    port: settings.port,
    instanceId: settings.instanceId,
    tlsFingerprint: settings.tlsFingerprint,
    publicTunnelDisabled: settings.publicTunnelDisabled === true,
  });
}

export async function PATCH(req: Request) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "local access required" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    mode?: unknown;
    port?: unknown;
  };
  const patch: { mode?: RemoteAccessMode; port?: number } = {};
  if (body.mode !== undefined) {
    if (!validMode(body.mode)) {
      return NextResponse.json({ error: "invalid mode" }, { status: 400 });
    }
    patch.mode = body.mode;
  }
  if (body.port !== undefined) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return NextResponse.json({ error: "invalid port" }, { status: 400 });
    }
    patch.port = port;
  }
  const settings = await updateRemoteAccessSettings(patch);
  return NextResponse.json({
    mode: settings.mode,
    port: settings.port,
    instanceId: settings.instanceId,
    tlsFingerprint: settings.tlsFingerprint,
    publicTunnelDisabled: settings.publicTunnelDisabled === true,
  });
}

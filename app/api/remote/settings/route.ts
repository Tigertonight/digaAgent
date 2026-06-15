import { NextResponse } from "next/server";
import {
  getRemoteAccessSettings,
  updateRemoteAccessSettings,
} from "@/lib/remote/store";
import type { RemoteAccessMode } from "@/lib/remote/types";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validMode(value: unknown): value is RemoteAccessMode {
  return value === "off" || value === "vpn" || value === "lan";
}

// 远程访问设置只能本地调（从 desktop settings UI）。
export const GET = withRemoteAuth(
  async function () {
    const settings = await getRemoteAccessSettings();
    return NextResponse.json({
      mode: settings.mode,
      port: settings.port,
      instanceId: settings.instanceId,
      tlsFingerprint: settings.tlsFingerprint,
      publicTunnelDisabled: settings.publicTunnelDisabled === true,
    });
  },
  { requireLocalOnly: true }
);

export const PATCH = withRemoteAuth(
  async function (req: Request) {
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
  },
  { requireLocalOnly: true }
);

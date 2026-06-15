import { NextResponse } from "next/server";
import {
  getRemoteAccessSettings,
  updateRemoteAccessSettings,
} from "@/lib/remote/store";
import { startPublicTunnel } from "@/lib/remote/public-tunnel";
import { tunnelTargetFromRequest } from "@/lib/remote/request-target";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withRemoteAuth(
  async function (req: Request) {
  const body = (await req.json().catch(() => ({}))) as { port?: unknown };
  const settings = await getRemoteAccessSettings();
  const port = Number(body.port ?? settings.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return NextResponse.json({ error: "invalid port" }, { status: 400 });
  }
  await updateRemoteAccessSettings({ publicTunnelDisabled: false });
  const requestTarget = tunnelTargetFromRequest(req, port);
  const status = await startPublicTunnel(requestTarget);
  return NextResponse.json(status, { status: status.error && !status.url ? 500 : 200 });
  },
  { requireLocalOnly: true }
);

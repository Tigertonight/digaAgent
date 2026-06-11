import { NextResponse } from "next/server";
import {
  getRemoteAccessSettings,
  isLocalRequest,
  updateRemoteAccessSettings,
} from "@/lib/remote/store";
import { startPublicTunnel } from "@/lib/remote/public-tunnel";
import { tunnelTargetFromRequest } from "@/lib/remote/request-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "local access required" }, { status: 403 });
  }
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
}

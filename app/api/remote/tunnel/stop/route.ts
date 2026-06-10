import { NextResponse } from "next/server";
import { isLocalRequest, updateRemoteAccessSettings } from "@/lib/remote/store";
import { stopPublicTunnel } from "@/lib/remote/public-tunnel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "local access required" }, { status: 403 });
  }
  await updateRemoteAccessSettings({ publicTunnelDisabled: true });
  return NextResponse.json(await stopPublicTunnel());
}

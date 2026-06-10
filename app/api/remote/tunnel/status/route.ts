import { NextResponse } from "next/server";
import { isLocalRequest } from "@/lib/remote/store";
import { getPublicTunnelStatus } from "@/lib/remote/public-tunnel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "local access required" }, { status: 403 });
  }
  return NextResponse.json(getPublicTunnelStatus());
}

import { NextResponse } from "next/server";
import { getPublicTunnelStatus } from "@/lib/remote/public-tunnel";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRemoteAuth(
  async function () {
    return NextResponse.json(getPublicTunnelStatus());
  },
  { requireLocalOnly: true }
);

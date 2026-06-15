import { NextResponse } from "next/server";
import { updateRemoteAccessSettings } from "@/lib/remote/store";
import { stopPublicTunnel } from "@/lib/remote/public-tunnel";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withRemoteAuth(
  async function () {
    await updateRemoteAccessSettings({ publicTunnelDisabled: true });
    return NextResponse.json(await stopPublicTunnel());
  },
  { requireLocalOnly: true }
);

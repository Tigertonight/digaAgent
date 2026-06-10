import { NextResponse } from "next/server";
import { assertRemoteAuth } from "@/lib/remote/auth";
import { isLocalRequest, listRemoteDevices } from "@/lib/remote/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isLocalRequest(req)) {
    const auth = await assertRemoteAuth(req);
    if (auth) return auth;
  }
  return NextResponse.json({ devices: await listRemoteDevices() });
}

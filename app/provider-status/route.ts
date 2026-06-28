import { NextResponse } from "next/server";
import { buildProvidersResponse } from "@/lib/provider-list";
import { assertRemoteAuth } from "@/lib/remote/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  try {
    return NextResponse.json(await buildProvidersResponse());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

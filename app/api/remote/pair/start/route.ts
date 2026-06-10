import { NextResponse } from "next/server";
import pkg from "@/package.json";
import { createPairingPayload, isLocalRequest } from "@/lib/remote/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "local access required" }, { status: 403 });
  }
  const result = await createPairingPayload(
    (pkg as { version?: string }).version ?? "0.0.0"
  );
  return NextResponse.json(result);
}

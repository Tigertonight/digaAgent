import { NextResponse } from "next/server";
import { getPairingPayloadByCode } from "@/lib/remote/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const result = getPairingPayloadByCode(code);
  if (!result) {
    return NextResponse.json(
      { error: "pairing code expired or invalid" },
      { status: 404 }
    );
  }
  return NextResponse.json(result);
}

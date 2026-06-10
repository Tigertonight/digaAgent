import { NextResponse } from "next/server";
import { completePairing } from "@/lib/remote/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const code = typeof body.code === "string" ? body.code : "";
  if (!code) {
    return NextResponse.json({ error: "code required" }, { status: 400 });
  }
  try {
    const result = await completePairing({
      code,
      deviceName:
        typeof body.deviceName === "string" ? body.deviceName : undefined,
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json({
      token: result.token,
      deviceId: result.device.id,
      device: result.device,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}

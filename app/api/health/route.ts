import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    name: "mini-pi-web",
    stage: "B1",
    time: new Date().toISOString(),
  });
}

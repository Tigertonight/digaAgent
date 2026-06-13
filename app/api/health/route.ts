import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    name: "diga-agent",
    stage: "B1",
    time: new Date().toISOString(),
  });
}

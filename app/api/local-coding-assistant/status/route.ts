import { NextResponse } from "next/server";
import { detectLocalCodingAssistantStatus } from "@/lib/local-coding-assistant/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await detectLocalCodingAssistantStatus());
}

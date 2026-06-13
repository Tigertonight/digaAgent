import { NextResponse } from "next/server";
import { detectCodeWizStatus } from "@/lib/codewiz-cc/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await detectCodeWizStatus());
}

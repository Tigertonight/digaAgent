import { NextResponse } from "next/server";
import { detectLocalCodingAssistantStatus } from "@/lib/local-coding-assistant/status";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRemoteAuth(async () => {
  return NextResponse.json(await detectLocalCodingAssistantStatus());
});

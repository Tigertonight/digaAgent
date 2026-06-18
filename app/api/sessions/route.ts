import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/sessions";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import { internalErrorResponse } from "@/lib/api/error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRemoteAuth(async function () {
  try {
    const sessions = await listAllSessions();
    // 序列化时 Date 自动变 ISO 字符串
    return NextResponse.json({ sessions });
  } catch (e) {
    return internalErrorResponse(e, { scope: "GET /api/sessions" });
  }
});

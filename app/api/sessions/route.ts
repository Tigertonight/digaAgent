import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/sessions";
import { assertRemoteAuth } from "@/lib/remote/auth";
import { internalErrorResponse } from "@/lib/api/error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  try {
    const sessions = await listAllSessions();
    // 序列化时 Date 自动变 ISO 字符串
    return NextResponse.json({ sessions });
  } catch (e) {
    return internalErrorResponse(e, { scope: "GET /api/sessions" });
  }
}

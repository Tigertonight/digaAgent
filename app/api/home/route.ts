/**
 * GET /api/home → 用户 home 目录，给文件 picker 当起点。
 */
import { NextResponse } from "next/server";
import { homedir } from "node:os";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRemoteAuth(async () => {
  return NextResponse.json({ home: homedir() });
});

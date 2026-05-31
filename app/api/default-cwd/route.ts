/**
 * GET /api/default-cwd → 服务器进程的 cwd，作为新会话默认目录。
 *
 * 复刻 pi-web 的 /api/default-cwd。
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ cwd: process.cwd() });
}

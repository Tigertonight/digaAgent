/**
 * GET /api/default-cwd → 服务器进程的 cwd，作为新会话默认目录。
 *
 * 复刻 pi-web 的 /api/default-cwd。
 */
import { NextResponse } from "next/server";
import { assertRemoteAuth } from "@/lib/remote/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  // Electron 下 process.cwd() = .app/Contents/Resources/app.asar.unpacked/.next/standalone,
  // 不是用户期待的家目录;优先用 electron/main.js 注入的 DIGA_AGENT_WEB_ROOT。
  return NextResponse.json({ cwd: process.env.DIGA_AGENT_WEB_ROOT || process.cwd() });
}

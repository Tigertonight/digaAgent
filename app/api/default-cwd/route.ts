/**
 * GET /api/default-cwd → 服务器进程的 cwd，作为新会话默认目录。
 *
 * 复刻 pi-web 的 /api/default-cwd。
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Electron 下 process.cwd() = .app/Contents/Resources/app.asar.unpacked/.next/standalone,
  // 不是用户期待的家目录;优先用 electron/main.js 注入的 MINI_PI_WEB_ROOT。
  return NextResponse.json({ cwd: process.env.MINI_PI_WEB_ROOT || process.cwd() });
}

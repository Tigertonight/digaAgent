/**
 * GET /api/providers
 *
 * 列出 ModelRegistry 里所有已知 provider 和它们的 model。
 * 同时标注哪个 provider 已配 auth（auth.json 有 key 或环境变量存在）。
 *
 * 前端用这个数据画 provider/model 二级选择器。
 */
import { NextResponse } from "next/server";
import { buildProvidersResponse } from "@/lib/provider-list";
import { assertRemoteAuth } from "@/lib/remote/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  try {
    return NextResponse.json(await buildProvidersResponse());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * GET / PATCH / DELETE /api/preferences/last-model
 *
 * 持久化"上次使用的 provider + 模型"。Electron 下落到 userData/settings.json，
 * web 模式落到 ~/.diga-agent/settings.json。
 *
 * 解决的问题：localStorage 在升级版本 / 切端口 / 清缓存时会丢；
 * DEFAULT_MODEL_STORAGE_VERSION 升级时还会主动清；用户每次都要重新选。
 *
 * 远程访问需要 token；不限制 isLocal —— 手机端也读这一份，多端一致。
 */
import { NextResponse } from "next/server";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import {
  clearLastModel,
  getLastModel,
  setLastModel,
} from "@/lib/preferences/last-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRemoteAuth(async (req: Request) => {
  void req;
  const lastModel = await getLastModel();
  return NextResponse.json({ lastModel });
});

export const PATCH = withRemoteAuth(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const patch = (body.lastModel ?? body) as Record<string, unknown>;
  const provider =
    typeof patch.provider === "string" ? patch.provider : undefined;
  const modelId = typeof patch.modelId === "string" ? patch.modelId : undefined;
  try {
    const lastModel = await setLastModel({ provider, modelId });
    return NextResponse.json({ lastModel });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
});

export const DELETE = withRemoteAuth(async (req: Request) => {
  void req;
  await clearLastModel();
  return NextResponse.json({ ok: true });
});

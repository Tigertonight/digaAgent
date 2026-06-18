import { NextResponse } from "next/server";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import {
  getAgentProfilesSettings,
  updateAgentProfilesSettings,
} from "@/lib/agent-profiles/settings";
import { BUILT_IN_PROFILES } from "@/lib/agent-profiles/built-in";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRemoteAuth(async (req: Request) => {
  void req;
  const settings = await getAgentProfilesSettings();
  // 同时返回内置 profiles，供前端只读展示（避免前端再 import 服务端常量）。
  return NextResponse.json({
    agentProfiles: settings,
    builtInProfiles: BUILT_IN_PROFILES,
  });
});

export const PATCH = withRemoteAuth(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const patch = (body.agentProfiles ?? body) as Record<string, unknown>;
  if (typeof patch.defaultProfileId !== "string") {
    return NextResponse.json(
      { error: "defaultProfileId (string) is required" },
      { status: 400 }
    );
  }
  // Phase B 只支持改默认 profile id（自定义 profile 编辑留待后续 Phase）。
  const next = await updateAgentProfilesSettings({
    defaultProfileId: patch.defaultProfileId,
  });
  return NextResponse.json({ agentProfiles: next });
});

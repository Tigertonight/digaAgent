import { NextResponse } from "next/server";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import {
  getNarrationSettings,
  updateNarrationSettings,
} from "@/lib/narration/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRemoteAuth(async (req: Request) => {
  void req;
  return NextResponse.json({ narration: await getNarrationSettings() });
});

export const PATCH = withRemoteAuth(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const patch = (body.narration ?? body) as Record<string, unknown>;
  const narration = await updateNarrationSettings({
    enable: typeof patch.enable === "boolean" ? patch.enable : undefined,
    timeoutMs: typeof patch.timeoutMs === "number" ? patch.timeoutMs : undefined,
    provider: typeof patch.provider === "string" ? patch.provider : undefined,
    modelId: typeof patch.modelId === "string" ? patch.modelId : undefined,
  });
  return NextResponse.json({ narration });
});

import { NextResponse } from "next/server";
import { createAgent, getAgent } from "@/lib/agent-registry";
import { assertRemoteAuth } from "@/lib/remote/auth";
import type { ThinkingLevel } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  try {
    const body = await req.json().catch(() => ({}));
    const provider = body.provider as string | undefined;
    const modelId = body.modelId as string | undefined;
    const cwd = (body.cwd as string | undefined) ?? process.cwd();
    const sessionPath = body.sessionPath as string | undefined;
    const thinkingLevel = body.thinkingLevel as ThinkingLevel | undefined;

    if (!provider || !modelId) {
      return NextResponse.json(
        { error: "provider and modelId required" },
        { status: 400 }
      );
    }

    const result = await createAgent({
      provider,
      modelId,
      cwd,
      sessionPath,
      thinkingLevel,
    });

    // 把当前 agent 的 thinking 元数据一起返回，省一次往返
    const rec = getAgent(result.id);
    return NextResponse.json({
      ...result,
      thinkingLevel: rec?.session.thinkingLevel,
      supportsThinking: rec?.session.supportsThinking(),
      availableThinkingLevels: rec?.session.getAvailableThinkingLevels(),
      model: rec?.session.model
        ? {
            provider: rec.session.model.provider,
            id: rec.session.model.id,
            name: rec.session.model.name,
          }
        : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, stack: (e as Error).stack },
      { status: 500 }
    );
  }
}

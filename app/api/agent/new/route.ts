import { NextResponse } from "next/server";
import { createAgent, getAgent } from "@/lib/agent-registry";
import { assertRemoteAuth } from "@/lib/remote/auth";
import { assertPathAllowed } from "@/lib/files/policy";
import {
  assertTrustedSessionPath,
  invalidateSessionListCache,
  TrustedSessionPathError,
} from "@/lib/sessions";
import { internalErrorResponse } from "@/lib/api/error-response";
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
    const rawCwd = (body.cwd as string | undefined) ?? process.cwd();
    let cwd: string;
    try {
      cwd = assertPathAllowed(rawCwd);
    } catch (e) {
      return NextResponse.json(
        {
          error: `cwd outside allowed file roots: ${(e as Error).message}`,
        },
        { status: 403 }
      );
    }
    const rawSessionPath = body.sessionPath as string | undefined;
    const thinkingLevel = body.thinkingLevel as ThinkingLevel | undefined;

    if (!provider || !modelId) {
      return NextResponse.json(
        { error: "provider and modelId required" },
        { status: 400 }
      );
    }

    // T1.1：resume 路径越权修复。仅接受在 SDK listAll() 可信清单内的 sessionPath，
    // 避免被作为任意路径写 / 读的入口（详见 docs/reports/session-audit.md H1）。
    let sessionPath: string | undefined;
    if (rawSessionPath) {
      try {
        sessionPath = await assertTrustedSessionPath(rawSessionPath);
      } catch (e) {
        if (e instanceof TrustedSessionPathError) {
          return NextResponse.json(
            { error: "sessionPath not allowed" },
            { status: 400 }
          );
        }
        throw e;
      }
    }

    const result = await createAgent({
      provider,
      modelId,
      cwd,
      sessionPath,
      thinkingLevel,
    });
    invalidateSessionListCache();

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
    // 不再直返 message/stack，与其他路由对齐脱敏。
    return internalErrorResponse(e, { scope: "POST /api/agent/new" });
  }
}

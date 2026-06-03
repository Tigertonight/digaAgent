/**
 * POST /api/auth/test
 *
 * body: { provider: string, modelId?: string }
 *
 * 用当前 ModelRegistry + AuthStorage 发一条最小 prompt，验证某个 provider 的凭证
 * 是否真的可调用模型。用于 AuthPanel / ProviderSetupWizard 的保存后验证。
 */
import { NextResponse, type NextRequest } from "next/server";
import { completeSimple } from "@earendil-works/pi-ai";
import { getModelRegistry } from "@/lib/agent-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface TestAuthRequest {
  provider?: string;
  modelId?: string;
}

function pickModel(provider: string, modelId?: string) {
  const mr = getModelRegistry();
  if (modelId) return mr.find(provider, modelId);
  return mr.getAll().find((m) => m.provider === provider) ?? null;
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  let httpStatus: number | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as TestAuthRequest;
    const provider = body.provider?.trim();
    if (!provider) {
      return NextResponse.json(
        { ok: false, error: "provider required" },
        { status: 400 }
      );
    }

    const model = pickModel(provider, body.modelId?.trim());
    if (!model) {
      return NextResponse.json(
        {
          ok: false,
          error: body.modelId
            ? `model not found: ${provider}/${body.modelId}`
            : `no model registered for provider: ${provider}`,
          latencyMs: Date.now() - startedAt,
        },
        { status: 404 }
      );
    }

    const mr = getModelRegistry();
    const auth = await mr.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return NextResponse.json({
        ok: false,
        error: `auth failed: ${auth.error}`,
        latencyMs: Date.now() - startedAt,
      });
    }
    if (!auth.apiKey) {
      return NextResponse.json({
        ok: false,
        error: `No API key or OAuth token found for "${provider}"`,
        latencyMs: Date.now() - startedAt,
      });
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    try {
      const msg = await completeSimple(
        model,
        {
          messages: [
            {
              role: "user",
              content: "Reply with OK only.",
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: 16,
          timeoutMs: 20_000,
          maxRetries: 0,
          cacheRetention: "none",
          signal: ac.signal,
          onResponse: (r: { status?: number }) => {
            httpStatus = r?.status;
          },
        }
      );
      const latencyMs = Date.now() - startedAt;
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        return NextResponse.json({
          ok: false,
          error:
            msg.errorMessage ??
            (ac.signal.aborted ? "Test timed out" : "Model returned an error"),
          latencyMs,
          status: httpStatus,
          model: { provider: model.provider, id: model.id, name: model.name },
        });
      }
      return NextResponse.json({
        ok: true,
        latencyMs,
        status: httpStatus,
        model: { provider: model.provider, id: model.id, name: model.name },
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        latencyMs: Date.now() - startedAt,
        status: httpStatus,
      },
      { status: 500 }
    );
  }
}

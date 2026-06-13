/**
 * POST /api/models-config/test
 *
 * body: { provider: ProviderConfig, providerId?: string, model: ModelConfig }
 *   - provider: 用户填的 provider 配置（baseUrl/api/apiKey/headers/...）
 *   - providerId: 该 provider 在 models.json 里的 key 名（如 "anthropic"、"my-openrouter"）
 *                 没传则用 provider.name 或 fallback "test-provider"
 *   - model: 要测的 model 配置（id 必填，加 name/api/contextWindow 等可选）
 *
 * 实现：把 {providers: {[id]: {...provider, models: [{...model}]}}} 写到一个临时 models.json，
 * 用临时 ModelRegistry 隔离测试，发一条 "Reply with OK only." 的最小 prompt，超时 20s。
 *
 * 返回: { ok: boolean, error?: string, latencyMs?: number, status?: number }
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  ModelRegistry,
  AuthStorage,
} from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface TestRequestBody {
  provider?: Record<string, unknown> & { name?: string };
  providerId?: string;
  model?: Record<string, unknown> & { id?: string };
}

function trimStringField(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function POST(req: NextRequest) {
  let tempDir: string | undefined;
  const startedAt = Date.now();
  let httpStatus: number | undefined;
  try {
    const body = (await req.json()) as TestRequestBody;
    const providerConfig = body?.provider;
    const modelConfig = body?.model;
    if (!providerConfig || typeof providerConfig !== "object") {
      return NextResponse.json(
        { ok: false, error: "provider config required" },
        { status: 400 }
      );
    }
    if (!modelConfig || typeof modelConfig !== "object") {
      return NextResponse.json(
        { ok: false, error: "model config required" },
        { status: 400 }
      );
    }
    const providerId =
      trimStringField(body.providerId) ||
      trimStringField(providerConfig.name) ||
      "test-provider";
    const modelId = trimStringField(modelConfig.id);
    if (!modelId) {
      return NextResponse.json(
        { ok: false, error: "model.id required" },
        { status: 400 }
      );
    }

    // 1. 写临时 models.json
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "diga-agent-model-test-"));
    const tempFile = path.join(tempDir, "models.json");
    const tempConfig = {
      providers: {
        [providerId]: {
          ...providerConfig,
          models: [{ ...modelConfig, id: modelId }],
        },
      },
    };
    fs.writeFileSync(tempFile, JSON.stringify(tempConfig, null, 2), "utf8");

    // 2. 临时 ModelRegistry（用临时 AuthStorage 隔离）
    const tempRegistry = ModelRegistry.create(AuthStorage.create(), tempFile);
    const loadErr = tempRegistry.getError();
    if (loadErr) {
      return NextResponse.json(
        { ok: false, error: `models.json invalid: ${loadErr}` },
        { status: 400 }
      );
    }
    const model = tempRegistry.find(providerId, modelId);
    if (!model) {
      return NextResponse.json(
        {
          ok: false,
          error: `model not registered: ${providerId}/${modelId}`,
        },
        { status: 400 }
      );
    }

    // 3. 拿 apiKey + headers（同时会校验 auth 是否配齐）
    const auth = await tempRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return NextResponse.json({
        ok: false,
        error: `auth failed: ${auth.error}`,
        latencyMs: Date.now() - startedAt,
      });
    }

    // 4. 发最小 prompt，20s 超时
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
        });
      }
      return NextResponse.json({
        ok: true,
        latencyMs,
        status: httpStatus,
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
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup error */
      }
    }
  }
}

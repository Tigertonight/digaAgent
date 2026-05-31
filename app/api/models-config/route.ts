/**
 * GET / PUT /api/models-config
 *
 * 读写 `~/.pi/agent/models.json`。schema 直接对齐 SDK ModelRegistry 原生格式：
 *   {
 *     providers: {
 *       [providerName]: {
 *         baseUrl?, api?, apiKey?, headers?, authHeader?, compat?,
 *         models?: Array<{
 *           id, name?, api?, reasoning?, input?, contextWindow?, maxTokens?,
 *           cost?: {input, output, cacheRead, cacheWrite}, headers?, baseUrl?
 *         }>,
 *         modelOverrides?: Record<string, {baseUrl?, headers?}>,
 *       }
 *     }
 *   }
 *
 * 写入是全量覆盖（pi-web 行为）。写完后调用 ModelRegistry.refresh() 让 in-memory 状态与磁盘同步。
 */
import { NextResponse, type NextRequest } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getModelRegistry } from "@/lib/agent-registry";
import fs from "node:fs";
import path from "node:path";

function getModelsPath(): string {
  return path.join(getAgentDir(), "models.json");
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function readModelsJson(): unknown {
  const file = getModelsPath();
  if (!fs.existsSync(file)) return { providers: {} };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { providers: {} };
  }
}

export async function GET() {
  try {
    const data = readModelsJson();
    return NextResponse.json({
      path: getModelsPath(),
      data,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    // 基本校验：必须是 object 且含 providers 字段（即使为空 dict）
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof (body as { providers?: unknown }).providers !== "object"
    ) {
      return NextResponse.json(
        { error: "body must be {providers: {...}}" },
        { status: 400 }
      );
    }
    const file = getModelsPath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf8");

    // 让 ModelRegistry 重新扫一下 models.json，新加的 provider/model 立刻可用
    try {
      getModelRegistry().refresh();
    } catch {
      /* refresh 失败不影响写入本身 */
    }

    return NextResponse.json({ ok: true, path: file });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

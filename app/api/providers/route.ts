/**
 * GET /api/providers
 *
 * 列出 ModelRegistry 里所有已知 provider 和它们的 model。
 * 同时标注哪个 provider 已配 auth（auth.json 有 key 或环境变量存在）。
 *
 * 前端用这个数据画 provider/model 二级选择器。
 */
import { NextResponse } from "next/server";
import { getModelRegistry } from "@/lib/agent-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ProviderInfo {
  provider: string;
  displayName: string;
  hasAuth: boolean;
  authSource: string | undefined;
  authLabel: string | undefined;
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
  }>;
}

export async function GET() {
  try {
    const mr = getModelRegistry();
    const all = mr.getAll();

    // 按 provider 分桶
    const buckets = new Map<string, ProviderInfo>();
    for (const m of all) {
      const provider = m.provider;
      if (!buckets.has(provider)) {
        const status = mr.getProviderAuthStatus(provider);
        // SDK 的语义：configured=true 只对应 auth.json 里有 entry。
        // 环境变量 (source: "environment") 同样可用，对用户来说也算"已配 auth"，
        // 所以这里把"任何 source 存在"都视为 hasAuth。
        const hasAuth =
          status.configured ||
          status.source === "environment" ||
          status.source === "runtime" ||
          status.source === "models_json_key" ||
          status.source === "models_json_command";
        buckets.set(provider, {
          provider,
          displayName: mr.getProviderDisplayName(provider),
          hasAuth,
          authSource: status.source,
          authLabel: status.label,
          models: [],
        });
      }
      buckets.get(provider)!.models.push({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
      });
    }

    // 排序：有 auth 的排前面，再按 displayName
    const providers = Array.from(buckets.values()).sort((a, b) => {
      if (a.hasAuth !== b.hasAuth) return a.hasAuth ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });

    // 选个合理默认值
    const defaultProvider = providers.find((p) => p.hasAuth) ?? providers[0];
    const defaultModel = defaultProvider?.models[0];

    return NextResponse.json({
      providers,
      total: providers.length,
      authedCount: providers.filter((p) => p.hasAuth).length,
      defaultProvider: defaultProvider?.provider,
      defaultModelId: defaultModel?.id,
      loadError: mr.getError(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

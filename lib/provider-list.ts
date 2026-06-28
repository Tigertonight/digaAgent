import {
  LOCAL_CODING_ASSISTANT_MODELS,
  LOCAL_CODING_ASSISTANT_PROVIDER_ID,
  getModelRegistry,
} from "@/lib/agent-registry";
import { pickDefaultProviderModel } from "@/lib/default-model";
import { detectLocalCodingAssistantStatus } from "@/lib/local-coding-assistant/status";
import type { ProviderInfo, ProvidersResponse } from "@/lib/types";

export async function buildProvidersResponse(): Promise<ProvidersResponse> {
  const mr = getModelRegistry();
  const all = mr.getAll();

  const buckets = new Map<string, ProviderInfo>();
  for (const m of all) {
    const provider = m.provider;
    if (!buckets.has(provider)) {
      const status = mr.getProviderAuthStatus(provider);
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

  const localCodingAssistant = await detectLocalCodingAssistantStatus();
  if (localCodingAssistant.installed && localCodingAssistant.tokenPresent) {
    buckets.set(LOCAL_CODING_ASSISTANT_PROVIDER_ID, {
      provider: LOCAL_CODING_ASSISTANT_PROVIDER_ID,
      displayName: "自研 Coding 助手",
      hasAuth: true,
      authSource: "local_cli_session",
      authLabel: "本机登录缓存",
      models: LOCAL_CODING_ASSISTANT_MODELS.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: true,
        contextWindow: 200000,
        maxTokens: 64000,
      })),
    });
  }

  const providers = Array.from(buckets.values()).sort((a, b) => {
    if (a.hasAuth !== b.hasAuth) return a.hasAuth ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
  const defaultSelection = pickDefaultProviderModel(providers);

  return {
    providers,
    total: providers.length,
    authedCount: providers.filter((p) => p.hasAuth).length,
    defaultProvider: defaultSelection.providerId || undefined,
    defaultModelId: defaultSelection.modelId || undefined,
    loadError: mr.getError(),
  };
}

export const DEFAULT_PROVIDER_ID = "openai-codex";
export const DEFAULT_MODEL_ID = "gpt-5.5";
export const DEFAULT_MODEL_STORAGE_VERSION = `${DEFAULT_PROVIDER_ID}:${DEFAULT_MODEL_ID}:curated-v2`;

export const CURATED_MODEL_OPTIONS = [
  {
    providerId: "openai-codex",
    modelId: "gpt-5.5",
    label: "GPT-5.5",
  },
  {
    providerId: "rednote-runway-local",
    modelId: "claude-opus-4-7",
    label: "Claude Opus 4.7",
  },
  {
    providerId: "minimax-cn",
    modelId: "MiniMax-M2.7-highspeed",
    label: "MiniMax 2.7 highspeed",
  },
  {
    providerId: "minimax-m3",
    modelId: "MiniMax-M3",
    label: "MiniMax M3",
  },
] as const;

export interface DefaultProviderLike<TModel extends { id: string }> {
  provider: string;
  hasAuth?: boolean;
  models: TModel[];
}

export function pickDefaultProviderModel<TModel extends { id: string }>(
  providers: Array<DefaultProviderLike<TModel>>
): { providerId: string; modelId: string } {
  const authedProviders = providers.filter((provider) => provider.hasAuth);
  const candidates = authedProviders.length > 0 ? authedProviders : providers;
  const preferredProvider = candidates.find(
    (provider) =>
      provider.provider === DEFAULT_PROVIDER_ID &&
      provider.models.some((model) => model.id === DEFAULT_MODEL_ID)
  );
  const provider = preferredProvider ?? candidates[0];
  if (!provider) return { providerId: "", modelId: "" };
  const model =
    provider.models.find((item) => item.id === DEFAULT_MODEL_ID) ??
    provider.models[0];
  return { providerId: provider.provider, modelId: model?.id ?? "" };
}

export function pickDefaultFlatModel<TModel extends { provider: string; id: string }>(
  models: TModel[],
  authedProviders: Set<string>
): TModel | undefined {
  return (
    models.find(
      (model) =>
        model.provider === DEFAULT_PROVIDER_ID &&
        model.id === DEFAULT_MODEL_ID &&
        authedProviders.has(model.provider)
    ) ??
    models.find((model) => authedProviders.has(model.provider)) ??
    models[0]
  );
}

export function getCuratedModelLabel(
  providerId: string,
  modelId: string
): string | undefined {
  return CURATED_MODEL_OPTIONS.find(
    (option) => option.providerId === providerId && option.modelId === modelId
  )?.label;
}

export function curateProviderModels<
  TModel extends { id: string },
  TProvider extends DefaultProviderLike<TModel>,
>(providers: TProvider[]): TProvider[] {
  return CURATED_MODEL_OPTIONS.flatMap((option) => {
    const provider = providers.find((item) => item.provider === option.providerId);
    const model = provider?.models.find((item) => item.id === option.modelId);
    if (!provider || !model) return [];
    return [
      {
        ...provider,
        models: [{ ...model, name: option.label }],
      },
    ] as TProvider[];
  });
}

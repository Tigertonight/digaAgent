"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useProviderStatus } from "./useProviderStatus";
import type { ProviderInfo } from "@/lib/types";

export function normalizeProviderModelSelection(
  providers: ProviderInfo[],
  providerId: string,
  modelId: string,
  defaultProvider?: string
) {
  const provider =
    providers.find((p) => p.provider === providerId) ??
    providers.find((p) => p.provider === defaultProvider) ??
    providers[0];
  if (!provider) return { providerId: "", modelId: "" };

  const modelExists = provider.models.some((m) => m.id === modelId);
  return {
    providerId: provider.provider,
    modelId: modelExists ? modelId : (provider.models[0]?.id ?? ""),
  };
}

export function useProviderModel() {
  const { providers, reloadProviders: fetchProviders } = useProviderStatus();
  const [providerId, setProviderId] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setProviderId(localStorage.getItem("pi-provider-id") ?? "");
      setModelId(localStorage.getItem("pi-model-id") ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (providerId) localStorage.setItem("pi-provider-id", providerId);
    else localStorage.removeItem("pi-provider-id");
  }, [providerId]);

  useEffect(() => {
    if (modelId) localStorage.setItem("pi-model-id", modelId);
    else localStorage.removeItem("pi-model-id");
  }, [modelId]);

  const reloadProviders = useCallback(
    (applyDefaults: boolean) => {
      void fetchProviders()
        .then((data) => {
          if (!data?.providers || !applyDefaults) return;
          setProviderId((curProv) => {
            setModelId((curModel) => {
              return normalizeProviderModelSelection(
                data.providers,
                curProv,
                curModel,
                data.defaultProvider
              ).modelId;
            });
            return normalizeProviderModelSelection(
              data.providers,
              curProv,
              "",
              data.defaultProvider
            ).providerId;
          });
        })
        .catch((e) => console.warn("load providers failed", e));
    },
    [fetchProviders]
  );

  useEffect(() => {
    reloadProviders(true);
  }, [reloadProviders]);

  const currentProvider = useMemo(
    () => providers.find((p) => p.provider === providerId),
    [providers, providerId]
  );

  const visibleProviders = useMemo(
    () => providers.filter((p) => p.hasAuth),
    [providers]
  );

  return {
    providers,
    visibleProviders,
    currentProvider,
    providerId,
    setProviderId,
    modelId,
    setModelId,
    reloadProviders,
  };
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useProviderStatus } from "./useProviderStatus";
import type { ProviderInfo } from "@/lib/types";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_STORAGE_VERSION,
  DEFAULT_PROVIDER_ID,
} from "@/lib/default-model";

export function normalizeProviderModelSelection(
  providers: ProviderInfo[],
  providerId: string,
  modelId: string,
  defaultProvider = DEFAULT_PROVIDER_ID,
  defaultModel = DEFAULT_MODEL_ID
) {
  const provider =
    (providerId ? providers.find((p) => p.provider === providerId) : undefined) ??
    providers.find((p) => p.provider === defaultProvider) ??
    providers[0];
  if (!provider) return { providerId: "", modelId: "" };

  const modelExists = provider.models.some((m) => m.id === modelId);
  return {
    providerId: provider.provider,
    modelId: modelExists
      ? modelId
      : (provider.models.find((model) => model.id === defaultModel)?.id ??
        provider.models[0]?.id ??
        ""),
  };
}

export function useProviderModel() {
  const { providers, reloadProviders: fetchProviders } = useProviderStatus();
  const visibleProviders = useMemo(
    () =>
      providers.filter(
        (provider) => provider.hasAuth && provider.models.length > 0
      ),
    [providers]
  );
  const [providerId, setProviderId] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const storageVersion = localStorage.getItem("pi-model-default-version");
      if (storageVersion !== DEFAULT_MODEL_STORAGE_VERSION) {
        localStorage.removeItem("pi-provider-id");
        localStorage.removeItem("pi-model-id");
        localStorage.setItem(
          "pi-model-default-version",
          DEFAULT_MODEL_STORAGE_VERSION
        );
        setProviderId("");
        setModelId("");
        return;
      }
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
          const visible = data.providers.filter(
            (provider) => provider.hasAuth && provider.models.length > 0
          );
          setProviderId((curProv) => {
            setModelId((curModel) => {
              return normalizeProviderModelSelection(
                visible,
                curProv,
                curModel,
                data.defaultProvider,
                data.defaultModelId
              ).modelId;
            });
            return normalizeProviderModelSelection(
              visible,
              curProv,
              "",
              data.defaultProvider,
              data.defaultModelId
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
    () => visibleProviders.find((p) => p.provider === providerId),
    [visibleProviders, providerId]
  );

  return {
    providers: visibleProviders,
    visibleProviders,
    currentProvider,
    providerId,
    setProviderId,
    modelId,
    setModelId,
    reloadProviders,
  };
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useProviderStatus } from "./useProviderStatus";

export function useProviderModel() {
  const { providers, reloadProviders: fetchProviders } = useProviderStatus();
  const [providerId, setProviderId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("pi-provider-id") ?? "";
  });
  const [modelId, setModelId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("pi-model-id") ?? "";
  });

  useEffect(() => {
    if (providerId) localStorage.setItem("pi-provider-id", providerId);
  }, [providerId]);

  useEffect(() => {
    if (modelId) localStorage.setItem("pi-model-id", modelId);
  }, [modelId]);

  const reloadProviders = useCallback(
    (applyDefaults: boolean) => {
      void fetchProviders()
        .then((data) => {
          if (!data?.providers || !applyDefaults) return;
          setProviderId((curProv) => {
            setModelId((curModel) => {
              const provExists = data.providers.some(
                (p) => p.provider === (curProv || "")
              );
              const modelExists =
                provExists &&
                data.providers
                  .find((p) => p.provider === curProv)
                  ?.models?.some((m) => m.id === curModel);
              if (provExists && modelExists) return curModel;
              if (data.defaultModelId) return data.defaultModelId;
              return curModel;
            });
            const provExists = data.providers.some(
              (p) => p.provider === (curProv || "")
            );
            if (provExists) return curProv;
            if (data.defaultProvider) return data.defaultProvider;
            return curProv;
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

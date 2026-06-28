"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProviderStatus } from "./useProviderStatus";
import type { ProviderInfo } from "@/lib/types";
import type { ProvidersResponse } from "@/lib/types";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
} from "@/lib/default-model";

/**
 * 给定当前 providers 列表 + 用户上次选择，计算最终生效的 (providerId, modelId)。
 *
 * 优先级：
 *  1. 用户上次选过的 (providerId, modelId)，且 provider 在 visibleProviders 里
 *     且 modelId 仍存在 → 用它。
 *  2. 上次 provider 仍在但 modelId 不在 → 保留 provider，回到该 provider 下默认/首个 model。
 *  3. 上次 provider 不在了 → 用 server 给的 defaultProvider，再 fallback 第一个。
 *  4. 没人能用 → 返回空字符串。
 */
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

const LEGACY_PROVIDER_KEY = "pi-provider-id";
const LEGACY_MODEL_KEY = "pi-model-id";
const LEGACY_VERSION_KEY = "pi-model-default-version";

interface ServerLastModel {
  provider: string;
  modelId: string;
  updatedAt?: number;
}

async function fetchServerLastModel(): Promise<ServerLastModel | null> {
  try {
    const r = await fetch("/api/preferences/last-model", { cache: "no-store" });
    if (!r.ok) return null;
    const d = (await r.json()) as { lastModel?: ServerLastModel | null };
    return d.lastModel ?? null;
  } catch {
    return null;
  }
}

async function pushServerLastModel(provider: string, modelId: string): Promise<void> {
  if (!provider || !modelId) return;
  try {
    await fetch("/api/preferences/last-model", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastModel: { provider, modelId } }),
    });
  } catch {
    // best-effort；下一次切换还会再试
  }
}

/** 从 localStorage 读旧值（迁移用），保留兼容性。 */
function readLegacyLocal(): { provider: string; modelId: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const provider = window.localStorage.getItem(LEGACY_PROVIDER_KEY) ?? "";
    const modelId = window.localStorage.getItem(LEGACY_MODEL_KEY) ?? "";
    if (!provider || !modelId) return null;
    return { provider, modelId };
  } catch {
    return null;
  }
}

function clearLegacyLocal() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LEGACY_PROVIDER_KEY);
    window.localStorage.removeItem(LEGACY_MODEL_KEY);
    window.localStorage.removeItem(LEGACY_VERSION_KEY);
  } catch {
    /* ignore */
  }
}

function visibleProviderOptions(data?: ProvidersResponse | null): ProviderInfo[] {
  return (data?.providers ?? []).filter(
    (provider) => provider.hasAuth && provider.models.length > 0
  );
}

export function useProviderModel(initialProvidersData?: ProvidersResponse | null) {
  const { providers, reloadProviders: fetchProviders } = useProviderStatus({
    initialProvidersData,
  });
  const initialSelection = normalizeProviderModelSelection(
    visibleProviderOptions(initialProvidersData),
    "",
    "",
    initialProvidersData?.defaultProvider,
    initialProvidersData?.defaultModelId
  );
  const visibleProviders = useMemo(
    () =>
      providers.filter(
        (provider) => provider.hasAuth && provider.models.length > 0
      ),
    [providers]
  );
  const [providerId, setProviderId] = useState<string>(
    initialSelection.providerId
  );
  const [modelId, setModelId] = useState<string>(initialSelection.modelId);
  // hydration 信号：true 之后我们才允许“用户切换 → 写服务端”。
  // 避免 mount 期 setState (hydrate) 触发的 effect 把同样的值再写一次。
  const hydratedRef = useRef(false);
  // “normalize fallback” 是由 provider 不可见造成的被动退让，不是用户意愿。
  // 这种路径必须跳过“写服务端”，避免覆盖上次真实选择。
  const applyingFallbackRef = useRef(false);

  // mount 时一次性 hydrate：服务端 → 否则旧 localStorage migrate → 否则空。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fromServer = await fetchServerLastModel();
      if (cancelled) return;
      if (fromServer?.provider && fromServer?.modelId) {
        setProviderId(fromServer.provider);
        setModelId(fromServer.modelId);
        // 如果还有 legacy 值，顺便清掉（一次性迁移完成）。
        clearLegacyLocal();
        hydratedRef.current = true;
        return;
      }
      // 服务端无值 → 试旧 localStorage 一次性迁移。
      const legacy = readLegacyLocal();
      if (legacy) {
        setProviderId(legacy.provider);
        setModelId(legacy.modelId);
        // best-effort 写服务端 + 清 localStorage
        await pushServerLastModel(legacy.provider, legacy.modelId);
        clearLegacyLocal();
        hydratedRef.current = true;
        return;
      }
      // 啥都没有，等 reloadProviders(true) 拿 default。
      hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 用户切换 provider/model → 写服务端。仅 hydratedRef.current 为 true 之后写。
  // “normalize fallback” 路径（applyingFallbackRef）跳过，避免 provider 暂不可见
  // （keytar 未解锁 / 在重启 keytar / 用户退出某 provider）时覆盖上次真实选择。
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (applyingFallbackRef.current) {
      applyingFallbackRef.current = false;
      return;
    }
    if (!providerId || !modelId) return;
    void pushServerLastModel(providerId, modelId);
  }, [providerId, modelId]);

  const reloadProviders = useCallback(
    (applyDefaults: boolean) => {
      void fetchProviders()
        .then((data) => {
          if (!data?.providers || !applyDefaults) return;
          const visible = data.providers.filter(
            (provider) => provider.hasAuth && provider.models.length > 0
          );
          // 用户当前选中如果仍在 visible 里就保留；否则才走 default。
          // 注意：必须读最新状态，所以套一层 setProviderId(curProv => …)。
          // applyingFallbackRef 只在“真变”（provider/model 之一被裁减）时设 true，
          // 这样 effect 仅跳过该次 fallback，不影响后续用户主动切换。
          setProviderId((curProv) => {
            const normalizedProvider = normalizeProviderModelSelection(
              visible,
              curProv,
              "",
              data.defaultProvider,
              data.defaultModelId
            ).providerId;
            setModelId((curModel) => {
              const normalizedModel = normalizeProviderModelSelection(
                visible,
                curProv,
                curModel,
                data.defaultProvider,
                data.defaultModelId
              ).modelId;
              if (
                normalizedProvider !== curProv ||
                normalizedModel !== curModel
              ) {
                applyingFallbackRef.current = true;
              }
              return normalizedModel;
            });
            return normalizedProvider;
          });
        })
        .catch((e) => console.warn("load providers failed", e));
    },
    [fetchProviders]
  );

  // mount 时拉一次 providers；如果当前已经从服务端 hydrate 出 (provider, model)
  // 而它还在 visible 里，normalize 路径会 noop；不在 visible（key 失效 / 退出登录）
  // 才会被纠正到 default。
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

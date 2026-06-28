"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProvidersResponse } from "@/lib/types";
import { userFacingMessage } from "@/lib/user-facing-error";

export interface AuthProviderStatus {
  provider: string;
  displayName: string;
  hasAuth: boolean;
  credentialType: "api_key" | "oauth" | null;
  status: {
    configured: boolean;
    source?: string;
    label?: string;
  };
  supportsOAuth: boolean;
}

export interface AuthStatusResponse {
  providers: AuthProviderStatus[];
  oauthProviders: string[];
  authPath?: string;
  error?: string;
}

interface UseProviderStatusOptions {
  autoLoadProviders?: boolean;
  autoLoadAuth?: boolean;
  initialProvidersData?: ProvidersResponse | null;
}

export function useProviderStatus(
  opts: UseProviderStatusOptions = {}
) {
  const {
    autoLoadProviders = false,
    autoLoadAuth = false,
    initialProvidersData = null,
  } = opts;
  const [providersData, setProvidersData] =
    useState<ProvidersResponse | null>(initialProvidersData);
  const [authData, setAuthData] = useState<AuthStatusResponse | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const reloadProviders = useCallback(async () => {
    setProvidersLoading(true);
    setProvidersError(null);
    try {
      const fetchProviders = async (url: string) => {
        const r = await fetch(url, { cache: "no-store" });
        const data = (await r.json()) as ProvidersResponse & { error?: string };
        return { r, data };
      };
      const primary = await fetchProviders("/api/providers").catch(() => null);
      let { r, data } =
        primary ?? (await fetchProviders("/provider-status"));
      if (!r.ok || data.error) {
        const fallback = await fetchProviders("/provider-status").catch(
          () => null
        );
        if (fallback) {
          r = fallback.r;
          data = fallback.data;
        }
      }
      if (!r.ok || data.error) {
        const msg = data.error ?? `HTTP ${r.status}`;
        setProvidersError(userFacingMessage(msg));
        return null;
      }
      setProvidersData(data);
      return data;
    } catch (e) {
      setProvidersError(userFacingMessage(e));
      return null;
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  const reloadAuth = useCallback(async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const r = await fetch("/api/auth");
      const data = (await r.json()) as AuthStatusResponse;
      if (!r.ok || data.error) {
        const msg = data.error ?? `HTTP ${r.status}`;
        setAuthError(userFacingMessage(msg));
        return null;
      }
      setAuthData(data);
      return data;
    } catch (e) {
      setAuthError(userFacingMessage(e));
      return null;
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const reloadAll = useCallback(async () => {
    const [providers, auth] = await Promise.all([
      reloadProviders(),
      reloadAuth(),
    ]);
    return { providers, auth };
  }, [reloadAuth, reloadProviders]);

  useEffect(() => {
    let cancelled = false;
    if (autoLoadProviders) {
      queueMicrotask(() => {
        if (!cancelled) void reloadProviders();
      });
    }
    return () => {
      cancelled = true;
    };
  }, [autoLoadProviders, reloadProviders]);

  useEffect(() => {
    let cancelled = false;
    if (autoLoadAuth) {
      queueMicrotask(() => {
        if (!cancelled) void reloadAuth();
      });
    }
    return () => {
      cancelled = true;
    };
  }, [autoLoadAuth, reloadAuth]);

  return {
    providersData,
    providers: providersData?.providers ?? [],
    providersLoading,
    providersError,
    authData,
    authProviders: authData?.providers ?? [],
    authLoading,
    authError,
    reloadProviders,
    reloadAuth,
    reloadAll,
  };
}

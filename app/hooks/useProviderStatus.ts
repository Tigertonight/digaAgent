"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProvidersResponse } from "@/lib/types";

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
}

export function useProviderStatus(
  opts: UseProviderStatusOptions = {}
) {
  const { autoLoadProviders = false, autoLoadAuth = false } = opts;
  const [providersData, setProvidersData] =
    useState<ProvidersResponse | null>(null);
  const [authData, setAuthData] = useState<AuthStatusResponse | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const reloadProviders = useCallback(async () => {
    setProvidersLoading(true);
    setProvidersError(null);
    try {
      const r = await fetch("/api/providers");
      const data = (await r.json()) as ProvidersResponse & { error?: string };
      if (!r.ok || data.error) {
        const msg = data.error ?? `HTTP ${r.status}`;
        setProvidersError(msg);
        return null;
      }
      setProvidersData(data);
      return data;
    } catch (e) {
      const msg = String(e);
      setProvidersError(msg);
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
        setAuthError(msg);
        return null;
      }
      setAuthData(data);
      return data;
    } catch (e) {
      const msg = String(e);
      setAuthError(msg);
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
    if (autoLoadProviders) void reloadProviders();
  }, [autoLoadProviders, reloadProviders]);

  useEffect(() => {
    if (autoLoadAuth) void reloadAuth();
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

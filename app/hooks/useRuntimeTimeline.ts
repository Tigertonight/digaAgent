"use client";

import { useCallback, useEffect, useState } from "react";
import type { EvidenceRef } from "@/lib/evidence/types";
import type { RuntimeEvent } from "@/lib/runtime/events";
import { userFacingMessage } from "@/lib/user-facing-error";

export interface RuntimeTimelinePayload {
  events: RuntimeEvent[];
  evidence: EvidenceRef[];
}

export interface UseRuntimeTimelineOptions {
  agentId: string | null;
  browserId?: string | null;
  enabled: boolean;
}

export interface UseRuntimeTimelineResult {
  data: RuntimeTimelinePayload;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

const EMPTY_TIMELINE: RuntimeTimelinePayload = { events: [], evidence: [] };

export function useRuntimeTimeline({
  agentId,
  browserId,
  enabled,
}: UseRuntimeTimelineOptions): UseRuntimeTimelineResult {
  const [data, setData] = useState<RuntimeTimelinePayload>(EMPTY_TIMELINE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!agentId || !enabled) return;
    setLoading(true);
    setError(null);
    try {
      const suffix = browserId ? `&browserId=${encodeURIComponent(browserId)}` : "";
      const [eventsRes, evidenceRes] = await Promise.all([
        fetch(`/api/agent/${agentId}?action=runtime_events${suffix}`),
        fetch(`/api/agent/${agentId}?action=evidence${suffix}`),
      ]);
      if (!eventsRes.ok) throw new Error(`events HTTP ${eventsRes.status}`);
      if (!evidenceRes.ok) throw new Error(`evidence HTTP ${evidenceRes.status}`);
      const eventsJson = (await eventsRes.json()) as Partial<RuntimeTimelinePayload>;
      const evidenceJson = (await evidenceRes.json()) as Partial<RuntimeTimelinePayload>;
      setData({
        events: Array.isArray(eventsJson.events) ? eventsJson.events : [],
        evidence: Array.isArray(evidenceJson.evidence) ? evidenceJson.evidence : [],
      });
    } catch (e) {
      setError(userFacingMessage(e));
    } finally {
      setLoading(false);
    }
  }, [agentId, browserId, enabled]);

  useEffect(() => {
    if (!enabled || !agentId) {
      queueMicrotask(() => {
        setData(EMPTY_TIMELINE);
        setError(null);
        setLoading(false);
      });
      return;
    }
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, enabled, load]);

  return { data, loading, error, reload: load };
}

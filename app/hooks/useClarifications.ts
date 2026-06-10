"use client";

import { useCallback } from "react";
import type { ClarificationRequest } from "@/lib/clarification/types";
import { userFacingMessage } from "@/lib/user-facing-error";

export interface UseClarificationsOptions {
  agentId: string | null;
  onError?: (msg: string) => void;
}

export interface UseClarificationsReturn {
  choose: (requestId: string, selectedOptionId: string) => Promise<void>;
  respond: (requestId: string, customText: string) => Promise<void>;
  loadPending: () => Promise<ClarificationRequest[]>;
}

async function postClarification(
  agentId: string,
  body: {
    requestId: string;
    selectedOptionId?: string;
    customText?: string;
  },
  onError: ((m: string) => void) | undefined
): Promise<void> {
  try {
    const r = await fetch(`/api/agent/${agentId}/clarification`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      onError?.(userFacingMessage(text || `HTTP ${r.status}`));
    }
  } catch (e) {
    onError?.(userFacingMessage(e));
  }
}

export function useClarifications(
  opts: UseClarificationsOptions
): UseClarificationsReturn {
  const { agentId, onError } = opts;

  const loadPending = useCallback<UseClarificationsReturn["loadPending"]>(
    async () => {
      if (!agentId) return [];
      try {
        const r = await fetch(`/api/agent/${agentId}/clarification`);
        if (!r.ok) {
          const text = await r.text().catch(() => "");
          onError?.(userFacingMessage(text || `HTTP ${r.status}`));
          return [];
        }
        const d = (await r.json()) as {
          clarifications?: ClarificationRequest[];
        };
        return Array.isArray(d.clarifications) ? d.clarifications : [];
      } catch (e) {
        onError?.(userFacingMessage(e));
        return [];
      }
    },
    [agentId, onError]
  );

  const choose = useCallback<UseClarificationsReturn["choose"]>(
    async (requestId, selectedOptionId) => {
      if (!agentId) return;
      await postClarification(
        agentId,
        { requestId, selectedOptionId },
        onError
      );
    },
    [agentId, onError]
  );

  const respond = useCallback<UseClarificationsReturn["respond"]>(
    async (requestId, customText) => {
      if (!agentId) return;
      await postClarification(agentId, { requestId, customText }, onError);
    },
    [agentId, onError]
  );

  return { choose, respond, loadPending };
}

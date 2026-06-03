/**
 * 服务端 clarification pending store。
 *
 * Agent 调 ask_user 后会 await registerPendingClarification 返回的 promise。
 * 用户通过 /api/agent/[id]/clarification POST 选择后，resolveClarification
 * 唤醒该 promise，agent 再继续执行。
 */
import "server-only";
import type {
  ClarificationRequest,
  ClarificationResponse,
} from "./types";

interface PendingClarification {
  request: ClarificationRequest;
  resolve: (resp: ClarificationResponse) => void;
}

interface ClarificationStore {
  pending: Map<string, PendingClarification>;
}

const g = globalThis as unknown as {
  __miniPiClarification?: ClarificationStore;
};
if (!g.__miniPiClarification) {
  g.__miniPiClarification = { pending: new Map() };
}
const store = g.__miniPiClarification;

export function registerPendingClarification(
  req: ClarificationRequest
): Promise<ClarificationResponse> {
  const existing = store.pending.get(req.id);
  if (existing) {
    existing.resolve({ customText: "Previous clarification was replaced." });
    store.pending.delete(req.id);
  }

  return new Promise<ClarificationResponse>((resolve) => {
    store.pending.set(req.id, { request: req, resolve });
  });
}

export function resolveClarification(
  id: string,
  resp: ClarificationResponse
): boolean {
  const p = store.pending.get(id);
  if (!p) return false;
  store.pending.delete(id);
  p.resolve(resp);
  return true;
}

export function listPendingClarifications(
  agentId?: string
): ClarificationRequest[] {
  const items = Array.from(store.pending.values()).map((p) => p.request);
  if (!agentId) return items;
  return items.filter((req) => req.agentId === agentId);
}

export function clearAgentClarifications(agentId: string): void {
  for (const [id, p] of store.pending) {
    if (p.request.agentId !== agentId) continue;
    store.pending.delete(id);
    p.resolve({ customText: "Clarification was aborted." });
  }
}

export function __resetClarificationStoreForTest(): void {
  for (const p of store.pending.values()) {
    p.resolve({ customText: "Clarification store reset." });
  }
  store.pending.clear();
}

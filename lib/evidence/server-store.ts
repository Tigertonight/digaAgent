import type { EvidenceListFilter, EvidenceRef } from "./types";

interface EvidenceStore {
  byId: Map<string, EvidenceRef>;
}

const g = globalThis as unknown as { __digaAgentEvidenceStore?: EvidenceStore };
if (!g.__digaAgentEvidenceStore) {
  g.__digaAgentEvidenceStore = { byId: new Map() };
}
const store = g.__digaAgentEvidenceStore;

function matches(value: string | null | undefined, expected?: string | null): boolean {
  return expected === undefined || value === expected;
}

function compareEvidence(a: EvidenceRef, b: EvidenceRef): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

export function appendEvidence(evidence: EvidenceRef): EvidenceRef {
  const current = store.byId.get(evidence.id);
  const next = current ? { ...current, ...evidence } : evidence;
  store.byId.set(evidence.id, next);
  return next;
}

export function appendEvidenceMany(items: EvidenceRef[]): EvidenceRef[] {
  return items.map(appendEvidence);
}

export function getEvidence(id: string): EvidenceRef | null {
  return store.byId.get(id) ?? null;
}

export function listEvidence(filter: EvidenceListFilter = {}): EvidenceRef[] {
  return [...store.byId.values()]
    .filter((item) => {
      if (filter.kind !== undefined && item.kind !== filter.kind) return false;
      return (
        matches(item.sessionId, filter.sessionId) &&
        matches(item.agentId, filter.agentId) &&
        matches(item.browserId, filter.browserId) &&
        matches(item.taskId, filter.taskId) &&
        matches(item.workflowId, filter.workflowId)
      );
    })
    .sort(compareEvidence);
}

export function removeEvidence(id: string): boolean {
  return store.byId.delete(id);
}

export function __resetEvidenceStoreForTest(): void {
  store.byId.clear();
}

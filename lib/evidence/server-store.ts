import type { EvidenceListFilter, EvidenceRef } from "./types";

// fix-S3.b：容量上限。evidence 表同样在长会话下会肨胀。
const MAX_EVIDENCE = (() => {
  const raw = process.env.DIGA_AGENT_EVIDENCE_STORE_MAX;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50_000;
})();

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

// A4-1：O(1) 头部淘汰。Map 插入顺序 ≈ createdAt 顺序，evidence 纯作审计补充，
// 不需要严格按 createdAt 薄头。避免热路径全表 sort。
function enforceCapacity(): void {
  while (store.byId.size > MAX_EVIDENCE) {
    const firstKey = store.byId.keys().next().value;
    if (firstKey === undefined) return;
    store.byId.delete(firstKey);
  }
}

export function appendEvidence(evidence: EvidenceRef): EvidenceRef {
  const current = store.byId.get(evidence.id);
  const next = current ? { ...current, ...evidence } : evidence;
  store.byId.set(evidence.id, next);
  enforceCapacity();
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

/** dispose 某个 agent 时调用，清除名下所有 evidence。 */
export function disposeEvidenceForAgent(agentId: string): number {
  let cleared = 0;
  for (const [id, evidence] of store.byId) {
    if (evidence.agentId === agentId) {
      store.byId.delete(id);
      cleared += 1;
    }
  }
  return cleared;
}

export function __resetEvidenceStoreForTest(): void {
  store.byId.clear();
}

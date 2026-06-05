import type { RuntimeEvent, RuntimeEventListFilter } from "./events";

interface RuntimeEventStore {
  byId: Map<string, RuntimeEvent>;
}

const g = globalThis as unknown as { __miniPiRuntimeEventStore?: RuntimeEventStore };
if (!g.__miniPiRuntimeEventStore) {
  g.__miniPiRuntimeEventStore = { byId: new Map() };
}
const store = g.__miniPiRuntimeEventStore;

function matches(value: string | null | undefined, expected?: string | null): boolean {
  return expected === undefined || value === expected;
}

function compareEvents(a: RuntimeEvent, b: RuntimeEvent): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

export function appendRuntimeEvent<TPayload>(
  event: RuntimeEvent<TPayload>
): RuntimeEvent<TPayload> {
  const current = store.byId.get(event.id);
  const next = current ? { ...current, ...event } : event;
  store.byId.set(event.id, next as RuntimeEvent);
  return next;
}

export function getRuntimeEvent(id: string): RuntimeEvent | null {
  return store.byId.get(id) ?? null;
}

export function listRuntimeEvents(
  filter: RuntimeEventListFilter = {}
): RuntimeEvent[] {
  return [...store.byId.values()]
    .filter((event) => {
      if (filter.source !== undefined && event.source !== filter.source) {
        return false;
      }
      if (filter.status !== undefined && event.status !== filter.status) {
        return false;
      }
      return (
        matches(event.sessionId, filter.sessionId) &&
        matches(event.agentId, filter.agentId) &&
        matches(event.browserId, filter.browserId) &&
        matches(event.taskId, filter.taskId) &&
        matches(event.workflowId, filter.workflowId) &&
        matches(event.parentId, filter.parentId)
      );
    })
    .sort(compareEvents);
}

export function removeRuntimeEvent(id: string): boolean {
  return store.byId.delete(id);
}

export function __resetRuntimeEventStoreForTest(): void {
  store.byId.clear();
}

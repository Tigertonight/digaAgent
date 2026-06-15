import type { RuntimeEvent, RuntimeEventListFilter } from "./events";

// fix-S3.a：为 runtime event store 加容量上限，避免长期运行进程
// 无限增长；listRuntimeEvents 原本是 O(n) 扫全表，不加上限会越来越慢。
const MAX_EVENTS = (() => {
  const raw = process.env.DIGA_AGENT_RUNTIME_EVENT_STORE_MAX;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50_000;
})();

interface RuntimeEventStore {
  byId: Map<string, RuntimeEvent>;
}

const g = globalThis as unknown as { __digaAgentRuntimeEventStore?: RuntimeEventStore };
if (!g.__digaAgentRuntimeEventStore) {
  g.__digaAgentRuntimeEventStore = { byId: new Map() };
}
const store = g.__digaAgentRuntimeEventStore;

function matches(value: string | null | undefined, expected?: string | null): boolean {
  return expected === undefined || value === expected;
}

function compareEvents(a: RuntimeEvent, b: RuntimeEvent): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

/**
 * A4-1：超出容量时 O(1) 按 Map 插入顺序淘汰头部。
 *
 * 为什么可以不再 sort：
 *  - JS Map 保留插入顺序。
 *  - createdAt 是调用方填的，高频插入场景下与插入顺序一致。
 *  - runtime event 是审计 / UI 时间线，几毫秒级别的顺序偏差可接受。
 * 热路径从 O(N log N) 降为 O(1)，在容量上限附近高频写场景下节省 CPU。
 *
 * 同 id update 不会改变 Map 顺序（Map.set 同 key 是 update）——这是期望行为：
 * 同一事件被反复补充 status/payload 时，仍以首次插入位为序。
 */
function enforceCapacity(): void {
  while (store.byId.size > MAX_EVENTS) {
    // 拿头部 key。Map.keys().next() 是 O(1)。
    const firstKey = store.byId.keys().next().value;
    if (firstKey === undefined) return;
    store.byId.delete(firstKey);
  }
}

export function appendRuntimeEvent<TPayload>(
  event: RuntimeEvent<TPayload>
): RuntimeEvent<TPayload> {
  const current = store.byId.get(event.id);
  const next = current ? { ...current, ...event } : event;
  store.byId.set(event.id, next as RuntimeEvent);
  enforceCapacity();
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

/**
 * dispose 某个 agent 时调用，清除其名下所有 runtime event（fix-S3.a）。
 * 返回被清除的条数供调用方可选记日志。
 */
export function disposeRuntimeEventsForAgent(agentId: string): number {
  let cleared = 0;
  for (const [id, event] of store.byId) {
    if (event.agentId === agentId) {
      store.byId.delete(id);
      cleared += 1;
    }
  }
  return cleared;
}

export function __resetRuntimeEventStoreForTest(): void {
  store.byId.clear();
}

export const __MAX_EVENTS_FOR_TEST = MAX_EVENTS;

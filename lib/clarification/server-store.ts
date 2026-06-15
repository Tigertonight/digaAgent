/**
 * 服务端 clarification pending store。
 *
 * Agent 调 ask_user 后会 await registerPendingClarification 返回的 promise。
 * 用户通过 /api/agent/[id]/clarification POST 选择后，resolveClarification
 * 唤醒该 promise，agent 再继续执行。
 *
 * C1：pending request 在 register 时落盘到 ~/.diga-agent/clarifications/<id>.json，
 * resolve / abort 时删除。进程重启后，resolve promise 已经丢失，但磁盘上仍有
 * 元数据 → hydrate 时把它们当作 stale 处理：listPendingClarifications 会带上
 * stale=true 标志，前端可以禁用提交、提示用户重发任务。
 */
import "server-only";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ClarificationRequest,
  ClarificationResponse,
} from "./types";

interface PendingClarification {
  request: ClarificationRequest;
  resolve: (resp: ClarificationResponse) => void;
  /**
   * stale=true 表示这条 pending 是从磁盘 hydrate 出来的、属于上一次进程。
   * resolve promise 已经丢失，POST 答案到这种 id 应该返回 409 + stale 提示。
   */
  stale?: boolean;
}

interface ClarificationStore {
  pending: Map<string, PendingClarification>;
}

const g = globalThis as unknown as {
  __digaAgentClarification?: ClarificationStore;
};
if (!g.__digaAgentClarification) {
  g.__digaAgentClarification = { pending: new Map() };
}
const store = g.__digaAgentClarification;

let activeRoot: string | null = null;
let hydrated = false;

function getRoot(): string {
  return activeRoot ?? path.join(os.homedir(), ".diga-agent");
}

function clarificationsDir(): string {
  return path.join(getRoot(), "clarifications");
}

function safeFileName(id: string): string {
  // request id 形如 `${agentId}:${requestId}`；冒号在某些 FS 受限，这里用 `_` 替代。
  return id.replace(/[/\\:]/g, "_") + ".json";
}

function persistRequest(req: ClarificationRequest): void {
  try {
    mkdirSync(clarificationsDir(), { recursive: true });
    const fp = path.join(clarificationsDir(), safeFileName(req.id));
    writeFileSync(fp, JSON.stringify(req, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

function deletePersistedRequest(id: string): void {
  try {
    unlinkSync(path.join(clarificationsDir(), safeFileName(id)));
  } catch {
    // 不存在就忽略
  }
}

function sanitizeRequest(raw: unknown): ClarificationRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.id !== "string" || !src.id) return null;
  if (typeof src.agentId !== "string" || !src.agentId) return null;
  if (typeof src.requestId !== "string" || !src.requestId) return null;
  if (typeof src.title !== "string") return null;
  if (typeof src.question !== "string") return null;
  if (!Array.isArray(src.options)) return null;
  return src as unknown as ClarificationRequest;
}

function hydrateFromDisk(): void {
  if (hydrated) return;
  hydrated = true;
  const dir = clarificationsDir();
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      const req = sanitizeRequest(raw);
      if (!req) continue;
      // 进程重启 → promise 丢了，挂个 noop resolver，stale=true 让 POST 拒绝。
      store.pending.set(req.id, {
        request: req,
        resolve: () => {},
        stale: true,
      });
    } catch {
      // 损坏文件忽略
    }
  }
}

export function registerPendingClarification(
  req: ClarificationRequest
): Promise<ClarificationResponse> {
  hydrateFromDisk();
  const existing = store.pending.get(req.id);
  if (existing) {
    if (!existing.stale) {
      existing.resolve({ customText: "Previous clarification was replaced." });
    }
    store.pending.delete(req.id);
    deletePersistedRequest(req.id);
  }
  // 先持久化再注册 promise；这样进程刚进入 await 就崩，磁盘上也已留下记录。
  persistRequest(req);

  return new Promise<ClarificationResponse>((resolve) => {
    store.pending.set(req.id, { request: req, resolve });
  });
}

export function resolveClarification(
  id: string,
  resp: ClarificationResponse
): boolean {
  hydrateFromDisk();
  const p = store.pending.get(id);
  if (!p) return false;
  store.pending.delete(id);
  deletePersistedRequest(id);
  if (p.stale) {
    // stale 的 resolver 是 noop；提交到这里返回 false，让路由层提示用户。
    return false;
  }
  p.resolve(resp);
  return true;
}

export function listPendingClarifications(
  agentId?: string
): ClarificationRequest[] {
  hydrateFromDisk();
  const items = Array.from(store.pending.values()).map((p) => p.request);
  if (!agentId) return items;
  return items.filter((req) => req.agentId === agentId);
}

/**
 * C1：返回带 stale 标志的列表。stale 来自上一次进程，没有可恢复的 promise，
 * 前端应禁用提交并提示用户重新触发。
 */
export function listPendingClarificationsWithStatus(
  agentId?: string
): Array<{ request: ClarificationRequest; stale: boolean }> {
  hydrateFromDisk();
  const items = Array.from(store.pending.values()).map((p) => ({
    request: p.request,
    stale: p.stale === true,
  }));
  if (!agentId) return items;
  return items.filter((it) => it.request.agentId === agentId);
}

/**
 * C2：返回某个 clarificationId 下未处理的请求。有则调用方可以拿到
 * options 列表，并在 resolve 前检查 selectedOptionId 是否在该请求里。
 */
export function getPendingClarification(
  id: string
): ClarificationRequest | null {
  hydrateFromDisk();
  return store.pending.get(id)?.request ?? null;
}

export function clearAgentClarifications(agentId: string): void {
  hydrateFromDisk();
  for (const [id, p] of store.pending) {
    if (p.request.agentId !== agentId) continue;
    store.pending.delete(id);
    deletePersistedRequest(id);
    if (!p.stale) {
      p.resolve({ customText: "Clarification was aborted." });
    }
  }
}

/**
 * C1：清掉指定 agentId 的 stale clarification。
 */
export function clearStaleClarifications(agentId: string): number {
  hydrateFromDisk();
  let cleared = 0;
  for (const [id, p] of store.pending) {
    if (p.request.agentId !== agentId) continue;
    if (!p.stale) continue;
    store.pending.delete(id);
    deletePersistedRequest(id);
    cleared += 1;
  }
  return cleared;
}

/**
 * C1：进程启动后一次性清掉 所有 从磁盘 hydrate 出来的 stale 请求。
 * 这些请求的 promise 随上次进程一起被 GC，永远不会 resolve；不清会让
 * 前端收到 “还有 pending” 旧状态、点了才拿 409。
 */
export function clearAllStaleClarifications(): number {
  hydrateFromDisk();
  let cleared = 0;
  for (const [id, p] of store.pending) {
    if (!p.stale) continue;
    store.pending.delete(id);
    deletePersistedRequest(id);
    cleared += 1;
  }
  return cleared;
}

export function __setClarificationStoreRootForTest(root: string | null): void {
  activeRoot = root;
  hydrated = false;
  store.pending.clear();
}

export function __resetClarificationStoreForTest(): void {
  for (const p of store.pending.values()) {
    if (!p.stale) p.resolve({ customText: "Clarification store reset." });
  }
  store.pending.clear();
  hydrated = false;
}

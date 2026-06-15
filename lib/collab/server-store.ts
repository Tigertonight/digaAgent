/**
 * 服务端 collab 状态 store（RFC-2 Phase B3）。
 *
 * 职责：
 *   - 持有"待审批列表"——key 是 `${agentId}:${toolCallId}` 复合 id
 *   - 给 onApprovalNeeded 提供 `registerPendingApproval(req) -> Promise<ApprovalResponse>`
 *     handler 会 await 这个 promise，阻塞住 SDK 的 tool 执行
 *   - 给 POST /api/agent/[id]/approval 路由提供 `resolveApproval(id, resp)` 入口
 *
 * F-A6 持久化（参考 clarification 的 C1 设计）：
 *   - register 时把 ApprovalRequest 落盘到 ~/.diga-agent/approvals/<id>.json
 *   - resolve / abort 时删除磁盘文件
 *   - 启动期 hydrate 时把残留的 approvals 视为 stale：标记 stale=true，
 *     POST 答案到 stale id 直接返回 false（路由侧返回 409 stale 提示）
 *   - 进程启动后 clearAllStaleApprovals 一次清扫，避免 UI 看到永远点不动的卡片
 *
 * 为什么挂 globalThis：
 *   Next dev 模式下 module 被 hot-reload 时会丢 in-module state，
 *   同 agent-registry 一样用 globalThis.__digaAgentCollab 持久化，避免改个 UI 就丢所有 pending。
 *
 * R2 5min 超时：registerPendingApproval 里 setTimeout，到点按 defaultDecision 自动结算。
 * R5 多 session 并发：id 已含 agentId 前缀，所以同一个 toolCallId 在不同 session 不会撞。
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
  ApprovalRequest,
  ApprovalResponse,
} from "./types";

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

interface PendingApproval {
  request: ApprovalRequest;
  /** handler 在 await 的 promise 的 resolver。结算时调用，再清掉 map。 */
  resolve: (resp: ApprovalResponse) => void;
  /** setTimeout id；resolveApproval 时要 clear 掉，避免超时重复结算。 */
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * F-A6: stale=true 表示这条 pending 来自上一次进程，已经从磁盘 hydrate 出来。
   * resolve promise 已经丢失，POST 答案到这种 id 应该走"stale 失败"路径。
   */
  stale?: boolean;
}

interface CollabStore {
  /** key: ApprovalRequest.id */
  pending: Map<string, PendingApproval>;
  /**
   * 「本 session 不再问」记忆（B4）。
   */
  sessionRemember: Map<string, Set<string>>;
}

const g = globalThis as unknown as { __digaAgentCollab?: CollabStore };
if (!g.__digaAgentCollab) {
  g.__digaAgentCollab = { pending: new Map(), sessionRemember: new Map() };
}
const store = g.__digaAgentCollab!;
// 老进程升级兼容：旧 store 没 sessionRemember 字段时补上
if (!store.sessionRemember) store.sessionRemember = new Map();

let activeRoot: string | null = null;
let hydrated = false;

function getRoot(): string {
  return activeRoot ?? path.join(os.homedir(), ".diga-agent");
}

function approvalsDir(): string {
  return path.join(getRoot(), "approvals");
}

function safeFileName(id: string): string {
  return id.replace(/[/\\:]/g, "_") + ".json";
}

function persistRequest(req: ApprovalRequest): void {
  try {
    mkdirSync(approvalsDir(), { recursive: true });
    const fp = path.join(approvalsDir(), safeFileName(req.id));
    writeFileSync(fp, JSON.stringify(req, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

function deletePersistedRequest(id: string): void {
  try {
    unlinkSync(path.join(approvalsDir(), safeFileName(id)));
  } catch {
    // 不存在就忽略
  }
}

function sanitizeRequest(raw: unknown): ApprovalRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  if (typeof src.id !== "string" || !src.id) return null;
  if (typeof src.agentId !== "string" || !src.agentId) return null;
  if (typeof src.toolCallId !== "string" || !src.toolCallId) return null;
  if (typeof src.toolName !== "string") return null;
  if (typeof src.ruleId !== "string") return null;
  if (src.defaultDecision !== "allow" && src.defaultDecision !== "deny") {
    return null;
  }
  return src as unknown as ApprovalRequest;
}

function hydrateFromDisk(): void {
  if (hydrated) return;
  hydrated = true;
  const dir = approvalsDir();
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
        timer: null,
        stale: true,
      });
    } catch {
      // 损坏文件忽略
    }
  }
}

/**
 * 登记一次待审批请求，返回 promise——CollabExtension 的 onApprovalNeeded 会 await 它。
 */
export function registerPendingApproval(
  req: ApprovalRequest
): Promise<ApprovalResponse> {
  hydrateFromDisk();
  const existing = store.pending.get(req.id);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    if (!existing.stale) {
      existing.resolve({ decision: req.defaultDecision });
    }
    store.pending.delete(req.id);
    deletePersistedRequest(req.id);
  }
  // 先持久化再注册 promise；这样进程崩在 await 之前也已留下记录。
  persistRequest(req);

  return new Promise<ApprovalResponse>((resolve) => {
    const timer = setTimeout(() => {
      const p = store.pending.get(req.id);
      if (!p) return;
      store.pending.delete(req.id);
      deletePersistedRequest(req.id);
      // 超时按 defaultDecision 结算；CollabExtension 会据此 block 或 allow。
      p.resolve({ decision: req.defaultDecision });
    }, APPROVAL_TIMEOUT_MS);

    store.pending.set(req.id, {
      request: req,
      resolve,
      timer,
    });
  });
}

/**
 * 外部（HTTP 路由）来结算一个 pending approval。
 * @returns true 表示 resolve 成功；false 表示找不到（可能已超时、已被结算、或 stale）
 */
export function resolveApproval(
  id: string,
  resp: ApprovalResponse
): boolean {
  hydrateFromDisk();
  const p = store.pending.get(id);
  if (!p) return false;
  if (p.timer) clearTimeout(p.timer);
  store.pending.delete(id);
  deletePersistedRequest(id);
  if (p.stale) {
    // stale 的 resolver 是 noop；提交到这里返回 false，让路由层提示用户。
    return false;
  }
  p.resolve(resp);
  return true;
}

/**
 * 当前 pending approvals。包括 stale，UI 仍可以看到，但 POST 会失败。
 */
export function listPendingApprovals(agentId?: string): ApprovalRequest[] {
  hydrateFromDisk();
  const items = Array.from(store.pending.values()).map((p) => p.request);
  if (!agentId) return items;
  return items.filter((req) => req.agentId === agentId);
}

/** F-A6: 启动期一次性清扫从磁盘 hydrate 出来的 stale approval。 */
export function clearAllStaleApprovals(): number {
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

/* ===================== Session Remember (B4) ===================== */

export function addSessionRemember(agentId: string, ruleId: string): void {
  let set = store.sessionRemember.get(agentId);
  if (!set) {
    set = new Set();
    store.sessionRemember.set(agentId, set);
  }
  set.add(ruleId);
}

export function hasSessionRemember(agentId: string, ruleId: string): boolean {
  return store.sessionRemember.get(agentId)?.has(ruleId) ?? false;
}

export function clearSessionRemember(agentId: string): void {
  store.sessionRemember.delete(agentId);
}

/* ===================== Test support ===================== */

export function __setCollabStoreRootForTest(root: string | null): void {
  activeRoot = root;
  hydrated = false;
  for (const p of store.pending.values()) {
    if (p.timer) clearTimeout(p.timer);
  }
  store.pending.clear();
  store.sessionRemember.clear();
}

export function __resetCollabStoreForTest(): void {
  for (const p of store.pending.values()) {
    if (p.timer) clearTimeout(p.timer);
    if (!p.stale) p.resolve({ decision: "deny" });
  }
  store.pending.clear();
  store.sessionRemember.clear();
  hydrated = false;
}

export const APPROVAL_TIMEOUT_MS_EXPORT = APPROVAL_TIMEOUT_MS;

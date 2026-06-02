/**
 * 服务端 collab 状态 store（RFC-2 Phase B3）。
 *
 * 职责：
 *   - 持有"待审批列表"——key 是 `${agentId}:${toolCallId}` 复合 id
 *   - 给 onApprovalNeeded 提供 `registerPendingApproval(req) -> Promise<ApprovalResponse>`
 *     handler 会 await 这个 promise，阻塞住 SDK 的 tool 执行
 *   - 给 POST /api/agent/[id]/approval 路由提供 `resolveApproval(id, resp)` 入口
 *
 * 为什么挂 globalThis：
 *   Next dev 模式下 module 被 hot-reload 时会丢 in-module state，
 *   同 agent-registry 一样用 globalThis.__miniPiCollab 持久化，避免改个 UI 就丢所有 pending。
 *
 * R2 5min 超时：registerPendingApproval 里 setTimeout，到点按 defaultDecision 自动结算。
 * R5 多 session 并发：id 已含 agentId 前缀，所以同一个 toolCallId 在不同 session 不会撞。
 */
import "server-only";
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
  timer: ReturnType<typeof setTimeout>;
}

interface CollabStore {
  /** key: ApprovalRequest.id */
  pending: Map<string, PendingApproval>;
}

const g = globalThis as unknown as { __miniPiCollab?: CollabStore };
if (!g.__miniPiCollab) {
  g.__miniPiCollab = { pending: new Map() };
}
const store = g.__miniPiCollab!;

/**
 * 登记一次待审批请求，返回 promise——CollabExtension 的 onApprovalNeeded 会 await 它。
 *
 * 调用方（agent-registry）负责：
 *   - 在调用本函数之前/之后把 `approval_request` 事件推进 ring buffer（让 SSE 通知前端）
 *   - resolve 后把 `approval_resolved` 也推进 ring buffer（前端更新 bubble 状态）
 *
 * 本函数自身**不碰 ring buffer**，保持 store 纯净——它只管 pending map + 超时。
 */
export function registerPendingApproval(
  req: ApprovalRequest
): Promise<ApprovalResponse> {
  // 同 id 重复 register（理论上不应发生：toolCallId 全局唯一）—— 防御性处理：
  // 先 resolve 旧的（按 defaultDecision），让旧 handler 不卡死，然后覆盖。
  const existing = store.pending.get(req.id);
  if (existing) {
    clearTimeout(existing.timer);
    existing.resolve({ decision: req.defaultDecision });
    store.pending.delete(req.id);
  }

  return new Promise<ApprovalResponse>((resolve) => {
    const timer = setTimeout(() => {
      const p = store.pending.get(req.id);
      if (!p) return;
      store.pending.delete(req.id);
      // 超时按 defaultDecision 结算；CollabExtension 会据此 block 或 allow。
      // 注：本函数不推 approval_resolved 事件——超时由 agent-registry 在 onTimeout 里推
      // （需要 ring buffer 句柄，store 无法直接访问）。
      // → 这里改成只 resolve，agent-registry 在 await 完后统一推 resolved 事件。
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
 * @returns true 表示 resolve 成功；false 表示找不到（可能已超时或已被结算）
 */
export function resolveApproval(
  id: string,
  resp: ApprovalResponse
): boolean {
  const p = store.pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  store.pending.delete(id);
  p.resolve(resp);
  return true;
}

/** 调试用：当前所有 pending（不导出给生产逻辑使用）。 */
export function listPendingApprovals(): ApprovalRequest[] {
  return Array.from(store.pending.values()).map((p) => p.request);
}

/** 测试用：清空 store（生产 / dev runtime 不要调）。 */
export function __resetCollabStoreForTest(): void {
  for (const p of store.pending.values()) {
    clearTimeout(p.timer);
  }
  store.pending.clear();
}

export const APPROVAL_TIMEOUT_MS_EXPORT = APPROVAL_TIMEOUT_MS;

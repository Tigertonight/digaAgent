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
 *   同 agent-registry 一样用 globalThis.__digaAgentCollab 持久化，避免改个 UI 就丢所有 pending。
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
  /**
   * 「本 session 不再问」记忆（B4）。
   * key: agentId；value: 该 session 内被记忆 allow 的 ruleId 集合。
   *
   * 用法：CollabExtension 命中 ask 规则时先查 hasRemember；命中 → 直接 return allow，
   * 不再触发 onApprovalNeeded（即不弹气泡）。这样比"前端 auto-resolve"更彻底——
   * server 端真正不弹，省一次 round-trip。
   *
   * 生命周期：随 AgentSession 同寿命；disposeAgent 时由 agent-registry 调
   * clearRememberFor 主动清理（避免悬挂）。
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

/**
 * 当前 pending approvals。
 *
 * 不做持久化，只暴露进程内仍在 await 的审批请求。agentId 过滤用于页面刷新或多 tab
 * 恢复同一个 agent 的审批 UI，避免把其他 session 的气泡混进来。
 */
export function listPendingApprovals(agentId?: string): ApprovalRequest[] {
  const items = Array.from(store.pending.values()).map((p) => p.request);
  if (!agentId) return items;
  return items.filter((req) => req.agentId === agentId);
}

/* ===================== Session Remember (B4) ===================== */

/**
 * 标记某 session 内某 ruleId 允许"不再问"。
 * 下次同 session 内命中同 ruleId 时 CollabExtension 应直接放行。
 *
 * 由 POST /api/agent/[id]/approval 路由在收到 `remember: "this-session"`
 * + `decision: "allow"` 时调用。deny 路径不入此 set——deny 的"记忆"语义比较危险
 * （会变成"自动 deny"），Phase B 不实装；如需，Phase C 单独设计 deny-remember。
 */
export function addSessionRemember(agentId: string, ruleId: string): void {
  let set = store.sessionRemember.get(agentId);
  if (!set) {
    set = new Set();
    store.sessionRemember.set(agentId, set);
  }
  set.add(ruleId);
}

/** 查询某 session 是否已记忆某 ruleId。 */
export function hasSessionRemember(agentId: string, ruleId: string): boolean {
  return store.sessionRemember.get(agentId)?.has(ruleId) ?? false;
}

/** 清空某 session 的所有记忆（disposeAgent 时调）。 */
export function clearSessionRemember(agentId: string): void {
  store.sessionRemember.delete(agentId);
}

/** 测试用：清空 store（生产 / dev runtime 不要调）。 */
export function __resetCollabStoreForTest(): void {
  for (const p of store.pending.values()) {
    clearTimeout(p.timer);
  }
  store.pending.clear();
  store.sessionRemember.clear();
}

export const APPROVAL_TIMEOUT_MS_EXPORT = APPROVAL_TIMEOUT_MS;

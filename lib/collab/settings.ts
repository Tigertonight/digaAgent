/**
 * Collab 全局偏好（RFC-2 Phase B4）。
 *
 * 范围：localStorage 持久化的"全局总开关"——纯 client 控制。
 *
 * 设计取舍：
 *   - settings 不入 server 端 store，前端是唯一真相。
 *     server 端 onApprovalNeeded 一律弹气泡；前端 SSE 收到 approval_request 时
 *     若总开关 disabled 就立即 auto-allow 把它走完，气泡可视化或不可视化由 UI 决定。
 *   - 这与 budget 的 globalSettings 不同（budget 的限制要 server 端真生效；
 *     collab 的总开关是"用户的逃生舱"，server 端被"绕过"是 acceptable）。
 *   - 为什么不做 server 端 settings：避免引入额外 PUT 路由 + 双源同步，
 *     B4 是 0.4d 预算 sharp edges 补丁，不是新架构。
 *
 * 与 session remember 的区别：
 *   - settings = 全局总开关，纯 client，影响所有 session。
 *   - session remember = 单 session 单规则记忆，server 端持久（dispose 时清空）。
 *
 * 注：不打 "client-only" 标记——纯 helper，server 端 import 类型时不应触发 boundary。
 *      safeStorage() 在 Node 时返回 null，所有写操作幂等失败，调用方无感。
 */
import type { ApprovalRule } from "./types";

const STORAGE_KEY = "pi-collab";

/** 本地持久化的 collab 偏好。 */
export interface CollabSettings {
  /**
   * 总开关——关闭时所有 ask 规则在前端被自动 allow。
   * 默认开启（safe by default）。
   */
  enabled: boolean;
}

export const DEFAULT_COLLAB_SETTINGS: CollabSettings = {
  enabled: true,
};

/** SSR / 隐私模式安全的 localStorage 访问。 */
function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 规范化字段——容错版本演进 / 用户手改。 */
function normalize(raw: unknown): CollabSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_COLLAB_SETTINGS };
  const o = raw as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : true,
  };
}

/** 读全局 settings；读不到 / 解析失败 → 回退 DEFAULT。 */
export function loadCollabSettings(): CollabSettings {
  const s = safeStorage();
  if (!s) return { ...DEFAULT_COLLAB_SETTINGS };
  const raw = s.getItem(STORAGE_KEY);
  if (!raw) return { ...DEFAULT_COLLAB_SETTINGS };
  try {
    return normalize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_COLLAB_SETTINGS };
  }
}

/** 写全局 settings。 */
export function saveCollabSettings(settings: CollabSettings): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(normalize(settings)));
  } catch {
    /* quota / 隐私模式 → 静默忽略 */
  }
}

/**
 * 内部工具：把 ApprovalRule 数组按"被记忆"过滤——B4 用不到（server 端处理），
 * 留给未来 client 侧调试或 Phase C 跨 session 学习时复用。
 */
export function rulesExcluding(
  rules: ApprovalRule[],
  rememberedRuleIds: Set<string>
): ApprovalRule[] {
  return rules.filter((r) => !rememberedRuleIds.has(r.id));
}

/** 测试用 key 暴露（vitest 不导）。 */
export const COLLAB_STORAGE_KEY = STORAGE_KEY;

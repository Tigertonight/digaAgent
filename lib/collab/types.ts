/**
 * RFC-2 Phase B collab 模块共享类型。
 *
 * 设计要点：
 * - ApprovalRequest/Response 是 server↔client 跨边界数据，必须可序列化（纯 JSON）。
 * - ToolCallMatcher 是规则匹配的纯描述，不含函数；规则可未来从 JSON 文件加载。
 * - B 阶段先做 allow/deny 二元决策；modify（编辑参数后放行）留 Phase C，
 *   届时在 ApprovalResponse 上加 modifiedInput 字段即可平滑扩展。
 */

/** 用户对一次审批请求的决策。 */
export type ApprovalDecision = "allow" | "deny";

/**
 * 自定义 SSE 事件——通过 agent ring buffer 推到前端。
 * 不在 SDK 的 AgentSessionEvent union 里，前端 useAgentEvents 单独识别 type。
 *
 * 时序：
 *   1. tool_call handler 命中 ask 规则 → registerPendingApproval
 *   2. server 在 ring buffer push `approval_request` → SSE → 前端弹气泡
 *   3. 用户点 Allow/Deny → POST /api/agent/[id]/approval → resolve handler 的 promise
 *   4. server 在 ring buffer push `approval_resolved` → SSE → 前端更新气泡状态
 *   5. handler return → SDK 真执行 tool（或 block） → tool_execution_start 跟上来
 */
export interface ApprovalRequestEvent {
  type: "approval_request";
  request: ApprovalRequest;
}

export interface ApprovalResolvedEvent {
  type: "approval_resolved";
  /** ApprovalRequest.id（即 `${agentId}:${toolCallId}`） */
  id: string;
  toolCallId: string;
  decision: ApprovalDecision;
  /** "user" = 显式点了；"timeout" = 5min 没人理；"default" = 未来扩展（如 remember） */
  resolvedBy: "user" | "timeout" | "default";
  denyReason?: string;
}

/**
 * 一次待审批的工具调用请求。
 * id 取 `${agentId}:${toolCallId}` 复合 key 满足多 session 并发（RFC §5 R5）。
 */
export interface ApprovalRequest {
  /** `${agentId}:${toolCallId}`，前后端共识 key。 */
  id: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  /** 工具入参快照（matcher 可能基于此触发；前端展示也用此）。 */
  input: Record<string, unknown>;
  /** 为什么需要审批：rule = 命中预置规则；manual = 未来手动 ask（保留扩展位）。 */
  reason: "rule" | "manual";
  /** 触发规则的 id（reason === "rule" 时必填）。 */
  ruleId?: string;
  /**
   * 默认决策：超时 / 关掉窗口时按此结算。
   * 默认 deny，确保"不点 = 不放行"的安全语义。
   */
  defaultDecision: ApprovalDecision;
  /** Unix ms。用于超时判定 + UI 排序。 */
  createdAt: number;
}

/** 用户审批后的响应。 */
export interface ApprovalResponse {
  decision: ApprovalDecision;
  /** deny 时给 agent 看的人话原因；undefined 用规则的 denyReason 兜底。 */
  denyReason?: string;
  /**
   * 记忆策略（B4 实装）：
   * - "this-session": 本 session 内同 (toolName, ruleId) 不再问
   * - undefined: 只这次
   */
  remember?: "this-session";
}

/**
 * 工具调用匹配器。所有字段都是 AND 关系；任一字段 undefined 则跳过该检查。
 * 空 matcher `{}` 匹配任意 tool_call。
 */
export interface ToolCallMatcher {
  /** 匹配的工具名（单值或数组）。undefined = 不限制工具名。 */
  toolName?: string | string[];
  /**
   * 对 tool input 的字段级匹配。key 是 input 字段名，value 是该字段的约束。
   * 同一字段下 contains 与 regex 也是 AND；多字段之间 AND。
   * 不存在的字段或非 string 值 → 该字段不匹配 → 整条规则不命中。
   */
  inputMatch?: Record<string, { contains?: string[]; regex?: string }>;
}

/** 一条审批规则。 */
export interface ApprovalRule {
  /** 全局唯一 id，用于 remember / 日志归因。 */
  id: string;
  /** 人话名字（UI 展示用）。 */
  name: string;
  /** 命中条件。 */
  match: ToolCallMatcher;
  /**
   * 命中后行为：
   * - "ask": 弹审批气泡，等用户决策
   * - "auto-allow": 静默放行（用于"白名单"模式扩展）
   * - "auto-deny": 直接 block，不打扰用户
   */
  on: "ask" | "auto-allow" | "auto-deny";
  /** auto-deny 或用户 deny 未提供 denyReason 时的兜底原因。 */
  denyReason?: string;
}

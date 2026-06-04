/**
 * Clarification & Suggested Actions 共享类型。
 *
 * 这条链路用于 agent 主动请求用户确认下一步，并提供可点击选项。
 * 它和 approval 的区别：
 * - approval = 工具授权，用户决定是否允许某个 tool call
 * - clarification = 路径/需求确认，用户决定 agent 接下来怎么做
 */

export interface ClarificationRequestEvent {
  type: "clarification_request";
  request: ClarificationRequest;
}

export interface ClarificationResolvedEvent {
  type: "clarification_resolved";
  id: string;
  requestId: string;
  selectedOptionId?: string;
  customText?: string;
  resolvedBy: "user" | "abort";
}

export interface ClarificationRequest {
  /** `${agentId}:${requestId}`，前后端共识 key。 */
  id: string;
  agentId: string;
  /** ask_user 工具调用 id，或 server 生成的请求 id。 */
  requestId: string;
  title: string;
  question: string;
  context?: string;
  options: ClarificationOption[];
  recommendedOptionId?: string;
  createdAt: number;
  /**
   * Multi-agent attribution (cowork). When a child subagent raises the
   * clarification, the request is surfaced on the PARENT's channel (so the user
   * sees it), but these fields record which child/task it actually came from.
   * Undefined for a normal main-agent clarification.
   */
  originAgentId?: string;
  taskId?: string;
  taskTitle?: string;
}

export interface ClarificationOption {
  id: string;
  label: string;
  description?: string;
  /** 回传给 agent 的自然语言选择说明。 */
  value: string;
}

export interface ClarificationResponse {
  selectedOptionId?: string;
  customText?: string;
}

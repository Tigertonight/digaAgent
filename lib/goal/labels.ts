import type {
  AgentGoal,
  GoalAcceptanceCriterion,
  GoalBlockedCategory,
  GoalStatus,
  GoalTurn,
} from "./types";

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  active: "进行中",
  paused: "已暂停",
  complete: "已完成",
  blocked: "已阻塞",
};

export const GOAL_TURN_STATUS_LABELS: Record<GoalTurn["status"], string> = {
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  blocked: "已阻塞",
};

export const GOAL_BLOCKED_CATEGORY_LABELS: Record<GoalBlockedCategory, string> = {
  needs_user: "等待用户输入",
  needs_approval: "等待用户确认",
  tool_error: "工具错误",
  external_dependency: "外部依赖",
  policy: "策略限制",
  merge_conflict: "合并冲突",
  unknown: "未知原因",
};

export const GOAL_ACCEPTANCE_STATUS_LABELS: Record<
  GoalAcceptanceCriterion["status"],
  string
> = {
  pending: "待验证",
  met: "已通过",
  failed: "未通过",
};

export function goalStatusLabel(goal: Pick<AgentGoal, "status">): string {
  return GOAL_STATUS_LABELS[goal.status] ?? goal.status;
}

export function goalAcceptanceSummary(
  criteria: GoalAcceptanceCriterion[] | undefined
): string {
  if (!criteria?.length) return "未定义验收标准";
  const met = criteria.filter((item) => item.status === "met").length;
  return `已通过 ${met}/${criteria.length}`;
}

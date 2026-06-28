import type { MessagePart } from "@/lib/types";

/**
 * Subagent / Workflow / Agent Team 运行卡片的纯状态/角色标签映射。
 *
 * 从 MessageView.tsx（3600+ 行）下沉而来：这些是无 JSX、无副作用的字符串
 * 映射，集中到此处便于复用（desktop/mobile 卡片共享）并直接单测，同时为后续
 * 把三个卡片组件物理抽到 app/components/runs/ 打基础。
 */

export function workflowStatusLabel(
  status: Extract<MessagePart, { kind: "workflow_run" }>["status"]
): string {
  if (status === "pending") return "排队中";
  if (status === "running") return "执行中";
  if (status === "completed") return "已完成";
  if (status === "completed_with_warnings") return "已完成，有提醒";
  if (status === "needs_continue") return "需要继续";
  if (status === "failed") return "失败";
  if (status === "aborted") return "已中止";
  return status;
}

export function agentTeamMemberLabel(name: string | undefined): string {
  if (!name) return "成员";
  if (name === "Lead") return "负责人";
  if (name === "Research") return "资料员";
  if (name === "Critic") return "质疑者";
  if (name === "Synthesis") return "整理者";
  if (name === "Validation") return "验收员";
  if (name === "Builder") return "执行者";
  if (name === "Scout") return "探索者";
  return name;
}

export function agentTeamStatusLabel(status: string): string {
  if (status === "draft") return "待确认";
  if (status === "running") return "协作中";
  if (status === "paused") return "已暂停";
  if (status === "finalizing") return "综合中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "aborted") return "已中止";
  return status;
}

export function agentTeamLeadStateLabel(state: string): string {
  if (state === "exploring") return "处理中";
  if (state === "needs_decision") return "需要确认";
  if (state === "ready_to_synthesize") return "可综合";
  if (state === "finalized") return "已综合";
  return state;
}

export function subagentRoleLabel(role: string | undefined): string {
  if (role === "rag") return "知识库";
  if (role === "research") return "研究";
  if (role === "code-review") return "审计";
  if (role === "implementation") return "实现";
  if (role === "general") return "通用";
  return "通用";
}

export function subagentStatusLabel(status: string): string {
  if (status === "completed") return "已完成";
  if (status === "running") return "执行中";
  if (status === "pending") return "排队中";
  if (status === "failed") return "失败";
  if (status === "aborted") return "已中止";
  if (status === "timeout") return "已超时";
  return status;
}

import type { MessagePart } from "@/lib/types";

export type ToolStatus = Extract<MessagePart, { kind: "tool" }>["status"];

export const TOOL_STATUS_LABELS: Record<ToolStatus, string> = {
  queued: "排队中",
  running: "执行中",
  done: "已完成",
  error: "执行失败",
  timeout: "已超时",
  cancelled: "已取消",
};

export function toolStatusLabel(status: ToolStatus): string {
  return TOOL_STATUS_LABELS[status] ?? status;
}

export function toolPhasePrefix(status: ToolStatus): string {
  switch (status) {
    case "queued":
      return "等待执行：";
    case "running":
      return "正在";
    case "done":
      return "已完成：";
    case "error":
      return "执行失败：";
    case "timeout":
      return "已超时：";
    case "cancelled":
      return "已取消：";
    default:
      return "";
  }
}

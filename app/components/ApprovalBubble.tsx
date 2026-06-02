"use client";

/**
 * ApprovalBubble —— 工具审批气泡（RFC-2 Phase B3）。
 *
 * 出现在 chat 流里，作为 assistant message 的一个 part（kind: "approval"）。
 *
 * 三种 status：
 *   - pending  → 展示规则原因 + 命令预览 + Allow/Deny 按钮 + 倒计时
 *   - allowed  → 折叠成一行 "✓ 已允许（user/timeout）"
 *   - denied   → 折叠成一行 "× 已拒绝（user/timeout）" + denyReason
 *
 * 设计选择（与已有 ToolRender 视觉一致）：
 *   - 圆角面板，左侧细竖条（pending=黄，allowed=绿，denied=红）
 *   - 命令字段就地展开 input 的关键字段（bash → command；其他 → JSON 摘要）
 *   - 按钮：Allow 是 accent 色，Deny 是 outlined；按 Esc/Enter 等键盘交互留 Phase C
 *
 * 不在本组件内的职责：
 *   - HTTP 提交 → useApprovals.approve/deny
 *   - 乐观更新 → 也走 useApprovals
 *   - 本组件只是「显示 + 触发回调」，纯展示+事件转发
 */

import { memo, useEffect, useState } from "react";
import { Check, ShieldAlert, X } from "lucide-react";
import type { MessagePart } from "@/lib/types";

type ApprovalPart = Extract<MessagePart, { kind: "approval" }>;

export interface ApprovalBubbleProps {
  part: ApprovalPart;
  /** 用户点 Allow；外层 hook 负责 POST + 乐观更新 */
  onApprove?: (toolCallId: string) => void;
  /** 用户点 Deny；外层 hook 负责 POST + 乐观更新；denyReason 暂留 undefined（Phase C 加输入框） */
  onDeny?: (toolCallId: string) => void;
}

/** 取出 input 里最值得展示给用户判断的"主体字段"。bash → command，其他 → 整体 JSON 截断。 */
function previewInput(
  toolName: string,
  input: Record<string, unknown>
): string {
  if (toolName === "bash" && typeof input.command === "string") {
    return input.command;
  }
  if (toolName === "write" && typeof input.path === "string") {
    return String(input.path);
  }
  if (toolName === "edit" && typeof input.path === "string") {
    return String(input.path);
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return "[unserializable input]";
  }
}

/** 5 分钟倒计时，pending 时展示。到 0 不强行隐藏（server 那边会自动 timeout 推 resolved）。 */
function useCountdown(createdAt: number, totalMs: number): string {
  const [left, setLeft] = useState(() =>
    Math.max(0, createdAt + totalMs - Date.now())
  );
  useEffect(() => {
    const id = setInterval(() => {
      setLeft(Math.max(0, createdAt + totalMs - Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [createdAt, totalMs]);
  const sec = Math.ceil(left / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export const ApprovalBubble = memo(function ApprovalBubble({
  part,
  onApprove,
  onDeny,
}: ApprovalBubbleProps) {
  const countdown = useCountdown(part.createdAt, APPROVAL_TIMEOUT_MS);
  const preview = previewInput(part.toolName, part.input);

  if (part.status === "allowed") {
    return (
      <div
        className="rounded-md px-3 py-1.5 text-xs inline-flex items-center gap-2"
        style={{
          background: "var(--bg-panel-2)",
          color: "var(--text-muted)",
          borderLeft: "3px solid #9bc53d",
        }}
      >
        <Check size={12} style={{ color: "#9bc53d" }} />
        <span>
          已允许 {part.toolName}
          {part.resolvedBy === "timeout" && "（超时默认）"}
        </span>
      </div>
    );
  }

  if (part.status === "denied") {
    return (
      <div
        className="rounded-md px-3 py-1.5 text-xs"
        style={{
          background: "var(--bg-panel-2)",
          color: "var(--text-muted)",
          borderLeft: "3px solid #e01a4f",
        }}
      >
        <div className="inline-flex items-center gap-2">
          <X size={12} style={{ color: "#e01a4f" }} />
          <span>
            已拒绝 {part.toolName}
            {part.resolvedBy === "timeout" && "（超时默认）"}
          </span>
        </div>
        {part.denyReason && (
          <div
            className="mt-1 ml-5 text-[11px]"
            style={{ color: "var(--text-dim)" }}
          >
            {part.denyReason}
          </div>
        )}
      </div>
    );
  }

  // pending
  return (
    <div
      className="rounded-md p-3 text-sm space-y-2"
      style={{
        background: "var(--bg-panel-2)",
        borderLeft: "3px solid #f9c22e",
      }}
    >
      <div
        className="flex items-center gap-2 text-xs"
        style={{ color: "var(--text-muted)" }}
      >
        <ShieldAlert size={13} style={{ color: "#f9c22e" }} />
        <span>
          需要确认：{part.toolName}
          {part.ruleId && (
            <span
              className="ml-1"
              style={{ color: "var(--fg-faint)" }}
            >
              ({part.ruleId})
            </span>
          )}
        </span>
        <span
          className="ml-auto tabular-nums text-[11px]"
          style={{ color: "var(--fg-faint)" }}
          title="审批超时时间——超过自动按默认决策（deny）结算"
        >
          {countdown}
        </span>
      </div>
      <pre
        className="text-xs px-2 py-1.5 rounded whitespace-pre-wrap break-all"
        style={{
          background: "var(--bg-panel)",
          color: "var(--text)",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          maxHeight: 160,
          overflow: "auto",
        }}
      >
        {preview}
      </pre>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onDeny?.(part.toolCallId)}
          className="px-2.5 py-1 rounded text-xs border hover:opacity-80"
          style={{
            borderColor: "var(--border)",
            color: "var(--fg)",
          }}
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => onApprove?.(part.toolCallId)}
          className="px-2.5 py-1 rounded text-xs text-white hover:opacity-90"
          style={{ background: "var(--accent)" }}
        >
          Allow
        </button>
      </div>
    </div>
  );
});

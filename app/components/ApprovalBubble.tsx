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
import { Check, GitMerge, ShieldAlert, X } from "lucide-react";
import type { MessagePart } from "@/lib/types";

type ApprovalPart = Extract<MessagePart, { kind: "approval" }>;

/** Allow 时可选的 remember 行为（B4）。 */
export interface ApproveCallOpts {
  remember?: "this-session";
  ruleId?: string;
}

export interface ApprovalBubbleProps {
  part: ApprovalPart;
  /** 用户点 Allow；外层 hook 负责 POST。opts.remember 传 "this-session" 表示本会话不再问。 */
  onApprove?: (toolCallId: string, opts?: ApproveCallOpts) => void;
  /** 用户点 Deny；外层 hook 负责 POST。 */
  onDeny?: (toolCallId: string, denyReason?: string) => void;
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
  if (toolName === "workflow:merge_worktree") {
    const stat = typeof input.stat === "string" ? input.stat.trim() : "";
    const diffPreview =
      typeof input.diffPreview === "string" ? input.diffPreview.trim() : "";
    const truncated = input.truncated ? "\n\n[diff preview truncated]" : "";
    return [stat, diffPreview].filter(Boolean).join("\n\n") + truncated;
  }
  if (toolName === "workflow:fetch_url") {
    const lines = [
      `${String(input.method ?? "GET")} ${String(input.url ?? "")}`,
      Array.isArray(input.headerNames) && input.headerNames.length
        ? `Headers: ${input.headerNames.join(", ")}`
        : "",
      input.maxBytes ? `Max bytes: ${String(input.maxBytes)}` : "",
      input.bodyPreview ? `Body preview:\n${String(input.bodyPreview)}` : "",
      input.bodyTruncated ? "[body preview truncated]" : "",
    ].filter(Boolean);
    return lines.join("\n");
  }
  try {
    const s = JSON.stringify(input);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return "[unserializable input]";
  }
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function MergeWorktreePreview({ input }: { input: Record<string, unknown> }) {
  const worktree =
    input.worktree && typeof input.worktree === "object"
      ? (input.worktree as Record<string, unknown>)
      : {};
  const stat = textValue(input.stat).trim();
  const diffPreview = textValue(input.diffPreview).trim();
  return (
    <div className="space-y-2">
      <div
        className="rounded border px-2 py-1.5 text-token-xs"
        style={{
          borderColor: "var(--border)",
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
        }}
      >
        <div className="flex items-center gap-1.5 font-medium" style={{ color: "var(--text)" }}>
          <GitMerge size={12} />
          Apply isolated worktree patch
        </div>
        <div className="mt-1 grid gap-1">
          {textValue(worktree.branchName) ? (
            <div className="truncate">Branch: {textValue(worktree.branchName)}</div>
          ) : null}
          {textValue(worktree.baseRef) ? (
            <div className="truncate">Base: {textValue(worktree.baseRef)}</div>
          ) : null}
          {textValue(worktree.path) ? (
            <div className="truncate" title={textValue(worktree.path)}>
              Path: {textValue(worktree.path)}
            </div>
          ) : null}
        </div>
      </div>
      {stat ? (
        <pre
          className="text-xs px-2 py-1.5 rounded whitespace-pre-wrap"
          style={{
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            maxHeight: 100,
            overflow: "auto",
          }}
        >
          {stat}
        </pre>
      ) : null}
      {diffPreview ? (
        <details>
          <summary
            className="cursor-pointer text-token-xs"
            style={{ color: "var(--text-muted)" }}
          >
            Diff preview
            {input.truncated ? " (truncated)" : ""}
          </summary>
          <pre
            className="mt-1 text-xs px-2 py-1.5 rounded whitespace-pre-wrap break-all"
            style={{
              background: "var(--bg-panel)",
              color: "var(--text)",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              maxHeight: 220,
              overflow: "auto",
            }}
          >
            {diffPreview}
            {input.truncated ? "\n\n[diff preview truncated]" : ""}
          </pre>
        </details>
      ) : null}
    </div>
  );
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
  /**
   * B4：「本会话不再问」勾选框。
   * 只在有 ruleId 时显示——没有 ruleId 时 server 端 addSessionRemember 无 key 可写。
   * 仅影响 Allow 路径；Deny 不提供 remember（避免危险的"自动 deny"语义，留 Phase C）。
   */
  const [rememberThisSession, setRememberThisSession] = useState(false);

  if (part.status === "allowed") {
    return (
      <div
        className="rounded-md px-3 py-1.5 text-xs inline-flex items-center gap-2"
        style={{
          background: "var(--bg-panel-2)",
          color: "var(--text-muted)",
          borderLeft: "3px solid var(--color-success)",
        }}
      >
        <Check size={12} style={{ color: "var(--color-success)" }} />
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
          borderLeft: "3px solid var(--color-danger)",
        }}
      >
        <div className="inline-flex items-center gap-2">
          <X size={12} style={{ color: "var(--color-danger)" }} />
          <span>
            已拒绝 {part.toolName}
            {part.resolvedBy === "timeout" && "（超时默认）"}
          </span>
        </div>
        {part.denyReason && (
          <div
            className="mt-1 ml-5 text-token-xs"
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
        borderLeft: "3px solid var(--color-warning)",
      }}
    >
      <div
        className="flex items-center gap-2 text-xs"
        style={{ color: "var(--text-muted)" }}
      >
        <ShieldAlert size={13} style={{ color: "var(--color-warning)" }} />
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
          className="ml-auto tabular-nums text-token-xs"
          style={{ color: "var(--fg-faint)" }}
          title="审批超时时间——超过自动按默认决策（deny）结算"
        >
          {countdown}
        </span>
      </div>
      {part.toolName === "workflow:merge_worktree" ? (
        <MergeWorktreePreview input={part.input} />
      ) : (
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
      )}
      <div className="flex items-center justify-between gap-2">
        {part.ruleId ? (
          <label
            className="flex items-center gap-1.5 text-token-xs select-none cursor-pointer"
            style={{ color: "var(--text-muted)" }}
            title="勾选后本会话内同类操作不再询问；新建/重启会话后失效"
          >
            <input
              type="checkbox"
              checked={rememberThisSession}
              onChange={(e) => setRememberThisSession(e.target.checked)}
            />
            <span>本会话不再问</span>
          </label>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onDeny?.(part.toolCallId, "Denied by user.")}
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
            onClick={() =>
              onApprove?.(
                part.toolCallId,
                rememberThisSession && part.ruleId
                  ? { remember: "this-session", ruleId: part.ruleId }
                  : undefined
              )
            }
            className="rounded px-2.5 py-1 text-xs text-[color:var(--color-bg)] hover:opacity-90"
            style={{ background: "var(--accent)" }}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
});

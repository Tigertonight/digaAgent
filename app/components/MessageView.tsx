"use client";

/**
 * MessageView —— 单条消息渲染（user 右气泡 / assistant 左侧 markdown）。
 * RFC-1 阶段 C3：从 ChatApp.tsx 内部 const 提升到独立组件文件。
 *
 * 同文件配套：
 *   - AssistantStreamMeta  流式 phase 标签 + 实时 t/s pill
 *   - phaseLabel           AgentPhase → 文案
 *   - CopyButton           hover 复制按钮
 *   - ThinkingBlock        思考过程 details 折叠
 *   - extractPlainText     parts → 纯文本（用于复制）
 *
 * 设计要点：
 *   - memo 包裹，shallow-compare props；父组件必须传稳定 callback（已用 useCallback）
 *   - 流式期间只有最后一条 assistant 的 msg/streamingPhase/meta 变，其它 N-1 条 props 引用不变直接跳过 reconcile
 *   - AgentPhase 复用 lib/session-runner 的同形 type
 */

import Image from "next/image";
import type { ReactNode } from "react";
import { memo, useEffect, useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Circle,
  CornerDownLeft,
  FileText,
  GitBranch,
  Lightbulb,
  Loader2,
  Play,
  RotateCcw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type {
  ChatMessage,
  ChatMessageComposerMeta,
  MessagePart,
} from "@/lib/types";
import type { AgentPhase } from "@/lib/session-runner";
import { formatMessageTime, formatTokens } from "@/lib/format";
import { previewStore } from "@/lib/preview-store";
import { narrateTool, shouldHideTool } from "@/lib/narration/tool";
import Markdown from "./Markdown";
import ToolRender from "./ToolRender";
import { ApprovalBubble } from "./ApprovalBubble";
import { ClarificationCard } from "./ClarificationCard";

export interface MessageViewProps {
  msg: ChatMessage;
  index: number;
  /** 是否允许 fork（user message + 有 entryId + 不在 streaming） */
  canFork: boolean;
  /** 是否正在编辑该条 */
  isForking: boolean;
  forkText: string;
  forkBusy: boolean;
  onStartFork: (index: number, currentText: string) => void;
  onCancelFork: () => void;
  onChangeForkText: (text: string) => void;
  onSubmitFork: (entryId: string) => void;
  /** 从此 entry fork 出新 session（带 parentSessionPath） */
  onForkToNewSession: (entryId: string) => void;
  /** assistant caption 用的模型名（仅本轮的 modelId 名） */
  modelLabel?: string;
  /** 在执行组件展开态中复用 MessageView 时隐藏重复的 assistant 身份/usage chrome。 */
  assistantChrome?: "full" | "content";
  /** 仅最后一条 assistant 的本轮 token meta */
  meta?: { input: number; output: number; cost: number };
  /** 仅最后一条 assistant + 正在 streaming 时传入：用于 phase 标签 + t/s pill */
  streamingPhase?: AgentPhase;
  isStreaming?: boolean;
  /** 当前会话 cwd：传给 Markdown 用于解析消息里出现的相对图片路径 */
  cwd?: string;
  /** 点击 assistant 里的 http(s) 链接时，交给右侧 Browser Panel 打开 */
  onOpenUrl?: (href: string) => void;
  /**
   * RFC-2 Phase B3：approval part 点 Allow 时回调。
   * B4：可选 opts.remember = "this-session" + opts.ruleId 让 server 记住本会话不再问。
   */
  onApproveCall?: (
    toolCallId: string,
    opts?: { remember?: "this-session"; ruleId?: string }
  ) => void;
  /** RFC-2 Phase B3：approval part 点 Deny 时回调 */
  onDenyCall?: (toolCallId: string, denyReason?: string) => void;
  /** RFC-5：clarification 推荐项点击 */
  onChooseClarification?: (requestId: string, optionId: string) => void;
  /** RFC-5：clarification 自定义回复 */
  onRespondClarification?: (requestId: string, customText: string) => void;
  /** Dynamic workflow：从历史 workflow checkpoint/artifact 续跑 */
  onResumeWorkflow?: (workflowId: string, objective: string) => void;
  /** Dynamic workflow：重试 merge / 清理 workflow worktree */
  onWorkflowWorktreeAction?: (
    action: "retry_merge" | "cleanup",
    workflowId: string,
    worktree: WorkflowWorktreeAction
  ) => Promise<void> | void;
  /** Multi-agent：重试某个 subagent task */
  /**
   * S5：带上 parentAgentId。在卡片点击时快照 batch 所属 parent，
   * 避免后续发送到当前 active session。老参数顺序保留以免双端丢。
   */
  onRetrySubagentTask?: (
    batchId: string,
    taskId: string,
    parentAgentId?: string
  ) => Promise<void> | void;
  /** Multi-agent：继续执行某个未完成 subagent batch */
  onResumeSubagentBatch?: (
    batchId: string,
    parentAgentId?: string
  ) => Promise<void> | void;
  /** Multi-agent：打开某个 child subagent session 继续追问 */
  onOpenSubagentSession?: (sessionFile: string) => void;
}

export interface WorkflowWorktreeAction {
  id: string;
  path: string;
  branchName: string;
  baseRef: string;
  createdAt?: number;
}

export const MessageView = memo(function MessageView({
  msg,
  index,
  canFork,
  isForking,
  forkText,
  forkBusy,
  onStartFork,
  onCancelFork,
  onChangeForkText,
  onSubmitFork,
  onForkToNewSession,
  modelLabel,
  assistantChrome = "full",
  meta,
  streamingPhase,
  isStreaming,
  cwd,
  onOpenUrl,
  onApproveCall,
  onDenyCall,
  onChooseClarification,
  onRespondClarification,
  onResumeWorkflow,
  onWorkflowWorktreeAction,
  onRetrySubagentTask,
  onResumeSubagentBatch,
  onOpenSubagentSession,
}: MessageViewProps) {
  // user：右侧气泡（支持 text + image parts 混合）
  if (msg.role === "user") {
    const parts: MessagePart[] =
      msg.parts && msg.parts.length > 0
        ? msg.parts
        : msg.text
        ? [{ kind: "text", text: msg.text }]
        : [];

    // 拼出当前 user message 的"纯文本"作为 fork 编辑器初值
    const joinedText = parts
      .filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text")
      .map((p) => p.text)
      .join("");

    return (
      <div className="group relative flex flex-col items-end">
        <div className="flex flex-col items-end gap-1.5 max-w-[75%]">
          {parts.map((p, i) => {
            if (p.kind === "text") {
              if (!p.text) return null;
              return (
                <div
                  key={i}
                  className="inline-block whitespace-pre-wrap rounded-token-lg px-3.5 py-2 text-sm"
                  style={{
                    background: "var(--user-bg)",
                    color: "var(--text)",
                  }}
                >
                  {p.text}
                </div>
              );
            }
            if (p.kind === "image") {
              const src = `data:${p.mimeType};base64,${p.data}`;
              return (
                <div
                  key={i}
                  className="inline-block overflow-hidden rounded-token-lg"
                  style={{
                    background: "var(--user-bg)",
                  }}
                >
                  <Image
                    src={src}
                    alt={`user-img-${i}`}
                    width={640}
                    height={480}
                    unoptimized
                    onClick={() => previewStore.openImage(src, "我发送的图片")}
                    className="block max-w-full max-h-80 object-contain"
                    style={{ cursor: "zoom-in" }}
                  />
                </div>
              );
            }
            return null;
          })}
        </div>

        {/* 结构化 Composer A6：user 气泡下的轻量 metadata strip（mode + refs 计数） */}
        {msg.composerMeta && (
          <UserComposerMetaStrip meta={msg.composerMeta} />
        )}

        {/* 时间戳 + hover 操作行（Copy / Edit from here / New session） */}
        <div
          className="text-token-xs mt-1 flex items-center gap-2"
          style={{ color: "var(--text-muted)" }}
        >
          {!isForking && (
            <span className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-3">
              {joinedText && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(joinedText);
                    } catch {
                      /* ignore */
                    }
                  }}
                  className="inline-flex items-center gap-1 hover:text-[color:var(--text)]"
                  title="复制"
                >
                  <FileText size={11} />
                  Copy
                </button>
              )}
              {canFork && (
                <button
                  type="button"
                  onClick={() => onStartFork(index, joinedText)}
                  className="inline-flex items-center gap-1 hover:text-[color:var(--text)]"
                  title="从此处编辑：截断后续对话并重新发送（同 session）"
                >
                  <CornerDownLeft size={11} />
                  Edit from here
                </button>
              )}
              {canFork && (
                <button
                  type="button"
                  onClick={() => onForkToNewSession(msg.entryId!)}
                  className="inline-flex items-center gap-1 hover:text-[color:var(--text)]"
                  title="从此处分叉成新 session"
                >
                  <GitBranch size={11} />
                  New session
                </button>
              )}
            </span>
          )}
          {msg.timestamp && (
            <span
              className="ml-auto text-token-xs"
              style={{ color: "var(--fg-faint)" }}
            >
              {formatMessageTime(msg.timestamp)}
            </span>
          )}
        </div>

        <div className="w-full">
          {/* 内联 fork 编辑器 */}
          {isForking && msg.entryId && (
            <div
              className="rounded-lg p-2 space-y-2"
              style={{
                background: "var(--bg-panel-2)",
                border: "1px dashed var(--accent)",
              }}
            >
              <div
                className="text-token-xs"
                style={{ color: "var(--fg-faint)" }}
              >
                Fork from entry {msg.entryId.slice(0, 8)} · 提交后此后所有消息将被丢弃
              </div>
              <textarea
                value={forkText}
                onChange={(e) => onChangeForkText(e.target.value)}
                rows={4}
                disabled={forkBusy}
                className="w-full rounded p-2 text-sm resize-none outline-none border"
                style={{
                  background: "var(--bg-panel)",
                  borderColor: "var(--border-soft)",
                  color: "var(--fg)",
                }}
              />
              <div className="flex justify-end gap-2 text-xs">
                <button
                  type="button"
                  onClick={onCancelFork}
                  disabled={forkBusy}
                  className="px-2 py-1 rounded border hover:opacity-80 disabled:opacity-50"
                  style={{
                    borderColor: "var(--border)",
                    color: "var(--fg)",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => onSubmitFork(msg.entryId!)}
                  disabled={forkBusy || !forkText.trim()}
                  className="px-2 py-1 rounded text-white disabled:opacity-50"
                  style={{ background: "var(--accent)" }}
                >
                  {forkBusy ? "Forking…" : "Fork"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // assistant：左侧，按 parts 顺序渲染
  // 兼容老 message（只有 thinking/text 字段，没有 parts）
  let parts: MessagePart[] = msg.parts ? [...msg.parts] : [];
  // Some restored / provider-specific messages can contain structured parts for
  // tool calls while the final assistant text still lives on the legacy `text`
  // field. Do not drop that text just because parts already exist.
  if (msg.thinking && !parts.some((p) => p.kind === "thinking")) {
    parts = [...parts, { kind: "thinking", text: msg.thinking }];
  }
  if (msg.text && !parts.some((p) => p.kind === "text" && p.text === msg.text)) {
    parts = [...parts, { kind: "text", text: msg.text }];
  }

  const captionText = modelLabel || "Assistant";
  const showAssistantChrome = assistantChrome === "full";
  if (!showAssistantChrome && parts.length === 0) return null;

  const plainText = extractPlainText(parts);
  return (
    <div className="group">
      {showAssistantChrome && (
        <div
          className="text-token-xs mb-1 flex items-center gap-2"
          style={{ color: "var(--text-muted)" }}
        >
          <span>{captionText}</span>
          {isStreaming && (
            <AssistantStreamMeta phase={streamingPhase ?? null} parts={parts} />
          )}
        </div>
      )}
      <div className="space-y-2 text-sm">
        {(() => {
          // 流式中只有"最后一个 text part"在累积 token,提前算好它的 index,
          // 给那个 Markdown 标 streaming=true(走纯 pre,跳过 ReactMarkdown)
          let tailTextIdx = -1;
          if (isStreaming) {
            for (let j = parts.length - 1; j >= 0; j--) {
              if (parts[j].kind === "text") { tailTextIdx = j; break; }
            }
          }
          const finalTextIdx = findFinalTextPartIndex(parts);
          const renderPart = (p: MessagePart, i: number) => {
          if (p.kind === "thinking") {
            return (
              <ThinkingBlock
                key={i}
                text={p.text}
                startedAt={p.startedAt}
                endedAt={p.endedAt}
              />
            );
          }
          if (p.kind === "text") {
            return (
              <div key={i} style={{ color: "var(--text)" }}>
                <Markdown
                  text={p.text}
                  streaming={i === tailTextIdx}
                  cwd={cwd}
                  onOpenUrl={onOpenUrl}
                />
              </div>
            );
          }
          if (p.kind === "tool") {
            return <ToolRender key={i} tool={p} />;
          }
          if (p.kind === "approval") {
            return (
              <ApprovalBubble
                key={i}
                part={p}
                onApprove={onApproveCall}
                onDeny={onDenyCall}
              />
            );
          }
          if (p.kind === "clarification") {
            return (
              <ClarificationCard
                key={i}
                part={p}
                onChoose={onChooseClarification}
                onRespond={onRespondClarification}
              />
            );
          }
          if (p.kind === "subagent_batch") {
            return (
              <SubagentBatchCard
                key={i}
                part={p}
                cwd={cwd}
                onOpenUrl={onOpenUrl}
                onRetryTask={onRetrySubagentTask}
                onResumeBatch={onResumeSubagentBatch}
                onOpenSubagentSession={onOpenSubagentSession}
              />
            );
          }
          if (p.kind === "workflow_run") {
            return (
              <WorkflowRunCard
                key={i}
                part={p}
                onResumeWorkflow={onResumeWorkflow}
                onWorktreeAction={onWorkflowWorktreeAction}
              />
            );
          }
          if (p.kind === "image") {
            const src = `data:${p.mimeType};base64,${p.data}`;
            return (
              <div key={i} className="rounded-lg overflow-hidden inline-block">
                <Image
                  src={src}
                  alt=""
                  width={768}
                  height={512}
                  unoptimized
                  onClick={() => previewStore.openImage(src, "生成的图片")}
                  className="block max-w-full max-h-96 object-contain"
                  style={{ cursor: "zoom-in" }}
                />
              </div>
            );
          }
          return null;
          };
          const rendered: ReactNode[] = [];
          let i = 0;
          while (i < parts.length) {
            if (
              finalTextIdx > 0 &&
              i < finalTextIdx &&
              isProcessPart(parts[i])
            ) {
              const group: MessagePart[] = [];
              const start = i;
              while (i < finalTextIdx && isProcessPart(parts[i])) {
                group.push(parts[i]);
                i += 1;
              }
              rendered.push(
                <CollapsedPartProcessGroup key={`process-${start}`} parts={group} />
              );
              continue;
            }
            rendered.push(renderPart(parts[i], i));
            i += 1;
          }
          return rendered;
        })()}
      </div>
      {showAssistantChrome && (
        <div
          className="text-token-xs mt-2 flex items-center gap-2"
          style={{ color: "var(--text-muted)" }}
        >
          {meta && (
            <>
              <span>{formatTokens(meta.input)} in</span>
              <span aria-hidden="true">·</span>
              <span>{formatTokens(meta.output)} out</span>
              {meta.cost > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {meta.cost < 0.0001
                      ? "<$0.0001"
                      : `$${meta.cost.toFixed(4)}`}
                  </span>
                </>
              )}
            </>
          )}
          <CopyButton text={plainText} />
          {msg.timestamp && (
            <span
              className="ml-auto text-token-xs"
              style={{ color: "var(--fg-faint)" }}
            >
              {formatMessageTime(msg.timestamp)}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────────────
// 同文件配套子组件 / helper
// ───────────────────────────────────────────────────────────────────────────

/**
 * Streaming 中的 phase 标签 + 实时 t/s pill。
 * - phase：跟随 agentPhase 切换 "Thinking…/Waiting for model…/Running X…"
 * - tps：每 300ms 估算一次（chars / 4 / elapsed），按速度染色
 */
function AssistantStreamMeta({
  phase,
  parts,
}: {
  phase: AgentPhase;
  parts: MessagePart[];
}) {
  const [tps, setTps] = useState<number | null>(null);
  const startRef = useRef<number | null>(null);
  const partsRef = useRef(parts);
  partsRef.current = parts;

  useEffect(() => {
    const tick = () => {
      const bs = partsRef.current;
      let chars = 0;
      for (const p of bs) {
        if (p.kind === "text") chars += p.text.length;
        else if (p.kind === "thinking") chars += p.text.length;
        else if (p.kind === "tool") {
          try {
            chars += JSON.stringify(p.args ?? {}).length;
          } catch {
            /* ignore */
          }
        }
      }
      if (chars === 0) return;
      const now = Date.now();
      if (startRef.current === null) startRef.current = now;
      const elapsed = (now - startRef.current) / 1000;
      if (elapsed > 0.5) setTps(chars / 4 / elapsed);
    };
    const id = setInterval(tick, 300);
    return () => {
      clearInterval(id);
      startRef.current = null;
    };
  }, []);

  const label = phaseLabel(phase);
  const pillBg =
    tps == null
      ? null
      : tps >= 50
      ? "var(--color-info)"
      : tps >= 30
      ? "var(--color-success)"
      : tps >= 15
      ? "var(--color-warning)"
      : "var(--color-danger)";

  return (
    <span className="inline-flex items-center gap-2">
      {label && (
        <span className="animate-pulse" style={{ color: "var(--text-muted)" }}>
          {label}
        </span>
      )}
      {tps != null && pillBg && (
        <span
          className="px-1.5 py-0.5 rounded text-token-xs font-medium"
          style={{
            background: pillBg,
            color: "var(--color-bg)",
            fontVariantNumeric: "tabular-nums",
          }}
          title="预估 token 速率（chars/4/elapsed）"
        >
          {tps.toFixed(1)} t/s
        </span>
      )}
    </span>
  );
}

function phaseLabel(phase: AgentPhase): string {
  if (!phase) return "";
  if (phase.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return "Running tool…";
    if (names.length === 1) return `Running ${names[0]}…`;
    if (names.length <= 3) return `Running ${names.join(", ")}…`;
    return `Running ${names.slice(0, 2).join(", ")} (+${names.length - 2})…`;
  }
  if (phase.kind === "waiting_model") return "Waiting for model…";
  if (phase.kind === "thinking") return "Thinking…";
  return "";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* ignore */
        }
      }}
      className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-[color:var(--bg-hover)]"
      style={{ color: "var(--text-muted)" }}
      title="Copy"
    >
      <FileText size={11} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CollapsedPartProcessGroup({ parts }: { parts: MessagePart[] }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeProcessParts(parts);
  return (
    <div
      className="group rounded-lg border text-xs"
      style={{
        borderColor: "var(--border-soft)",
        background: "var(--bg)",
      }}
      data-testid="assistant-process-group"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[color:var(--bg-hover)]"
        aria-expanded={open}
        data-testid="assistant-process-toggle"
      >
        <CheckCircle2
          size={13}
          className="shrink-0"
          style={{ color: "var(--text-dim)" }}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium" style={{ color: "var(--text)" }}>
            {summary.title}
          </span>
          <span className="block truncate text-token-xs" style={{ color: "var(--text-muted)" }}>
            {summary.detail}
          </span>
        </span>
        <span
          className="shrink-0 text-token-xs opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: "var(--text-muted)" }}
        >
          {open ? "收起 ▾" : "展开细节 ▸"}
        </span>
      </button>
      {open ? (
        <div
          className="space-y-2 border-t px-3 py-3"
          style={{ borderColor: "var(--border-soft)" }}
        >
          {parts.map((part, index) => (
            <ProcessPartDetail key={index} part={part} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProcessPartDetail({ part }: { part: MessagePart }) {
  if (part.kind === "tool") return <ToolRender tool={part} />;
  if (part.kind === "thinking") {
    return (
      <ThinkingBlock
        text={part.text}
        startedAt={part.startedAt}
        endedAt={part.endedAt}
      />
    );
  }
  if (part.kind === "approval") {
    return (
      <div className="rounded border px-2 py-1.5" style={{ borderColor: "var(--border-soft)" }}>
        工具确认 · {part.toolName} · {part.status}
      </div>
    );
  }
  return (
    <div className="rounded border px-2 py-1.5" style={{ borderColor: "var(--border-soft)" }}>
      {part.kind}
    </div>
  );
}

function findFinalTextPartIndex(parts: MessagePart[]): number {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part.kind === "text" && part.text.trim().length > 0) return i;
  }
  return -1;
}

function isProcessPart(part: MessagePart): boolean {
  if (
    (part.kind === "approval" || part.kind === "clarification") &&
    part.status === "pending"
  ) {
    return false;
  }
  return part.kind === "tool" || part.kind === "thinking" || part.kind === "approval";
}

function summarizeProcessParts(parts: MessagePart[]): {
  title: string;
  detail: string;
} {
  let errorCount = 0;
  let thinking = 0;
  let approvals = 0;
  const toolLabels: string[] = [];
  for (const part of parts) {
    if (part.kind === "tool") {
      if (shouldHideTool(part)) continue;
      const label = narrateTool(part).primary;
      if (label) toolLabels.push(label);
      if (part.status === "error" || part.isError) errorCount += 1;
    } else if (part.kind === "thinking") {
      thinking += 1;
    } else if (part.kind === "approval") {
      approvals += 1;
    }
  }
  const toolSummary = toolLabels.slice(0, 3);
  const fallback = [
    thinking > 0 ? `思考×${thinking}` : "",
    approvals > 0 ? `确认×${approvals}` : "",
  ].filter(Boolean);
  const stepCount = Math.max(1, toolLabels.length + thinking + approvals);
  return {
    title:
      errorCount > 0
        ? `已处理 ${stepCount} 个步骤，期间遇到 ${errorCount} 个问题并已恢复`
        : `已处理 ${stepCount} 个步骤`,
    detail: toolSummary.join(" / ") || fallback.join(" / ") || "过程记录",
  };
}

function extractPlainText(parts: MessagePart[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (p.kind === "text") out.push(p.text);
    else if (p.kind === "thinking") {
      // 不复制 thinking 内容
    } else if (p.kind === "clarification") {
      out.push([p.title, p.question].filter(Boolean).join("\n"));
    } else if (p.kind === "subagent_batch") {
      out.push(
        [
          `Subagents: ${p.reason}`,
          ...p.tasks.map(
            (task) =>
              [
                `${task.status} ${task.role ?? "general"} ${task.title}`,
                task.answer || task.error || "",
              ]
                .filter(Boolean)
                .join("\n")
          ),
        ].join("\n")
      );
    } else if (p.kind === "workflow_run") {
      out.push(
        [
          `Workflow: ${p.objective}`,
          `Status: ${p.status}`,
          p.error ? `Error: ${p.error}` : "",
          ...p.checkpoints.map((checkpoint) => `Checkpoint: ${checkpoint.name}`),
          ...p.artifacts.map((artifact) => `Artifact: ${artifact.name}`),
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  }
  return out.join("\n").trim();
}

function shortJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    if (!text) return "";
    return text.length > 900 ? `${text.slice(0, 897)}...` : text;
  } catch {
    return String(value);
  }
}

function stringProp(obj: Record<string, unknown>, key: string): string {
  return typeof obj[key] === "string" ? obj[key] : "";
}

function worktreeFromArtifact(
  artifact: Extract<MessagePart, { kind: "workflow_run" }>["artifacts"][number]
): WorkflowWorktreeAction | null {
  const value =
    artifact.value && typeof artifact.value === "object"
      ? (artifact.value as Record<string, unknown>)
      : null;
  if (!value) return null;
  const id = stringProp(value, "id") || stringProp(value, "worktreeId");
  const path = stringProp(value, "path");
  const branchName = stringProp(value, "branchName");
  const baseRef = stringProp(value, "baseRef") || "HEAD";
  if (!id || !path || !branchName) return null;
  return {
    id,
    path,
    branchName,
    baseRef,
    createdAt:
      typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
        ? value.createdAt
        : undefined,
  };
}

function worktreeArtifactKind(
  name: string
): "failed" | "merged" | "created" | "cleaned" | null {
  if (name.startsWith("worktree-merge-failed:")) return "failed";
  if (name.startsWith("worktree-merge:")) return "merged";
  if (name.startsWith("worktree-manual-merge:")) return "merged";
  if (name.startsWith("worktree-cleanup:")) return "cleaned";
  if (name.startsWith("worktree:")) return "created";
  return null;
}

type WorktreeArtifactState = {
  artifact: Extract<MessagePart, { kind: "workflow_run" }>["artifacts"][number];
  kind: "failed" | "merged" | "created" | "cleaned";
  worktree: WorkflowWorktreeAction;
  lastError?: string;
};

function worktreeKindRank(kind: WorktreeArtifactState["kind"]): number {
  if (kind === "cleaned") return 4;
  if (kind === "merged") return 3;
  if (kind === "failed") return 2;
  return 1;
}

function worktreeStatesFromArtifacts(
  artifacts: Extract<MessagePart, { kind: "workflow_run" }>["artifacts"]
): WorktreeArtifactState[] {
  const byId = new Map<string, WorktreeArtifactState>();
  for (const artifact of artifacts) {
    const kind = worktreeArtifactKind(artifact.name);
    const worktree = worktreeFromArtifact(artifact);
    if (!kind || !worktree) continue;
    const value =
      artifact.value && typeof artifact.value === "object"
        ? (artifact.value as Record<string, unknown>)
        : {};
    const error = stringProp(value, "error");
    const current = byId.get(worktree.id);
    const next: WorktreeArtifactState = {
      artifact,
      kind,
      worktree,
      lastError: error || current?.lastError,
    };
    const nextRank = worktreeKindRank(kind);
    const currentRank = current ? worktreeKindRank(current.kind) : 0;
    if (
      !current ||
      nextRank > currentRank ||
      (nextRank === currentRank && artifact.createdAt >= current.artifact.createdAt)
    ) {
      byId.set(worktree.id, next);
    } else if (error && !current.lastError) {
      byId.set(worktree.id, { ...current, lastError: error });
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => b.artifact.createdAt - a.artifact.createdAt)
    .slice(0, 4);
}

function WorkflowRunCard({
  part,
  onResumeWorkflow,
  onWorktreeAction,
}: {
  part: Extract<MessagePart, { kind: "workflow_run" }>;
  onResumeWorkflow?: (workflowId: string, objective: string) => void;
  onWorktreeAction?: (
    action: "retry_merge" | "cleanup",
    workflowId: string,
    worktree: WorkflowWorktreeAction
  ) => Promise<void> | void;
}) {
  const [worktreeBusy, setWorktreeBusy] = useState<string | null>(null);
  const [worktreeNotice, setWorktreeNotice] = useState<{
    tone: "success" | "error";
    text: string;
  } | null>(null);
  const running = part.status === "running" || part.status === "pending";
  const failed = part.status === "failed" || part.status === "aborted";
  const duration =
    part.endedAt && part.createdAt && part.endedAt > part.createdAt
      ? Math.max(1, Math.round((part.endedAt - part.createdAt) / 1000))
      : null;
  const recentLogs = part.logs.slice(-5);
  const worktreeStates = worktreeStatesFromArtifacts(part.artifacts);
  const canResume =
    !running && part.checkpoints.length > 0 && Boolean(onResumeWorkflow);
  const runWorktreeAction = async (
    action: "retry_merge" | "cleanup",
    worktree: WorkflowWorktreeAction
  ) => {
    if (!onWorktreeAction || worktreeBusy) return;
    const busyKey = `${action}:${worktree.id}`;
    setWorktreeBusy(busyKey);
    setWorktreeNotice(null);
    try {
      await onWorktreeAction(action, part.id, worktree);
      setWorktreeNotice({
        tone: "success",
        text:
          action === "retry_merge"
            ? "Merge retry completed."
            : "Worktree cleanup completed.",
      });
    } catch (e) {
      setWorktreeNotice({
        tone: "error",
        text:
          action === "retry_merge"
            ? `Merge retry failed: ${String(e)}`
            : `Worktree cleanup failed: ${String(e)}`,
      });
    } finally {
      setWorktreeBusy(null);
    }
  };

  return (
    <div className="space-y-2" style={{ color: "var(--text)" }}>
      <div className="flex items-center gap-2 text-xs">
        {part.status === "completed" ? (
          <CheckCircle2 size={13} style={{ color: "var(--color-success)" }} />
        ) : failed ? (
          <XCircle size={13} style={{ color: "var(--color-danger)" }} />
        ) : running ? (
          <Loader2
            size={13}
            className="animate-spin"
            style={{ color: "var(--accent)" }}
          />
        ) : (
          <Circle size={13} style={{ color: "var(--text-muted)" }} />
        )}
        <span className="font-semibold">Workflow</span>
        <span className="truncate" style={{ color: "var(--text-muted)" }}>
          {part.objective}
        </span>
        <span
          className="ml-auto shrink-0 text-token-xs"
          style={{ color: "var(--text-muted)" }}
        >
          {part.status}
          {duration ? ` · ${duration}s` : ""}
        </span>
        {canResume && (
          <button
            type="button"
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded border px-1.5 text-token-xs hover:opacity-85"
            style={{
              borderColor: "var(--border-soft)",
              color: "var(--text-muted)",
              background: "var(--bg-subtle)",
            }}
            title="Resume this workflow from its latest checkpoint/artifacts"
            onClick={() => onResumeWorkflow?.(part.id, part.objective)}
          >
            <RotateCcw size={11} />
            Resume
          </button>
        )}
      </div>
      {part.rationale && (
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          {part.rationale}
        </div>
      )}
      {part.manifest && (
        <div
          className="flex flex-wrap gap-x-3 gap-y-1 text-token-xs"
          style={{ color: "var(--text-muted)" }}
        >
          {part.resumedFromWorkflowId && (
            <span>Resumed from: {part.resumedFromWorkflowId.slice(0, 8)}</span>
          )}
          <span>Capabilities: {part.manifest.capabilities.join(", ")}</span>
          <span>Agents: {part.manifest.maxAgents}</span>
          <span>Parallel: {part.manifest.maxConcurrency}</span>
          <span>Runtime: {part.manifest.runtime}</span>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <div
          className="rounded-md border px-3 py-2"
          style={{
            borderColor: "var(--border-soft)",
            background: "var(--bg-subtle)",
          }}
        >
          <div className="mb-1 text-token-xs font-semibold">Checkpoints</div>
          {part.checkpoints.length ? (
            <div className="space-y-1">
              {part.checkpoints.slice(-4).map((checkpoint, index) => (
                <details key={`${checkpoint.name}-${index}`} className="text-xs">
                  <summary className="cursor-pointer list-none truncate [&::-webkit-details-marker]:hidden">
                    {checkpoint.name}
                  </summary>
                  <pre
                    className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-token-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {shortJson(checkpoint.value)}
                  </pre>
                </details>
              ))}
            </div>
          ) : (
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>
              No checkpoints yet
            </div>
          )}
        </div>
        <div
          className="rounded-md border px-3 py-2"
          style={{
            borderColor: "var(--border-soft)",
            background: "var(--bg-subtle)",
          }}
        >
          <div className="mb-1 text-token-xs font-semibold">Artifacts</div>
          {part.artifacts.length ? (
            <div className="space-y-1">
              {part.artifacts.slice(-4).map((artifact, index) => (
                <details key={`${artifact.name}-${index}`} className="text-xs">
                  <summary className="cursor-pointer list-none truncate [&::-webkit-details-marker]:hidden">
                    {artifact.name}
                  </summary>
                  <pre
                    className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-token-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {shortJson(artifact.value)}
                  </pre>
                </details>
              ))}
            </div>
          ) : (
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>
              No artifacts yet
            </div>
          )}
        </div>
      </div>
      {worktreeStates.length > 0 && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--border-soft)",
            background: "var(--bg-subtle)",
          }}
        >
          <div className="mb-1 text-token-xs font-semibold">Worktrees</div>
          <div className="space-y-1.5">
            {worktreeStates.map(({ kind, worktree, lastError }) => {
              return (
                <div
                  key={worktree.id}
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--border-soft)" }}
                >
                  <div className="flex items-start gap-2">
                    <GitBranch
                      size={12}
                      className="mt-0.5 shrink-0"
                      style={{
                        color:
                          kind === "failed"
                            ? "var(--color-danger)"
                            : kind === "merged"
                              ? "var(--color-success)"
                              : "var(--text-muted)",
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {kind === "failed"
                          ? "Merge failed"
                          : kind === "merged"
                            ? "Merge applied"
                            : kind === "cleaned"
                              ? "Worktree cleaned"
                              : "Created worktree"}
                      </div>
                      <div
                        className="truncate text-token-xs"
                        style={{ color: "var(--text-muted)" }}
                        title={worktree.path}
                      >
                        {worktree.branchName} · {worktree.path}
                      </div>
                      {lastError && (
                        <div className="mt-0.5 truncate text-token-xs text-[color:var(--color-danger)]" title={lastError}>
                          {lastError}
                        </div>
                      )}
                    </div>
                    {onWorktreeAction && (
                      <div className="flex shrink-0 gap-1">
                        {kind === "failed" && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-token-xs hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-60"
                            style={{
                              borderColor: "var(--border-soft)",
                              color: "var(--text-muted)",
                            }}
                            disabled={Boolean(worktreeBusy)}
                            onClick={() => void runWorktreeAction("retry_merge", worktree)}
                          >
                            {worktreeBusy === `retry_merge:${worktree.id}` && (
                              <Loader2 size={10} className="animate-spin" />
                            )}
                            <span>Retry merge</span>
                          </button>
                        )}
                        {kind !== "cleaned" && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-token-xs hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-60"
                            style={{
                              borderColor: "var(--border-soft)",
                              color: "var(--text-muted)",
                            }}
                            disabled={Boolean(worktreeBusy)}
                            onClick={() => void runWorktreeAction("cleanup", worktree)}
                          >
                            {worktreeBusy === `cleanup:${worktree.id}` && (
                              <Loader2 size={10} className="animate-spin" />
                            )}
                            <span>Cleanup</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {worktreeNotice && (
            <div
              className="mt-2 rounded border px-2 py-1 text-token-xs"
              style={{
                borderColor:
                  worktreeNotice.tone === "success"
                    ? "var(--color-success)"
                    : "var(--color-danger)",
                color:
                  worktreeNotice.tone === "success" ? "var(--color-success)" : "var(--color-danger)",
                background:
                  worktreeNotice.tone === "success"
                    ? "var(--color-success-bg)"
                    : "var(--color-danger-bg)",
              }}
            >
              {worktreeNotice.text}
            </div>
          )}
        </div>
      )}
      {(part.error || recentLogs.length > 0) && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--border-soft)",
            background: "var(--bg-subtle)",
          }}
        >
          {part.error && (
            <div className="mb-1" style={{ color: "var(--color-danger)" }}>
              {part.error}
            </div>
          )}
          {recentLogs.map((log, index) => (
            <div key={index} style={{ color: "var(--text-muted)" }}>
              [{log.level}] {log.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SubagentBatchCard({
  part,
  cwd,
  onOpenUrl,
  onRetryTask,
  onResumeBatch,
  onOpenSubagentSession,
}: {
  part: Extract<MessagePart, { kind: "subagent_batch" }>;
  cwd?: string;
  onOpenUrl?: (href: string) => void;
  onRetryTask?: (
    batchId: string,
    taskId: string,
    parentAgentId?: string
  ) => Promise<void> | void;
  onResumeBatch?: (
    batchId: string,
    parentAgentId?: string
  ) => Promise<void> | void;
  onOpenSubagentSession?: (sessionFile: string) => void;
}) {
  const [retryingTaskIds, setRetryingTaskIds] = useState<Set<string>>(
    () => new Set()
  );
  const [resuming, setResuming] = useState(false);
  const completed = part.tasks.filter((task) => task.status === "completed").length;
  const failed = part.tasks.filter(
    (task) =>
      task.status === "failed" ||
      task.status === "aborted" ||
      task.status === "timeout"
  ).length;
  const runningCount = part.tasks.filter((task) => task.status === "running").length;
  const pendingCount = part.tasks.filter((task) => task.status === "pending").length;
  const running = runningCount > 0;
  const activeCount = runningCount + pendingCount;
  const hasUnfinished = part.tasks.some(
    (task) => task.status === "pending" || task.status === "running"
  );
  const canResume =
    Boolean(onResumeBatch) && Boolean(part.restored) && hasUnfinished && !resuming;
  const duration =
    part.endedAt && part.createdAt && part.endedAt > part.createdAt
      ? Math.max(1, Math.round((part.endedAt - part.createdAt) / 1000))
      : null;
  const verificationColor =
    part.verification?.status === "passed"
      ? "var(--color-success)"
      : part.verification?.status === "warning"
      ? "var(--color-warning)"
      : part.verification?.status === "failed"
      ? "var(--color-danger)"
      : "var(--text-muted)";

  const statusLabel =
    activeCount > 0
      ? `${activeCount} 个子智能体正在运行`
      : failed > 0
      ? `${completed} 个完成，${failed} 个失败`
      : `${completed} 个子智能体已完成`;
  const hasBatchMeta = Boolean(
    part.planning || part.synthesis || (part.auditEvents && part.auditEvents.length > 0)
  );

  return (
    <div
      className="space-y-3"
      style={{
        color: "var(--text)",
      }}
    >
      <div className="flex items-start gap-2 text-token-sm">
        <span className="mt-0.5 font-mono text-token-lg" style={{ color: "var(--text-muted)" }}>
          ›_
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate" style={{ color: "var(--text-muted)" }}>
              {part.reason || `等待 ${part.tasks.length} 个子任务完成`}
            </span>
            <span
              className="ml-auto shrink-0 text-token-xs tabular-nums"
              style={{ color: "var(--text-muted)" }}
            >
              {duration ? `${duration}s` : ""}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 text-token-lg font-semibold" style={{ color: "var(--accent)" }}>
        <Bot size={24} strokeWidth={2.2} />
        {running && <Loader2 size={16} className="animate-spin" />}
        <span>{statusLabel}</span>
        {part.verification && (
          <span
            className="ml-1 inline-flex h-6 items-center gap-1 rounded-token-sm border px-1.5 text-token-xs font-medium"
            style={{
              borderColor: "var(--border-soft)",
              color: verificationColor,
            }}
            title={part.verification.summary}
          >
            <ShieldCheck size={12} />
            {part.verification.status}
          </span>
        )}
        {onResumeBatch && part.restored && hasUnfinished && (
          <button
            type="button"
            disabled={!canResume}
            onClick={async () => {
              if (!canResume) return;
              setResuming(true);
              try {
                await onResumeBatch(part.id, part.parentAgentId);
              } finally {
                setResuming(false);
              }
            }}
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-token-sm border px-2 text-token-xs font-medium hover:bg-[color:var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
            style={{ borderColor: "var(--border-soft)", color: "var(--text)" }}
            title="继续执行未完成的 subagent tasks"
            aria-label="继续执行未完成的 subagent tasks"
          >
            {resuming ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Play size={12} />
            )}
            Continue
          </button>
        )}
      </div>
      {hasBatchMeta && (
        <details
          className="rounded-token-sm text-token-xs"
          style={{ color: "var(--text-muted)" }}
        >
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-token-sm px-1.5 py-1 hover:bg-[color:var(--bg-hover)] [&::-webkit-details-marker]:hidden">
            Details
            <span className="tabular-nums">
              {part.planning ? " · planner" : ""}
              {part.synthesis ? " · synthesis" : ""}
              {part.auditEvents?.length ? ` · ${part.auditEvents.length} audit` : ""}
            </span>
          </summary>
          <div className="mt-2 space-y-2">
            {part.planning && (
              <div
                className="rounded border px-2.5 py-2"
                style={{
                  borderColor: "var(--border-soft)",
                  background: "var(--bg-subtle)",
                }}
                title={part.planning.warnings.join("\n")}
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold" style={{ color: "var(--text)" }}>
                    Planner: {part.planning.status}
                  </span>
                  <span>{part.planning.taskCount} tasks</span>
                  <span>concurrency {part.planning.concurrency}</span>
                  {part.planning.warnings.length > 0 && (
                    <span>{part.planning.warnings.length} warnings</span>
                  )}
                </div>
              </div>
            )}
            {part.synthesis && (
              <div
                className="rounded border px-2.5 py-2"
                style={{
                  borderColor: "var(--border-soft)",
                  background: "var(--bg-subtle)",
                }}
                title={part.synthesis.instructions}
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold" style={{ color: "var(--text)" }}>
                    Synthesis: {part.synthesis.status}
                  </span>
                  <span>{part.synthesis.summary}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  <span>{part.synthesis.usableTaskIds.length} usable</span>
                  <span>{part.synthesis.cautionTaskIds.length} caution</span>
                  <span>{part.synthesis.rejectedTaskIds.length} rejected</span>
                </div>
              </div>
            )}
            {part.auditEvents && part.auditEvents.length > 0 && (
              <div
                className="rounded border px-2.5 py-2"
                style={{
                  borderColor: "var(--border-soft)",
                  background: "var(--bg-subtle)",
                }}
              >
                <div className="font-semibold" style={{ color: "var(--text)" }}>
                  Audit: {part.auditEvents.length} events
                </div>
                <div className="mt-2 space-y-1">
                  {part.auditEvents.slice(-12).map((event, index) => (
                    <div
                      key={`${event.at}:${event.type}:${event.taskId ?? ""}:${index}`}
                      className="grid grid-cols-[86px_minmax(0,1fr)] gap-2"
                    >
                      <span className="font-mono">
                        {new Date(event.at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                      <span className="min-w-0">
                        <span className="font-mono">{event.type}</span>
                        {event.taskId ? <span> {event.taskId}</span> : null}
                        <span> {event.message}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        {part.tasks.map((task) => {
          const isDone = task.status === "completed";
          const isRunning = task.status === "running";
          const isFailed =
            task.status === "failed" ||
            task.status === "aborted" ||
            task.status === "timeout";
          const answer = task.answer || task.answerPreview || "";
          const retryKey = `${part.id}:${task.id}`;
          const retrying = retryingTaskIds.has(retryKey);
          const canRetry =
            Boolean(onRetryTask) &&
            !retrying &&
            task.status !== "running" &&
            task.status !== "pending";
          const taskDuration =
            task.startedAt && task.endedAt && task.endedAt > task.startedAt
              ? Math.max(1, Math.round((task.endedAt - task.startedAt) / 1000))
              : null;
          const taskVerificationColor =
            task.verification?.status === "passed"
              ? "var(--color-success)"
              : task.verification?.status === "warning"
              ? "var(--color-warning)"
              : task.verification?.status === "failed"
              ? "var(--color-danger)"
              : "var(--text-muted)";
          const openByDefault = isRunning;
          const statusIcon = isDone ? (
            <CheckCircle2 size={13} style={{ color: "var(--color-success)" }} />
          ) : isFailed ? (
            <XCircle size={13} style={{ color: "var(--color-danger)" }} />
          ) : isRunning ? (
            <Loader2
              size={13}
              className="animate-spin"
              style={{ color: "var(--accent)" }}
            />
          ) : (
            <Circle size={13} style={{ color: "var(--text-muted)" }} />
          );
          return (
            <details
              key={task.id}
              open={openByDefault}
              className="group/subagent max-w-full"
            >
              <summary
                className="inline-flex max-w-full cursor-pointer list-none items-center gap-2 rounded-full border px-3 py-1.5 text-token-sm shadow-sm hover:bg-[color:var(--bg-hover)] [&::-webkit-details-marker]:hidden"
                style={{
                  borderColor: isFailed
                    ? "var(--color-danger)"
                    : isRunning
                    ? "var(--accent)"
                    : "var(--border-soft)",
                  background: "var(--bg-panel)",
                  color: "var(--text)",
                }}
                title={`${task.status}: ${task.title}`}
              >
                <span className="font-mono text-token-lg leading-none" style={{ color: "var(--text-muted)" }}>
                  ⋮
                </span>
                <span className="shrink-0">{statusIcon}</span>
                <span className="min-w-0 truncate">{task.title}</span>
              </summary>
              <div
                className="mt-2 w-[min(760px,calc(100vw-96px))] rounded-token-md border p-3"
                style={{
                  borderColor: "var(--border-soft)",
                  background: "var(--bg-panel)",
                }}
              >
                <div
                  className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-token-xs"
                  style={{ color: "var(--text-muted)" }}
                >
                  <span>
                    Skill: {task.role === "rag" ? "gbrain-query" : task.role ?? "general"}
                  </span>
                  {task.usage?.turns !== undefined && (
                    <span>运行了 {task.usage.turns} 轮</span>
                  )}
                  {taskDuration !== null && <span>{taskDuration}s</span>}
                  {task.verification && (
                    <span
                      className="inline-flex items-center gap-1"
                      style={{ color: taskVerificationColor }}
                      title={task.verification.checks
                        .map((check) => `${check.status}: ${check.message}`)
                        .join("\n")}
                    >
                      <ShieldCheck size={11} />
                      {task.verification.status}
                    </span>
                  )}
                  {task.attempts && task.attempts.length > 0 && (
                    <span>{task.attempts.length + 1} attempts</span>
                  )}
                  {onRetryTask && (
                    <button
                      type="button"
                      disabled={!canRetry}
                      onClick={async () => {
                        if (!canRetry) return;
                        setRetryingTaskIds((cur) => {
                          const next = new Set(cur);
                          next.add(retryKey);
                          return next;
                        });
                        try {
                          await onRetryTask(part.id, task.id, part.parentAgentId);
                        } finally {
                          setRetryingTaskIds((cur) => {
                            const next = new Set(cur);
                            next.delete(retryKey);
                            return next;
                          });
                        }
                      }}
                      className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded hover:bg-[color:var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                      title="重试这个 subagent task"
                      aria-label="重试这个 subagent task"
                    >
                      {retrying ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <RotateCcw size={13} />
                      )}
                    </button>
                  )}
                </div>
                <div
                  className="max-h-[520px] overflow-auto rounded-md border px-3 py-3"
                  style={{
                    borderColor: "var(--border-soft)",
                    background: "var(--bg-subtle)",
                  }}
                >
                  {task.error ? (
                    <div className="text-xs" style={{ color: "var(--color-danger)" }}>
                      {task.error}
                    </div>
                  ) : answer ? (
                    <Markdown
                      text={answer}
                      size="small"
                      cwd={cwd}
                      onOpenUrl={onOpenUrl}
                    />
                  ) : (
                    <div
                      className="text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      等待子 agent 返回结果…
                    </div>
                  )}
                </div>
                {task.sessionFile && (
                  <div
                    className="mt-1 flex items-center gap-1 text-token-xs"
                    style={{ color: "var(--fg-faint)" }}
                    title={task.sessionFile}
                  >
                    <span className="min-w-0 flex-1 truncate">{task.sessionFile}</span>
                    {onOpenSubagentSession && (
                      <button
                        type="button"
                        onClick={() => onOpenSubagentSession(task.sessionFile!)}
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-[color:var(--bg-hover)]"
                        title="打开 child subagent session"
                        aria-label="打开 child subagent session"
                      >
                        <FileText size={12} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function ThinkingBlock({
  text,
  startedAt,
  endedAt,
}: {
  text: string;
  startedAt?: number;
  endedAt?: number;
}) {
  if (!text) return null;
  // 仅在思考阶段已结束（有 endedAt）时展示时长；流式中不显示
  const duration =
    startedAt && endedAt && endedAt > startedAt
      ? Math.max(1, Math.round((endedAt - startedAt) / 1000))
      : null;
  return (
    <details
      className="rounded-md text-xs"
      style={{
        background: "var(--bg-panel-2)",
        color: "var(--text-muted)",
      }}
    >
      <summary
        className="cursor-pointer px-3 py-2 select-none flex items-center gap-1.5"
        style={{ color: "var(--text-muted)" }}
      >
        <Lightbulb size={12} />
        <span>Thinking</span>
        {duration !== null && (
          <span
            className="ml-auto tabular-nums"
            style={{ fontSize: 11, color: "var(--fg-faint)" }}
          >
            {duration}s
          </span>
        )}
      </summary>
      <div
        className="px-3 pb-2 thinking-md"
        style={{ color: "var(--text-dim)", fontSize: 12 }}
      >
        <Markdown text={text} size="small" />
      </div>
    </details>
  );
}

/**
 * user 气泡下方的轻量 metadata strip（结构化 Composer Phase A6）。
 *
 * 显示：
 *   - mode: Goal / Workflow（chip 颜色与 Composer ModeChip 对齐）
 *   - refs: "N references"，hover 看完整路径（基本名 join "\n"）
 *
 * 不显示：refs 的内容入气泡文本——气泡仍然只展示用户原话；strip 只是上下文说明。
 */
function UserComposerMetaStrip({ meta }: { meta: ChatMessageComposerMeta }) {
  const refsCount = meta.refs?.length ?? 0;
  if (!meta.mode && refsCount === 0) return null;
  const modeColor =
    meta.mode === "goal"
      ? "var(--color-warning)"
      : meta.mode === "workflow"
        ? "var(--accent)"
        : "var(--text-muted)";
  const modeLabel =
    meta.mode === "goal" ? "Goal" : meta.mode === "workflow" ? "Workflow" : null;
  const refsTooltip =
    refsCount > 0 && meta.refs
      ? meta.refs.map((p) => `@${p}`).join("\n")
      : undefined;
  return (
    <div
      className="text-token-xs mt-0.5 flex items-center gap-2"
      style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}
    >
      {modeLabel && (
        <span style={{ color: modeColor, fontWeight: 500 }}>{modeLabel}</span>
      )}
      {modeLabel && refsCount > 0 && <span aria-hidden>·</span>}
      {refsCount > 0 && (
        <span title={refsTooltip}>
          {refsCount} reference{refsCount > 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}

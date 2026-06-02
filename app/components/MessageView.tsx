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

import { memo, useEffect, useRef, useState } from "react";
import { CornerDownLeft, FileText, GitBranch, Lightbulb } from "lucide-react";
import type { ChatMessage, MessagePart } from "@/lib/types";
import type { AgentPhase } from "@/lib/session-runner";
import { formatMessageTime, formatTokens } from "@/lib/format";
import { previewStore } from "@/lib/preview-store";
import Markdown from "./Markdown";
import ToolRender from "./ToolRender";

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
  /** 仅最后一条 assistant 的本轮 token meta */
  meta?: { input: number; output: number; cost: number };
  /** 仅最后一条 assistant + 正在 streaming 时传入：用于 phase 标签 + t/s pill */
  streamingPhase?: AgentPhase;
  isStreaming?: boolean;
  /** 当前会话 cwd：传给 Markdown 用于解析消息里出现的相对图片路径 */
  cwd?: string;
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
  meta,
  streamingPhase,
  isStreaming,
  cwd,
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
                  className="rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap inline-block"
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
                  className="rounded-2xl overflow-hidden inline-block"
                  style={{
                    background: "var(--user-bg)",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt={`user-img-${i}`}
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

        {/* 时间戳 + hover 操作行（Copy / Edit from here / New session） */}
        <div
          className="text-[11px] mt-1 flex items-center gap-2"
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
              className="ml-auto text-[10px]"
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
                className="text-[10px]"
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
  let parts: MessagePart[] = msg.parts ?? [];
  if (parts.length === 0 && (msg.thinking || msg.text)) {
    if (msg.thinking) parts = [...parts, { kind: "thinking", text: msg.thinking }];
    if (msg.text) parts = [...parts, { kind: "text", text: msg.text }];
  }

  const captionText = modelLabel || "Assistant";

  const plainText = extractPlainText(parts);
  return (
    <div className="group">
      <div
        className="text-[11px] mb-1 flex items-center gap-2"
        style={{ color: "var(--text-muted)" }}
      >
        <span>{captionText}</span>
        {isStreaming && (
          <AssistantStreamMeta phase={streamingPhase ?? null} parts={parts} />
        )}
      </div>
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
          return parts.map((p, i) => {
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
                <Markdown text={p.text} streaming={i === tailTextIdx} cwd={cwd} />
              </div>
            );
          }
          if (p.kind === "tool") {
            return <ToolRender key={i} tool={p} />;
          }
          if (p.kind === "image") {
            const src = `data:${p.mimeType};base64,${p.data}`;
            return (
              <div key={i} className="rounded-lg overflow-hidden inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt=""
                  onClick={() => previewStore.openImage(src, "生成的图片")}
                  className="block max-w-full max-h-96 object-contain"
                  style={{ cursor: "zoom-in" }}
                />
              </div>
            );
          }
          return null;
        });
        })()}
      </div>
      <div
        className="text-[11px] mt-2 flex items-center gap-2"
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
            className="ml-auto text-[10px]"
            style={{ color: "var(--fg-faint)" }}
          >
            {formatMessageTime(msg.timestamp)}
          </span>
        )}
      </div>
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
      ? "#53b3cb"
      : tps >= 30
      ? "#9bc53d"
      : tps >= 15
      ? "#f9c22e"
      : "#e01a4f";

  return (
    <span className="inline-flex items-center gap-2">
      {label && (
        <span className="animate-pulse" style={{ color: "var(--text-muted)" }}>
          {label}
        </span>
      )}
      {tps != null && pillBg && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-medium"
          style={{
            background: pillBg,
            color: "#fff",
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

function extractPlainText(parts: MessagePart[]): string {
  const out: string[] = [];
  for (const p of parts) {
    if (p.kind === "text") out.push(p.text);
    else if (p.kind === "thinking") {
      // 不复制 thinking 内容
    }
  }
  return out.join("\n").trim();
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

"use client";

import type { RefObject } from "react";
import { useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { MessageView } from "./MessageView";
import { ChatMinimap } from "../ChatMinimap";
import type { ChatMessage } from "@/lib/types";
import type { MessagePart } from "@/lib/types";
import type { AgentPhase } from "@/lib/session-runner";
import type { ProviderInfo } from "@/lib/types";
import type { WorkflowWorktreeAction } from "./MessageView";

const INITIAL_RENDER_ITEM_WINDOW = 120;
const RENDER_ITEM_WINDOW_STEP = 120;

interface MessagesScrollAreaProps {
  // data
  messages: ChatMessage[];
  error: string | null;
  currentProvider: ProviderInfo | undefined;
  modelId: string;
  activeAssistantIndex: number;
  agentPhase: AgentPhase;
  cwd: string;
  streaming: boolean;
  pinSpacer: boolean;
  // fork state
  forksCollapsed: boolean;
  forkingIndex: number | null;
  forkText: string;
  forkBusy: boolean;
  // refs
  messagesScrollRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  // callbacks
  onScroll: () => void;
  onStartFork: (index: number, currentText: string) => void;
  onCancelFork: () => void;
  onChangeForkText: (v: string) => void;
  onSubmitFork: (entryId: string) => Promise<void>;
  onForkToNewSession: (entryId: string) => Promise<void>;
  onOpenUrl?: (href: string) => void;
  /** RFC-2 Phase B3/B4：approval part 点 Allow（B4 加 opts.remember） */
  onApproveCall?: (
    toolCallId: string,
    opts?: { remember?: "this-session"; ruleId?: string }
  ) => void;
  /** RFC-2 Phase B3：approval part 点 Deny */
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
  onRetrySubagentTask?: (batchId: string, taskId: string) => Promise<void> | void;
  /** Multi-agent：继续执行某个未完成 subagent batch */
  onResumeSubagentBatch?: (batchId: string) => Promise<void> | void;
  /** Multi-agent：打开某个 child subagent session 继续追问 */
  onOpenSubagentSession?: (sessionFile: string) => void;
}

export function MessagesScrollArea({
  messages,
  error,
  currentProvider,
  modelId,
  activeAssistantIndex,
  agentPhase,
  cwd,
  streaming,
  pinSpacer,
  forksCollapsed,
  forkingIndex,
  forkText,
  forkBusy,
  messagesScrollRef,
  messagesEndRef,
  messageRefs,
  onScroll,
  onStartFork,
  onCancelFork,
  onChangeForkText,
  onSubmitFork,
  onForkToNewSession,
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
}: MessagesScrollAreaProps) {
  const [visibleItemLimit, setVisibleItemLimit] = useState(
    INITIAL_RENDER_ITEM_WINDOW
  );
  const renderItems = useMemo(
    () =>
      buildCollapsedProcessItems({
        messages,
      }),
    [messages]
  );
  const visibleOrdinalByMessageIndex = useMemo(
    () => buildVisibleOrdinalByMessageIndex(messages),
    [messages]
  );
  const hiddenItemCount = Math.max(0, renderItems.length - visibleItemLimit);
  const visibleRenderItems =
    hiddenItemCount > 0 ? renderItems.slice(hiddenItemCount) : renderItems;

  return (
    <div className="relative flex flex-1 overflow-hidden">
      <div
        ref={messagesScrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[820px] px-4 py-6 space-y-6">
          {error && (
            <div className="p-3 rounded bg-red-900/40 border border-red-700 text-sm text-red-200">
              {error}
            </div>
          )}
          {(() => {
            const modelLabel = currentProvider?.models.find(
              (mm) => mm.id === modelId
            )?.name;
            const renderMessage = (m: ChatMessage, i: number, refMode: "normal" | "none") => {
              const isVisible =
                m.role === "user" || m.role === "assistant";
              const currentRefIdx =
                isVisible && refMode === "normal"
                  ? visibleOrdinalByMessageIndex[i] ?? -1
                  : -1;
              const isActiveAssistant =
                m.role === "assistant" && i === activeAssistantIndex;
              const usage = m.meta?.usage;
              const messageMeta =
                usage && (usage.total > 0 || usage.cost > 0)
                  ? {
                      input: usage.input,
                      output: usage.output,
                      cost: usage.cost,
                    }
                  : undefined;
              const messageModelLabel =
                m.meta?.model && m.meta.provider === currentProvider?.provider
                  ? currentProvider?.models.find((mm) => mm.id === m.meta?.model)
                      ?.name ?? m.meta.model
                  : m.meta?.model ?? modelLabel;
              // key 稳定且唯一：
              //   1) 优先 entryId（user message 从后端拿到的稳定 id）
              //   2) 否则用 role:timestamp:index 三元组
              //      —— 同一 SSE 流里 user/assistant 可能毫秒级共享 timestamp，
              //         单纯 `t${timestamp}` 会出现 key 重复（React 警告）
              //      —— role + index 用于在同 timestamp 时 disambiguate
              //   3) 兜底 i${index}（不应到达，timestamp 一般都有）
              const stableKey =
                m.entryId ??
                (m.timestamp != null
                  ? `${m.role}:${m.timestamp}:${i}`
                  : `i${i}`);
              const view = (
                <MessageView
                  msg={m}
                  index={i}
                  canFork={
                    m.role === "user" &&
                    !!m.entryId &&
                    !streaming &&
                    !forksCollapsed
                  }
                  isForking={forkingIndex === i}
                  forkText={forkText}
                  forkBusy={forkBusy}
                  onStartFork={onStartFork}
                  onCancelFork={onCancelFork}
                  onChangeForkText={onChangeForkText}
                  onSubmitFork={onSubmitFork}
                  onForkToNewSession={onForkToNewSession}
                  onOpenUrl={onOpenUrl}
                  modelLabel={messageModelLabel}
                  meta={messageMeta}
                  streamingPhase={
                    isActiveAssistant && streaming ? agentPhase : undefined
                  }
                  isStreaming={isActiveAssistant && streaming}
                  cwd={cwd}
                  onApproveCall={onApproveCall}
                  onDenyCall={onDenyCall}
                  onChooseClarification={onChooseClarification}
                  onRespondClarification={onRespondClarification}
                  onResumeWorkflow={onResumeWorkflow}
                  onWorkflowWorktreeAction={onWorkflowWorktreeAction}
                  onRetrySubagentTask={onRetrySubagentTask}
                  onResumeSubagentBatch={onResumeSubagentBatch}
                  onOpenSubagentSession={onOpenSubagentSession}
                />
              );
              if (!isVisible) return <div key={stableKey}>{view}</div>;
              return (
                <div
                  key={stableKey}
                  ref={(el) => {
                    if (currentRefIdx >= 0) messageRefs.current[currentRefIdx] = el;
                  }}
                >
                  {view}
                </div>
              );
            };
            return (
              <>
                {hiddenItemCount > 0 && (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={() =>
                        setVisibleItemLimit(
                          (limit) => limit + RENDER_ITEM_WINDOW_STEP
                        )
                      }
                      className="rounded border px-3 py-1.5 text-xs hover:bg-[color:var(--bg-hover)]"
                      style={{
                        borderColor: "var(--border-soft)",
                        color: "var(--text-muted)",
                        background: "var(--bg)",
                      }}
                    >
                      显示更早的 {Math.min(hiddenItemCount, RENDER_ITEM_WINDOW_STEP)} 条
                    </button>
                  </div>
                )}
                {visibleRenderItems.map((item) => {
                  if (item.kind === "message") {
                    return renderMessage(item.message, item.index, "normal");
                  }
                  const stableKey = `process:${item.messages[0]?.index ?? "x"}:${
                    item.messages.at(-1)?.index ?? "x"
                  }`;
                  const refSlot =
                    visibleOrdinalByMessageIndex[item.messages[0]?.index ?? -1] ??
                    -1;
                  return (
                    <div
                      key={stableKey}
                      ref={(el) => {
                        if (refSlot >= 0) messageRefs.current[refSlot] = el;
                      }}
                    >
                      <CollapsedProcessGroup
                        items={item.messages}
                        renderMessage={(message, index) =>
                          renderMessage(message, index, "none")
                        }
                      />
                    </div>
                  );
                })}
              </>
            );
          })()}
          {/* 仅在"刚发送 → 锚定那条 user 到屏顶"的窗口期塞 60vh 占位;
              锚定完成或用户主动滚动后即移除,避免向下滚到无内容空白区。 */}
          {pinSpacer && <div aria-hidden style={{ minHeight: "60vh" }} />}
          {/* 列表底部留一点 padding,让最后一条气泡和输入框之间不贴边 */}
          <div aria-hidden style={{ height: 24 }} />
          <div ref={messagesEndRef} />
        </div>
      </div>
      <ChatMinimap
        messages={messages}
        scrollContainer={messagesScrollRef}
        messageRefs={messageRefs}
      />
    </div>
  );
}

type RenderItem =
  | { kind: "message"; message: ChatMessage; index: number }
  | {
      kind: "process_group";
      messages: Array<{ message: ChatMessage; index: number }>;
    };

function buildVisibleOrdinalByMessageIndex(messages: ChatMessage[]): number[] {
  const ordinals: number[] = [];
  let ordinal = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const role = messages[i].role;
    if (role === "user" || role === "assistant") {
      ordinals[i] = ordinal;
      ordinal += 1;
    }
  }
  return ordinals;
}

function buildCollapsedProcessItems({
  messages,
}: {
  messages: ChatMessage[];
}): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message.role !== "user") {
      const blockStart = i;
      let blockEnd = blockStart;
      while (blockEnd < messages.length && messages[blockEnd].role !== "user") {
        blockEnd += 1;
      }
      appendAssistantBlockItems(messages, blockStart, blockEnd, items);
      i = blockEnd;
      continue;
    }

    items.push({ kind: "message", message, index: i });
    const blockStart = i + 1;
    let blockEnd = blockStart;
    while (blockEnd < messages.length && messages[blockEnd].role !== "user") {
      blockEnd += 1;
    }

    appendAssistantBlockItems(messages, blockStart, blockEnd, items);
    i = blockEnd;
  }
  return items;
}

function appendAssistantBlockItems(
  messages: ChatMessage[],
  blockStart: number,
  blockEnd: number,
  items: RenderItem[]
) {
  const finalAnswerIndex = findFinalAnswerIndex(messages, blockStart, blockEnd);
  const canCollapse = finalAnswerIndex >= 0;

  let j = blockStart;
  while (j < blockEnd) {
    const current = messages[j];
    if (
      canCollapse &&
      j < finalAnswerIndex &&
      current.role === "assistant" &&
      isProcessOnlyAssistant(current)
    ) {
      const group: Array<{ message: ChatMessage; index: number }> = [];
      while (
        j < finalAnswerIndex &&
        messages[j].role === "assistant" &&
        isProcessOnlyAssistant(messages[j])
      ) {
        group.push({ message: messages[j], index: j });
        j += 1;
      }
      items.push({ kind: "process_group", messages: group });
      continue;
    }
    items.push({ kind: "message", message: current, index: j });
    j += 1;
  }
}

function findFinalAnswerIndex(
  messages: ChatMessage[],
  start: number,
  end: number
): number {
  for (let i = end - 1; i >= start; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant" && hasTextAnswer(message)) return i;
  }
  return -1;
}

function hasTextAnswer(message: ChatMessage): boolean {
  return messageParts(message).some(
    (part) => part.kind === "text" && part.text.trim().length > 0
  );
}

function isProcessOnlyAssistant(message: ChatMessage): boolean {
  const parts = messageParts(message);
  if (parts.length === 0) return false;
  return !parts.some((part) => part.kind === "text" && part.text.trim().length > 0);
}

function messageParts(message: ChatMessage): MessagePart[] {
  const parts = message.parts ?? [];
  if (parts.length > 0) return parts;
  const fallback: MessagePart[] = [];
  if (message.thinking) fallback.push({ kind: "thinking", text: message.thinking });
  if (message.text) fallback.push({ kind: "text", text: message.text });
  return fallback;
}

function CollapsedProcessGroup({
  items,
  renderMessage,
}: {
  items: Array<{ message: ChatMessage; index: number }>;
  renderMessage: (message: ChatMessage, index: number) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarizeProcessGroup(items.map((item) => item.message));
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
          <span className="block truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
            {summary.detail}
          </span>
        </span>
        <span
          className="shrink-0 text-[11px] opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: "var(--text-muted)" }}
        >
          {open ? "收起 ▾" : "展开细节 ▸"}
        </span>
      </button>
      {open ? (
        <div
          className="space-y-4 border-t px-3 py-3"
          style={{ borderColor: "var(--border-soft)" }}
        >
          {items.map((item) => renderMessage(item.message, item.index))}
        </div>
      ) : null}
    </div>
  );
}

function summarizeProcessGroup(messages: ChatMessage[]): {
  title: string;
  detail: string;
} {
  let tools = 0;
  let thinking = 0;
  let approvals = 0;
  let errorCount = 0;
  const names = new Map<string, number>();

  for (const message of messages) {
    for (const part of messageParts(message)) {
      if (part.kind === "tool") {
        tools += 1;
        names.set(part.toolName, (names.get(part.toolName) ?? 0) + 1);
        if (part.status === "error" || part.isError) errorCount += 1;
      } else if (part.kind === "thinking") {
        thinking += 1;
      } else if (part.kind === "approval") {
        approvals += 1;
      }
    }
  }

  const topNames = [...names.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
  const chunks = [
    tools > 0 ? `${tools} 个工具调用` : "",
    thinking > 0 ? `${thinking} 段思考` : "",
    approvals > 0 ? `${approvals} 个确认` : "",
  ].filter(Boolean);
  const stepCount = tools + thinking + approvals || messages.length;
  return {
    title:
      errorCount > 0
        ? `已处理 ${stepCount} 个步骤，期间遇到 ${errorCount} 个问题并已恢复`
        : `已处理 ${stepCount} 个步骤`,
    detail: topNames.length > 0 ? topNames.join(" / ") : chunks.join(" / ") || "过程记录",
  };
}

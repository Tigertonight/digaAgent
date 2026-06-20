"use client";

import type { RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { MessageView } from "./MessageView";
import { UiFaultBoundary } from "./UiFaultBoundary";
import { ChatMinimap } from "../ChatMinimap";
import type { ChatMessage } from "@/lib/types";
import type { MessagePart } from "@/lib/types";
import type { AgentPhase } from "@/lib/session-runner";
import type { ProviderInfo } from "@/lib/types";
import type { WorkflowWorktreeAction } from "./MessageView";
import {
  buildProcessSummary,
  type ProcessSummary,
} from "@/lib/process-summary";
import {
  deriveTurnChromeState,
  isLastAssistantOfTurn,
} from "@/lib/turn-state";
import { normalizeMessageParts } from "@/lib/ui-shape/normalize";

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
  compacting: boolean;
  compactError: string | null;
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
  /** Dynamic workflow：直接重跑同一个历史 workflow script */
  onRetryWorkflow?: (workflowId: string) => Promise<void> | void;
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
  compacting,
  compactError,
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
  onRetryWorkflow,
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

  // 性能：逐条派生数据【ref-cached】。
  // 上一版用 useMemo + [messages]，但 reducer 每次 token 都会返回新的 messages 数组，
  // 导致整个数组重建，未变动条的 messageMeta/questionContext 也变成新引用 →
  // MessageView 的 memo 深度失效。
  // 改成按条 diff：上一次 cache 里同一 index 的 message 引用未变 → 复用完整 cell（包括引用）。
  // 这样 streaming 期间 N 条历史消息的 props 引用 100% 稳定，只有被动的 active assistant 重算。
  type DerivedCell = {
    msgRef: ChatMessage;
    messageMeta: { input: number; output: number; cost: number } | undefined;
    messageModelLabel: string | undefined;
    questionContext: string | undefined;
    stableKey: string;
  };
  const messageDerivedCacheRef = useRef<DerivedCell[]>([]);
  // currentProvider / modelId 变了，需要全量重算（modelLabel 依赖它们）。
  const lastProviderKeyRef = useRef<string | null>(null);
  const providerKey = `${currentProvider?.provider ?? ""}::${modelId}`;
  const messageDerived = useMemo(() => {
    const providerModels = currentProvider?.models;
    const fallbackModelLabel = providerModels?.find((mm) => mm.id === modelId)?.name;
    const prev = messageDerivedCacheRef.current;
    const providerChanged = lastProviderKeyRef.current !== providerKey;
    const out: DerivedCell[] = new Array(messages.length);
    // userTextDirty：表示"从上一个 user 到现在"期间是否发生过 user 消息变动。
    // 一旦 dirty，该区间内的 assistant 必须重算 questionContext。遇到下一个 user 后重置。
    let lastUserText = "";
    let userTextDirty = false;
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i];
      if (m.role === "user") {
        const cached = prev[i];
        // 遇到新/变动的 user：重新计算 lastUserText，标记区间 dirty。
        const userChanged = !cached || cached.msgRef !== m;
        const fromParts = normalizeMessageParts(m.parts, {
          surface: "MessagesScrollArea.derived",
          fieldPath: `messages.${i}.parts`,
        })
          .map((part) => (part.kind === "text" ? part.text : ""))
          .join(" ")
          .trim();
        lastUserText = (fromParts || m.text || "").trim();
        // user 区间重置 dirty：如果 user 本身变了才 dirty；不变则继续使用上次 cache。
        userTextDirty = userChanged;
      }
      const cached = prev[i];
      const canReuse =
        !providerChanged &&
        cached &&
        cached.msgRef === m &&
        // assistant + user 区间变动过 → questionContext 也要重算
        !(m.role === "assistant" && userTextDirty);
      if (canReuse) {
        out[i] = cached;
        continue;
      }
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
          ? providerModels?.find((mm) => mm.id === m.meta?.model)?.name ??
            m.meta.model
          : m.meta?.model ?? fallbackModelLabel;
      const stableKey =
        m.entryId ??
        (m.timestamp != null
          ? `${m.role}:${m.timestamp}:${i}`
          : `i${i}`);
      out[i] = {
        msgRef: m,
        messageMeta,
        messageModelLabel,
        questionContext: m.role === "assistant" ? lastUserText : undefined,
        stableKey,
      };
    }
    messageDerivedCacheRef.current = out;
    lastProviderKeyRef.current = providerKey;
    return out;
  }, [messages, currentProvider, modelId, providerKey]);

  const hiddenItemCount = Math.max(0, renderItems.length - visibleItemLimit);
  const visibleRenderItems =
    hiddenItemCount > 0 ? renderItems.slice(hiddenItemCount) : renderItems;

  return (
    <div className="relative flex flex-1 overflow-hidden">
      <div
        ref={messagesScrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto"
        // 【产品规则】关掉浏览器默认的 scroll anchoring。
        //
        // Chrome 默认的 overflow-anchor:auto 会在列表上方内容变化时
        // 自动调 scrollTop 让“当前划错环”元素保持原位。本列表的场景下这个
        // 启发尝是鬼：
        //   - streaming token 流不断往底部追加内容 → 浏览器以为你在“看小接中间某条”
        //     → 为了让那条保持原位会把你 不断往上拉，看起来就是“回弹到上一个锡点”。
        //   - cv-auto 节点 layout 变动反复触发 anchor 调整，手感拖动。
        //
        // 我们自己在 ChatApp 里用 stickToBottomRef + USER_SCROLL_LOCK_MS 订制了“贴底
        // 跟随” · “用户手动滚后 400ms 不抢”的逻辑，不需要浏览器额外 anchor。
        style={{ overflowAnchor: "none" }}
      >
        <div className="mx-auto w-full max-w-[820px] px-4 py-5 space-y-4">
          {error && (
            <div
              className="rounded-token border p-3 text-token-sm"
              style={{
                background: "var(--color-danger-bg)",
                borderColor: "var(--color-danger)",
                color: "var(--color-danger)",
              }}
            >
              {error}
            </div>
          )}
          {(() => {
            const renderMessage = (
              m: ChatMessage,
              i: number,
              refMode: "normal" | "none",
              assistantChrome: "full" | "content" = "full"
            ) => {
              const isVisible =
                m.role === "user" || m.role === "assistant";
              const currentRefIdx =
                isVisible && refMode === "normal"
                  ? visibleOrdinalByMessageIndex[i] ?? -1
                  : -1;
              const isActiveAssistant =
                m.role === "assistant" && i === activeAssistantIndex;
              // Q1–Q3 turn chrome：deriveTurnChromeState 纯函数判定。
              const turnState = deriveTurnChromeState({
                messages,
                index: i,
                streaming,
                isActiveAssistant,
              });
              // 性能：逐条派生数据上面 useMemo 完成，这里只读。
              // 同一条消息未变 → derived 引用不变 → MessageView memo 生效。
              const derived = messageDerived[i];
              const messageMeta = derived?.messageMeta;
              const messageModelLabel = derived?.messageModelLabel;
              const stableKey = derived?.stableKey ?? `i${i}`;
              const questionContext = derived?.questionContext;
              const safeMessage = m.parts
                ? {
                    ...m,
                    parts: normalizeMessageParts(m.parts, {
                      surface: "MessagesScrollArea.render",
                      fieldPath: `messages.${i}.parts`,
                    }),
                  }
                : m;
              const view = (
                <UiFaultBoundary
                  surface={`message:${i}`}
                  fallbackTitle="消息渲染异常，已隔离该消息"
                >
                  <MessageView
                    msg={safeMessage}
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
                    assistantChrome={assistantChrome}
                    turnState={turnState}
                    meta={messageMeta}
                    streamingPhase={
                      streaming &&
                      (isActiveAssistant ||
                        (m.role === "assistant" &&
                          isLastAssistantOfTurn(messages, i)))
                        ? agentPhase
                        : undefined
                    }
                    isStreaming={isActiveAssistant && streaming}
                    cwd={cwd}
                    questionContext={questionContext}
                    onApproveCall={onApproveCall}
                    onDenyCall={onDenyCall}
                    onChooseClarification={onChooseClarification}
                    onRespondClarification={onRespondClarification}
                    onResumeWorkflow={onResumeWorkflow}
                    onRetryWorkflow={onRetryWorkflow}
                    onWorkflowWorktreeAction={onWorkflowWorktreeAction}
                    onRetrySubagentTask={onRetrySubagentTask}
                    onResumeSubagentBatch={onResumeSubagentBatch}
                    onOpenSubagentSession={onOpenSubagentSession}
                  />
                </UiFaultBoundary>
              );
              if (!isVisible)
                return (
                  <div key={stableKey} className="cv-auto">
                    {view}
                  </div>
                );
              return (
                <div
                  key={stableKey}
                  ref={(el) => {
                    if (currentRefIdx >= 0) messageRefs.current[currentRefIdx] = el;
                  }}
                  className="cv-auto"
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
                  const groupLastIndex = item.messages.at(-1)?.index ?? -1;
                  const forceExecuting = shouldForceProcessGroupExecuting(
                    messages,
                    groupLastIndex,
                    streaming
                  );
                  const refSlot =
                    visibleOrdinalByMessageIndex[item.messages[0]?.index ?? -1] ??
                    -1;
                  return (
                    <div
                      key={stableKey}
                      ref={(el) => {
                        if (refSlot >= 0) messageRefs.current[refSlot] = el;
                      }}
                      className="cv-auto"
                    >
                      <CollapsedProcessGroup
                        items={item.messages}
                        forceExecuting={forceExecuting}
                        renderMessage={(message, index) =>
                          renderMessage(message, index, "none", "content")
                        }
                      />
                    </div>
                  );
                })}
                {(compacting || compactError) && (
                  <ContextCompactionDivider
                    compacting={compacting}
                    error={compactError}
                  />
                )}
              </>
            );
          })()}
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

function ContextCompactionDivider({
  compacting,
  error,
}: {
  compacting: boolean;
  error: string | null;
}) {
  const tone = error && !compacting ? "error" : "muted";
  return (
    <div
      className="flex items-center gap-3 py-1"
      role={compacting ? "status" : error ? "alert" : undefined}
      aria-live="polite"
    >
      <div
        className="h-px flex-1"
        style={{
          background:
            tone === "error"
              ? "var(--color-danger)"
              : "var(--border-soft)",
        }}
      />
      <div
        className="inline-flex max-w-[70%] items-center gap-2 rounded-full border px-3 py-1 text-token-xs"
        style={{
          borderColor:
            tone === "error" ? "var(--color-danger)" : "var(--border-soft)",
          background: "var(--bg)",
          color: tone === "error" ? "var(--color-danger)" : "var(--text-muted)",
        }}
        title={error ?? undefined}
      >
        {compacting && (
          <Loader2
            size={12}
            className="animate-spin"
            aria-hidden="true"
          />
        )}
        <span className="truncate">
          {compacting
            ? "正在压缩上下文"
            : `上下文压缩失败：${error ?? "未知错误"}`}
        </span>
      </div>
      <div
        className="h-px flex-1"
        style={{
          background:
            tone === "error"
              ? "var(--color-danger)"
              : "var(--border-soft)",
        }}
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

export function buildCollapsedProcessItems({
  messages,
}: {
  messages: ChatMessage[];
}): RenderItem[] {
  const items: RenderItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (i > 0 && areDuplicateRestoredMessages(messages[i - 1], message)) {
      i += 1;
      continue;
    }
    if (message.role !== "user") {
      const blockStart = i;
      let blockEnd = blockStart;
      while (blockEnd < messages.length && messages[blockEnd].role !== "user") {
        blockEnd += 1;
      }
      if (
        blockEnd < messages.length &&
        shouldRenderUserBeforeAssistantBlock(messages, blockStart, blockEnd, blockEnd)
      ) {
        items.push({ kind: "message", message: messages[blockEnd], index: blockEnd });
        appendAssistantBlockItems(messages, blockStart, blockEnd, items);
        i = blockEnd + 1;
        continue;
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
    const splitBeforeNextUser =
      blockEnd < messages.length
        ? findAssistantBlockSplitBeforeUser(messages, blockStart, blockEnd, blockEnd)
        : null;
    if (splitBeforeNextUser !== null) {
      appendAssistantBlockItems(messages, blockStart, splitBeforeNextUser, items);
      items.push({
        kind: "message",
        message: messages[blockEnd],
        index: blockEnd,
      });
      appendAssistantBlockItems(messages, splitBeforeNextUser, blockEnd, items);
      i = blockEnd + 1;
      continue;
    }

    appendAssistantBlockItems(messages, blockStart, blockEnd, items);
    i = blockEnd;
  }
  return items;
}

export function dedupeAdjacentRestoredMessages(
  messages: ChatMessage[]
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    const prev = out[out.length - 1];
    if (prev && areDuplicateRestoredMessages(prev, message)) continue;
    out.push(message);
  }
  return out;
}

function areDuplicateRestoredMessages(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.entryId && b.entryId && a.entryId === b.entryId) return true;
  if (a.role !== "user") return false;
  const aText = textForDedupe(a);
  const bText = textForDedupe(b);
  if (!aText || aText !== bText) return false;
  const aTs = typeof a.timestamp === "number" ? a.timestamp : null;
  const bTs = typeof b.timestamp === "number" ? b.timestamp : null;
  if (aTs === null || bTs === null) return true;
  return Math.abs(aTs - bTs) <= 1000;
}

function textForDedupe(message: ChatMessage): string {
  return messageParts(message)
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function shouldForceProcessGroupExecuting(
  messages: ChatMessage[],
  groupLastIndex: number,
  streaming: boolean
): boolean {
  if (!streaming) return false;
  const laterMessages = messages.slice(groupLastIndex + 1);
  if (laterMessages.some((message) => message.role === "user")) return false;
  return !laterMessages.some(
    (message) => message.role === "assistant" && hasTextAnswer(message)
  );
}

function findAssistantBlockSplitBeforeUser(
  messages: ChatMessage[],
  blockStart: number,
  blockEnd: number,
  userIndex: number
): number | null {
  const userTs = messages[userIndex]?.timestamp;
  if (typeof userTs !== "number" || !Number.isFinite(userTs)) return null;
  for (let split = blockStart; split < blockEnd; split += 1) {
    const suffix = messages.slice(split, blockEnd);
    if (
      suffix.some(
        (message) =>
          message.role === "assistant" &&
          typeof message.timestamp === "number" &&
          Number.isFinite(message.timestamp) &&
          message.timestamp >= userTs
      ) &&
      suffix.every((message) => {
        if (message.role !== "assistant") return true;
        return (
          typeof message.timestamp === "number" &&
          Number.isFinite(message.timestamp) &&
          message.timestamp >= userTs
        );
      })
    ) {
      return split;
    }
  }
  return null;
}

function shouldRenderUserBeforeAssistantBlock(
  messages: ChatMessage[],
  blockStart: number,
  blockEnd: number,
  userIndex: number
): boolean {
  const userTs = messages[userIndex]?.timestamp;
  if (typeof userTs !== "number" || !Number.isFinite(userTs)) return false;
  let hasAssistant = false;
  for (let i = blockStart; i < blockEnd; i += 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    hasAssistant = true;
    const assistantTs = message.timestamp;
    if (typeof assistantTs !== "number" || !Number.isFinite(assistantTs)) {
      return false;
    }
    if (assistantTs < userTs) return false;
  }
  return hasAssistant;
}

function appendAssistantBlockItems(
  messages: ChatMessage[],
  blockStart: number,
  blockEnd: number,
  items: RenderItem[]
) {
  let j = blockStart;
  while (j < blockEnd) {
    const current = messages[j];
    if (isCollapsibleProcessAssistant(messages, j, blockEnd)) {
      const group: Array<{ message: ChatMessage; index: number }> = [];
      while (
        j < blockEnd &&
        isCollapsibleProcessAssistant(messages, j, blockEnd)
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

function hasTextAnswer(message: ChatMessage): boolean {
  return messageParts(message).some(
    (part) => part.kind === "text" && part.text.trim().length > 0
  );
}

function isCollapsibleProcessAssistant(
  messages: ChatMessage[],
  index: number,
  blockEnd: number
): boolean {
  const message = messages[index];
  if (message.role !== "assistant") return false;
  const parts = messageParts(message);
  if (parts.some(isPendingUserBlockerPart)) return false;
  if (message.stopReason === "tool_use") return true;
  if (!isLastAssistantInBlock(messages, index, blockEnd)) return true;
  // Some SDK turns only carry model/usage metadata. Rendering them as standalone
  // assistant messages creates the repeated “GPT-5.5 + token row” whitespace; in
  // the conversation hierarchy they are part of the surrounding execution trace.
  if (parts.length === 0) return Boolean(message.meta?.usage || message.meta?.model);
  return !parts.some((part) => part.kind === "text" && part.text.trim().length > 0);
}

function isLastAssistantInBlock(
  messages: ChatMessage[],
  index: number,
  blockEnd: number
): boolean {
  for (let j = index + 1; j < blockEnd; j += 1) {
    if (messages[j].role === "assistant") return false;
  }
  return true;
}

function messageParts(message: ChatMessage): MessagePart[] {
  let parts: MessagePart[] = message.parts ? [...message.parts] : [];
  // Keep compatibility with mixed legacy/parts messages: a turn may have tool
  // parts plus final text on `message.text`. If we ignore that field, the final
  // answer is misclassified as process-only and hidden inside the execution card.
  if (message.thinking && !parts.some((part) => part.kind === "thinking")) {
    parts = [...parts, { kind: "thinking", text: message.thinking }];
  }
  if (
    message.text &&
    !parts.some((part) => part.kind === "text" && part.text === message.text)
  ) {
    parts = [...parts, { kind: "text", text: message.text }];
  }
  return parts;
}

function isPendingUserBlockerPart(part: MessagePart): boolean {
  return (
    (part.kind === "approval" || part.kind === "clarification") &&
    part.status === "pending"
  );
}

function CollapsedProcessGroup({
  items,
  forceExecuting,
  renderMessage,
}: {
  items: Array<{ message: ChatMessage; index: number }>;
  forceExecuting: boolean;
  renderMessage: (message: ChatMessage, index: number) => React.ReactNode;
}) {
  const summary = summarizeProcessGroup(
    items.map((item) => item.message),
    forceExecuting
  );
  const hasActiveProcessPart = hasActiveProcessPartInItems(items);
  // 【产品规则】live = “还在处理中”：
  //   - hasActiveProcessPart：组内有 running tool / pending approval-clarification
  //   - forceExecuting：streaming 且该组后还没出现最终文本（推论全闭环还没走完）
  // 两者任一为 true → 自动展开；全部为 false → 自动折叠（除非用户手动展了）。
  const live = forceExecuting || hasActiveProcessPart;
  const nowMs = useSecondTick(live);
  const [manualOpen, setManualOpen] = useState(false);
  const open = live || manualOpen;
  return (
    <div
      className="group text-token-xs"
      data-testid="assistant-process-group"
    >
      <button
        type="button"
        onClick={() => {
          // live 期间不走手动切换，避免“状态中锁定”反感。
          // live 结束后才允许用户点开/收起看细节。
          if (!live) setManualOpen((value) => !value);
        }}
        className="inline-flex items-center gap-2 py-0.5 text-left"
        aria-expanded={open}
        data-testid="assistant-process-toggle"
        style={{ color: "var(--text-muted)" }}
      >
        {live ? (
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{
              background: "var(--accent)",
              boxShadow: "0 0 0 3px var(--color-accent-bg)",
            }}
            aria-hidden
          />
        ) : null}
        <span className="truncate">
          {formatProcessSummaryTitle(summary, items, { live, nowMs })}
        </span>
      </button>
      {open ? (
        <div className="space-y-2 pl-4 pt-2">
          {items.map((item) => renderMessage(item.message, item.index))}
        </div>
      ) : null}
    </div>
  );
}

function summarizeProcessGroup(
  messages: ChatMessage[],
  forceExecuting: boolean
): ProcessSummary {
  return buildProcessSummary({ messages, forceRunning: forceExecuting });
}

function formatProcessSummaryTitle(
  summary: ReturnType<typeof buildProcessSummary>,
  items: Array<{ message: ChatMessage; index: number }>,
  opts: { live?: boolean; nowMs?: number } = {}
) {
  const hasActiveProcessPart = hasActiveProcessPartInItems(items);
  const issueTitle = processIssueTitle(summary, { running: hasActiveProcessPart });
  if (issueTitle) return issueTitle;
  if (opts.live) {
    const elapsedLabel = formatProcessElapsed(items, { nowMs: opts.nowMs });
    return elapsedLabel ? `处理中 ${elapsedLabel}` : "处理中";
  }
  const elapsedLabel = formatProcessElapsed(items);
  return elapsedLabel ? `已处理 ${elapsedLabel}` : "已处理";
}

function useSecondTick(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const tick = () => setNowMs(Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return nowMs;
}

function hasActiveProcessPartInItems(
  items: Array<{ message: ChatMessage; index: number }>
): boolean {
  return items.some((item) =>
    messageParts(item.message).some((part) => {
      if (part.kind === "tool") return part.status === "running";
      if (part.kind === "approval" || part.kind === "clarification") {
        return part.status === "pending";
      }
      return false;
    })
  );
}

function processIssueTitle(
  summary: ReturnType<typeof buildProcessSummary>,
  opts: { running?: boolean } = {}
) {
  if (summary.errorRecoveredCount <= 0) return null;
  const running = opts.running ?? summary.running;
  const markers = running ? ["执行失败"] : ["已处理："];
  for (const marker of markers) {
    const index = summary.title.indexOf(marker);
    if (index >= 0) return summary.title.slice(index);
  }
  if (!running) {
    return summary.errorRecoveredCount > 1
      ? `已处理：${summary.errorRecoveredCount} 个步骤曾失败`
      : "已处理：1 个步骤曾失败";
  }
  return summary.errorRecoveredCount > 1
    ? `执行失败：${summary.errorRecoveredCount} 个步骤`
    : "执行失败";
}

function formatProcessElapsed(
  items: Array<{ message: ChatMessage; index: number }>,
  opts: { nowMs?: number } = {}
): string | null {
  const timestamps = items
    .map((item) => item.message.timestamp)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (timestamps.length === 0) return null;
  const startMs = timestamps[0];
  const endMs = opts.nowMs ?? timestamps[timestamps.length - 1];
  if (!opts.nowMs && timestamps.length < 2) return null;
  const elapsedMs = endMs - startMs;
  if (elapsedMs <= 0) return null;
  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

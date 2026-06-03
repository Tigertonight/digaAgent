"use client";

import type { RefObject } from "react";
import { MessageView } from "./MessageView";
import { ChatMinimap } from "../ChatMinimap";
import type { ChatMessage } from "@/lib/types";
import type {
  AgentPhase,
  StatsSnapshot,
} from "@/lib/session-runner";
import type { ProviderInfo } from "@/lib/types";

interface MessagesScrollAreaProps {
  // data
  messages: ChatMessage[];
  error: string | null;
  currentProvider: ProviderInfo | undefined;
  modelId: string;
  stats: StatsSnapshot | null;
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
  /** RFC-2 Phase B3/B4：approval part 点 Allow（B4 加 opts.remember） */
  onApproveCall?: (
    toolCallId: string,
    opts?: { remember?: "this-session"; ruleId?: string }
  ) => void;
  /** RFC-2 Phase B3：approval part 点 Deny */
  onDenyCall?: (toolCallId: string) => void;
  /** RFC-5：clarification 推荐项点击 */
  onChooseClarification?: (requestId: string, optionId: string) => void;
  /** RFC-5：clarification 自定义回复 */
  onRespondClarification?: (requestId: string, customText: string) => void;
}

export function MessagesScrollArea({
  messages,
  error,
  currentProvider,
  modelId,
  stats,
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
  onApproveCall,
  onDenyCall,
  onChooseClarification,
  onRespondClarification,
}: MessagesScrollAreaProps) {
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
            const lastAssistantIdx = (() => {
              for (let k = messages.length - 1; k >= 0; k--) {
                if (messages[k].role === "assistant") return k;
              }
              return -1;
            })();
            const modelLabel = currentProvider?.models.find(
              (mm) => mm.id === modelId
            )?.name;
            let refIdx = 0;
            return messages.map((m, i) => {
              const isVisible =
                m.role === "user" || m.role === "assistant";
              const currentRefIdx = isVisible ? refIdx++ : -1;
              const isLastAssistant =
                m.role === "assistant" && i === lastAssistantIdx;
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
                  modelLabel={modelLabel}
                  meta={
                    isLastAssistant && stats && stats.total > 0
                      ? {
                          input: stats.input,
                          output: stats.output,
                          cost: stats.cost,
                        }
                      : undefined
                  }
                  streamingPhase={
                    isLastAssistant && streaming ? agentPhase : undefined
                  }
                  isStreaming={isLastAssistant && streaming}
                  cwd={cwd}
                  onApproveCall={onApproveCall}
                  onDenyCall={onDenyCall}
                  onChooseClarification={onChooseClarification}
                  onRespondClarification={onRespondClarification}
                />
              );
              if (!isVisible) return <div key={stableKey}>{view}</div>;
              return (
                <div
                  key={stableKey}
                  ref={(el) => {
                    messageRefs.current[currentRefIdx] = el;
                  }}
                >
                  {view}
                </div>
              );
            });
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

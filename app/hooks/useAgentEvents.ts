"use client";

/**
 * useAgentEvents —— SSE agent 事件分发器（RFC-1 阶段 A3）
 *
 * 职责：
 *   - 接收一条 SSE agent event，按 event.type 分发到对应 handler
 *   - 每个 handler 负责把变化写到 runner（通过注入的 updateRunner）
 *   - 必要时触发全局副作用（playDoneSound / refreshSessions / refreshForkList / refreshStats）
 *
 * 设计要点：
 *   - hook 不持有任何状态；所有依赖通过 options 注入（依赖反转）
 *   - 内部按 event.type 拆成 N 个小函数（onAgentStart / onAgentEnd / ...），
 *     便于阅读和后续按需单测
 *   - reducer 事件（message_* / tool_execution_*）保留 reducer 风格，phase 派生
 *     抽到 derivePhaseFromReducerEvent 辅助函数
 *
 * 不在本 hook 内的职责：
 *   - SSE 连接生命周期 → useSseManager（A2）
 *   - runner 容器写入 → useRunners（A1）；本 hook 只是 updateRunner 的调用方
 *
 * 上游：useSseManager.onEvent → 本 hook 的 handleAgentEvent
 * 下游：useRunners.updateRunner + useAudio.playDoneSound + ChatApp 的 refresh* 回调
 */

import { useCallback } from "react";
import { applyEvent } from "@/lib/chat-reducer";
import type {
  AgentPhase,
  RunnerKey,
  RunnerPatch,
} from "@/lib/session-runner";
import type { ThinkingLevel } from "@/lib/types";

/** SSE event 的通用形状 —— 业务字段通过 cast 收窄 */
type AgentEvent = { type: string; [k: string]: unknown };

export interface UseAgentEventsOptions {
  /** 写 runner 状态（来自 useRunners） */
  updateRunner: (key: RunnerKey, patch: RunnerPatch) => void;
  /** agent_end 时播提示音（来自 useAudio） */
  playDoneSound: () => void;
  /** agent_end 时刷新左侧 session 列表 */
  refreshSessions: () => void;
  /** agent_end 时刷新 fork 入口列表 */
  refreshForkList: (agentId: string, ownerKey: RunnerKey) => void;
  /** agent_end / compaction_end 时刷新 tokens/cost 统计 */
  refreshStats: (agentId: string, ownerKey: RunnerKey) => void;
}

export interface UseAgentEventsReturn {
  /**
   * SSE 事件入口；useSseManager.onEvent 直接转发到这里。
   *
   * @param event  SSE 反序列化后的 agent event 对象
   * @param agentId 该连接对应的 agentId
   * @param ownerKey 事件归属的 runner key（**不一定等于当前活跃 runner**）
   *                 切到 B 时 A 的 SSE 仍在跑，A 的事件 ownerKey=A 会写到 runnersRef.get(A)，
   *                 updateRunner 内部判断 ownerKey === activeKey 才同步 setActiveSnapshot，
   *                 所以 A 的事件不会污染 B 的渲染。
   */
  handleAgentEvent: (
    event: AgentEvent,
    agentId: string,
    ownerKey: RunnerKey
  ) => void;
}

/**
 * 从一条 reducer event 派生新的 agentPhase。
 *
 * 规则（与 pi-web 对齐）：
 *   - message_update + thinking_delta → phase=thinking（除非正在 running_tools）
 *   - message_update + text_delta     → phase=null（除非正在 running_tools）
 *   - message_end                     → phase=waiting_model
 *   - tool_execution_start            → phase=running_tools（添加该 tool 到列表）
 *   - tool_execution_end              → 从 running_tools 移除该 tool；空了切回 waiting_model
 *   - 其他                            → phase 不变
 *
 * 抽成独立函数的原因：原 113 行 handleAgentEvent 里最难读的就是这段嵌套 if。
 */
function derivePhaseFromReducerEvent(
  ev: AgentEvent,
  prevPhase: AgentPhase
): AgentPhase {
  if (ev.type === "message_update") {
    const sub = (ev as { assistantMessageEvent?: { type?: string } })
      .assistantMessageEvent;
    if (sub?.type === "thinking_delta") {
      if (prevPhase?.kind !== "running_tools") return { kind: "thinking" };
    } else if (sub?.type === "text_delta") {
      if (prevPhase?.kind !== "running_tools") return null;
    }
    return prevPhase;
  }
  if (ev.type === "message_end") {
    return { kind: "waiting_model" };
  }
  if (ev.type === "tool_execution_start") {
    const id = (ev as { toolCallId?: string }).toolCallId;
    const name = (ev as { toolName?: string }).toolName;
    if (id && name) {
      const tools =
        prevPhase?.kind === "running_tools" ? [...prevPhase.tools] : [];
      if (!tools.some((t) => t.id === id)) tools.push({ id, name });
      return { kind: "running_tools", tools };
    }
    return prevPhase;
  }
  if (ev.type === "tool_execution_end") {
    const id = (ev as { toolCallId?: string }).toolCallId;
    if (id && prevPhase?.kind === "running_tools") {
      const tools = prevPhase.tools.filter((t) => t.id !== id);
      return tools.length === 0
        ? { kind: "waiting_model" }
        : { kind: "running_tools", tools };
    }
    return prevPhase;
  }
  return prevPhase;
}

export function useAgentEvents(
  opts: UseAgentEventsOptions
): UseAgentEventsReturn {
  const {
    updateRunner,
    playDoneSound,
    refreshSessions,
    refreshForkList,
    refreshStats,
  } = opts;

  const handleAgentEvent = useCallback<UseAgentEventsReturn["handleAgentEvent"]>(
    (ev, aidForEvents, ownerKey) => {
      switch (ev.type) {
        // ===== 流式生命周期 =====
        case "agent_start":
          updateRunner(ownerKey, {
            streaming: true,
            agentPhase: { kind: "waiting_model" },
          });
          return;

        case "agent_end":
          updateRunner(ownerKey, {
            streaming: false,
            agentPhase: null,
            retryInfo: null,
          });
          playDoneSound();
          refreshSessions();
          if (aidForEvents) {
            void refreshForkList(aidForEvents, ownerKey);
            void refreshStats(aidForEvents, ownerKey);
          }
          return;

        // ===== 压缩 =====
        case "compaction_start":
        case "auto_compaction_start":
          updateRunner(ownerKey, { compacting: true, compactError: null });
          return;

        case "compaction_end":
        case "auto_compaction_end": {
          const err =
            (ev as { error?: string; errorMessage?: string }).error ??
            (ev as { errorMessage?: string }).errorMessage;
          updateRunner(ownerKey, {
            compacting: false,
            ...(err ? { compactError: err } : {}),
          });
          if (aidForEvents) void refreshStats(aidForEvents, ownerKey);
          return;
        }

        // ===== 自动重试 =====
        case "auto_retry_start": {
          const e = ev as {
            attempt?: number;
            maxAttempts?: number;
            errorMessage?: string;
          };
          if (e.attempt && e.maxAttempts) {
            updateRunner(ownerKey, {
              retryInfo: {
                attempt: e.attempt,
                maxAttempts: e.maxAttempts,
                errorMessage: e.errorMessage,
              },
            });
          }
          return;
        }

        case "auto_retry_end":
          updateRunner(ownerKey, { retryInfo: null });
          return;

        // ===== thinking 级别变更（模型切换或 fallback 触发） =====
        case "thinking_level_changed": {
          const lv = (ev as { level?: ThinkingLevel }).level;
          if (lv) updateRunner(ownerKey, { thinkingLevel: lv });
          return;
        }

        // ===== reducer 驱动事件（message_* / tool_execution_*） =====
        // 这些事件需要基于"当前 runner 的 chatState"做 reducer，所以走 patch-as-function 形式
        case "message_start":
        case "message_update":
        case "message_end":
        case "tool_execution_start":
        case "tool_execution_update":
        case "tool_execution_end":
          updateRunner(ownerKey, (s) => ({
            chatState: applyEvent(s.chatState, ev),
            agentPhase: derivePhaseFromReducerEvent(ev, s.agentPhase),
          }));
          return;

        default:
          return;
      }
    },
    [
      updateRunner,
      playDoneSound,
      refreshSessions,
      refreshForkList,
      refreshStats,
    ]
  );

  return { handleAgentEvent };
}

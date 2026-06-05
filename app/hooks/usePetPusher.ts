"use client";

/**
 * usePetPusher —— 把 ChatApp 的"宠物窗口状态推送"逻辑收口到一个 hook。
 *
 * 设计要点（沿用 ChatApp 原实现）：
 * 1. IPC 节流到 100ms（10Hz）—— streaming 期间 lastMessage/agentPhase 抖动很频繁
 * 2. lastMessage 截断到 200 字符（设计 §8.2）
 * 3. 派生 currentToolTarget（文件名/命令前缀）供气泡副文案使用
 * 4. 维护 streamingStartedAt（每个 session 第一次 streaming=true 时记录）
 * 5. 透传 retryInfo / compacting / sseStatus / compactError 给宠物
 * 6. 已读判定（v2 修复）：isUnread = !isRunning && (!seenAt || seenAt < s.modified)
 *    不再因为 active 就自动算已读——active 也可能"用户根本没看"（宠物前置、主窗被遮）
 * 7. 兜底：当前 selectedId 对应的 session 若没被 runner 路径加入（刚切到历史 session、
 *    agentId 还没建立），也推一个最小化条目，保证宠物侧 displaySession.find() 能命中
 *
 * Hook 的高频计时/节流状态封闭在内部 ref；外部只传入当前快照与摘要：
 *   - streamingStartedAtRef   每个 session 的 streaming 起始时间戳
 *   - petPushTimerRef         节流定时器
 *   - petLastPushedAtRef      上次推送时间
 *   - petDoPushRef            暴露 doPush 给 lastSeenMap 变化 effect
 */

import type React from "react";
import { useEffect, useRef } from "react";
import { getElectronApi } from "@/lib/electron-bridge";
import type { PetState, PetSessionInfo } from "@/lib/electron-bridge";
import type { BudgetStatus } from "@/lib/budget/types";
import type { RunnerKey, RunnerState } from "@/lib/session-runner";
import type { ChatMessage, SessionInfoLite } from "@/lib/types";
import type { BudgetTrigger } from "./useBudgetEnforcer";

/**
 * 派生宠物气泡副文案的"工具操作目标"摘要。
 *
 * 在 chatState.messages 里反向查找 toolCallId 匹配的 tool part，从 args 提取常见字段：
 * - read/edit/write: file_path / path
 * - bash:           command（截前 30 字）
 * - grep/find:      pattern / query
 * - ls:             path
 * - 其他:           null
 *
 * 文件路径只显示 basename（避免长路径撑爆气泡）。
 */
function derivePetToolTarget(
  toolName: string,
  toolCallId: string,
  messages: ChatMessage[]
): string | null {
  // 反向找最近一条 assistant 消息里的 tool part
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts;
    if (!parts) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p.kind !== "tool" || p.toolCallId !== toolCallId) continue;
      const args = (p.args ?? {}) as Record<string, unknown>;
      const lower = toolName.toLowerCase();
      // bash / 命令类
      if (lower.includes("bash") || lower.includes("shell")) {
        const cmd = typeof args.command === "string" ? args.command : null;
        return cmd ? cmd.slice(0, 30) : null;
      }
      // grep / find / search
      if (
        lower.includes("grep") ||
        lower.includes("find") ||
        lower.includes("search")
      ) {
        const q =
          typeof args.pattern === "string"
            ? args.pattern
            : typeof args.query === "string"
              ? args.query
              : null;
        return q ? q.slice(0, 30) : null;
      }
      // 文件类（read / edit / write / ls）
      const fp =
        typeof args.file_path === "string"
          ? args.file_path
          : typeof args.path === "string"
            ? args.path
            : typeof args.filePath === "string"
              ? args.filePath
              : null;
      if (fp) {
        const base = fp.split("/").pop() ?? fp;
        return base.length > 30 ? "…" + base.slice(-29) : base;
      }
      return null;
    }
  }
  return null;
}

function summarizeToolInput(input: Record<string, unknown>): string | null {
  const command = typeof input.command === "string" ? input.command : null;
  if (command) return command.slice(0, 30);

  const path =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : typeof input.filePath === "string"
          ? input.filePath
          : null;
  if (path) {
    const base = path.split("/").pop() ?? path;
    return base.length > 30 ? "…" + base.slice(-29) : base;
  }

  const query =
    typeof input.pattern === "string"
      ? input.pattern
      : typeof input.query === "string"
        ? input.query
        : null;
  return query ? query.slice(0, 30) : null;
}

function derivePendingApproval(
  messages: ChatMessage[]
): PetSessionInfo["pendingApproval"] {
  const pending: NonNullable<PetSessionInfo["pendingApproval"]>[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts;
    if (!parts) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p.kind !== "approval" || p.status !== "pending") continue;
      pending.push({
        count: 1,
        toolName: p.toolName,
        toolTarget: summarizeToolInput(p.input),
        ruleId: p.ruleId,
        createdAt: p.createdAt,
      });
    }
  }
  if (pending.length === 0) return null;
  const newest = pending[0];
  return { ...newest, count: pending.length };
}

function derivePendingClarification(
  messages: ChatMessage[]
): PetSessionInfo["pendingClarification"] {
  const pending: NonNullable<PetSessionInfo["pendingClarification"]>[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts;
    if (!parts) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p.kind !== "clarification" || p.status !== "pending") continue;
      const recommended = p.options.find(
        (opt) => opt.id === p.recommendedOptionId
      );
      pending.push({
        count: 1,
        title: p.title,
        question: p.question,
        recommendedLabel: recommended?.label ?? null,
        createdAt: p.createdAt,
      });
    }
  }
  if (pending.length === 0) return null;
  const newest = pending[0];
  return { ...newest, count: pending.length };
}

const BUDGET_WARNING_RATIO = 0.8;

function formatBudgetDimension(dim: "cost" | "turns" | "duration"): string {
  if (dim === "cost") return "费用";
  if (dim === "turns") return "轮次";
  return "时长";
}

function deriveBudgetSummary(
  status: BudgetStatus | null,
  pausedTrigger: BudgetTrigger | null
): PetSessionInfo["budget"] {
  if (!status) return null;
  const triggered =
    pausedTrigger?.triggered.length && pausedTrigger.triggered.length > 0
      ? pausedTrigger.triggered
      : status.triggered;

  if (triggered.length > 0) {
    const labels = triggered.map(formatBudgetDimension).join(" / ");
    return {
      level: "blocked",
      label: "已暂停：预算到达上限",
      detail: labels,
      triggered: [...triggered],
      peakRatio: 1,
    };
  }

  const ratios: { dim: "cost" | "turns" | "duration"; ratio: number }[] = [];
  const b = status.budget;
  const spent = status.spent;
  if (b.maxCostUsd && b.maxCostUsd > 0) {
    ratios.push({ dim: "cost", ratio: spent.costUsd / b.maxCostUsd });
  }
  if (b.maxTurns && b.maxTurns > 0) {
    ratios.push({ dim: "turns", ratio: spent.turns / b.maxTurns });
  }
  if (b.maxDurationSec && b.maxDurationSec > 0) {
    ratios.push({
      dim: "duration",
      ratio: spent.durationSec / b.maxDurationSec,
    });
  }
  if (ratios.length === 0) return null;

  let peak = ratios[0];
  for (const r of ratios) {
    if (r.ratio > peak.ratio) peak = r;
  }
  if (peak.ratio < BUDGET_WARNING_RATIO) {
    return {
      level: "ok",
      label: "预算正常",
      detail: null,
      triggered: [],
      peakRatio: peak.ratio,
    };
  }

  return {
    level: "warning",
    label: "接近预算上限",
    detail: `${formatBudgetDimension(peak.dim)} ${Math.round(peak.ratio * 100)}%`,
    triggered: [],
    peakRatio: peak.ratio,
  };
}

export interface UsePetPusherParams {
  /** runner 字典 ref（来自 useRunners） */
  runnersRef: React.MutableRefObject<Map<RunnerKey, RunnerState>>;
  /** session 列表（来自 useSessions） */
  sessions: SessionInfoLite[];
  /** 当前选中 session id */
  selectedId: string | null;
  /** 已读时间戳字典 ref（来自 useSessions，ISO 字符串字典序 = 时间序） */
  lastSeenMapRef: React.MutableRefObject<Record<string, string>>;
  /** 已读字典本体（作为 effect deps，变化时触发一次推送以消除 attention） */
  lastSeenMap: Record<string, string>;
  /** 活跃 runner 快照（作为 effect deps，涵盖 runner 流式更新） */
  activeSnapshot: unknown;
  /** 当前活跃 agent id；budgetStatus 只对应这个 agent */
  activeAgentId: string | null;
  /** 当前活跃 session 的预算状态摘要来源 */
  budgetStatus: BudgetStatus | null;
  /** Budget 命中暂停弹窗触发源，用于把 blocked 状态延续给宠物 */
  budgetPausedTrigger: BudgetTrigger | null;
}

export function usePetPusher(params: UsePetPusherParams): void {
  const {
    runnersRef,
    sessions,
    selectedId,
    lastSeenMapRef,
    lastSeenMap,
    activeSnapshot,
    activeAgentId,
    budgetStatus,
    budgetPausedTrigger,
  } = params;

  // 每个 session 的 streaming 起始时间戳（streaming false→true 时记录）
  const streamingStartedAtRef = useRef<Map<string, number>>(new Map());
  // 节流：100ms 内只发最后一次
  const petPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const petLastPushedAtRef = useRef<number>(0);
  // 暴露 doPush 给外部（lastSeenMap 变化时主动触发一次推送）
  const petDoPushRef = useRef<(() => void) | null>(null);

  // lastSeenMap 变化时触发宠物侧推送（消除 attention）。
  // ref 镜像由 useSessions 维护，这里只负责副作用触发。
  useEffect(() => {
    petDoPushRef.current?.();
  }, [lastSeenMap]);

  useEffect(() => {
    const api = getElectronApi();
    if (!api?.pet?.sendState) return;

    const doPush = () => {
      petLastPushedAtRef.current = Date.now();
      petPushTimerRef.current = null;

      const petSessions: PetSessionInfo[] = [];
      const pushedSessionIds = new Set<string>();

      for (const [key, runner] of runnersRef.current) {
        if (!runner.agentId) continue; // 跳过空 draft

        // 维护 streamingStartedAt
        const prevStart = streamingStartedAtRef.current.get(key) ?? null;
        let streamingStartedAt: number | null = prevStart;
        if (runner.streaming && prevStart == null) {
          streamingStartedAt = Date.now();
          streamingStartedAtRef.current.set(key, streamingStartedAt);
        } else if (!runner.streaming && prevStart != null) {
          streamingStartedAtRef.current.delete(key);
          streamingStartedAt = null;
        }

        const sess = sessions.find((s) => s.path === key);

        // lastMessage 截断到 200 字符
        const lastMsg = runner.chatState.messages
          .filter((m) => m.role === "assistant")
          .slice(-1)[0];
        const lastText =
          lastMsg?.parts
            ?.filter((p) => p.kind === "text")
            .slice(-1)[0]
            ?.text?.slice(0, 200) ?? "";

        // currentTool + currentToolTarget
        let currentTool: string | null = null;
        let currentToolTarget: string | null = null;
        if (runner.agentPhase?.kind === "running_tools") {
          const firstTool = runner.agentPhase.tools?.[0];
          if (firstTool) {
            currentTool = firstTool.name;
            currentToolTarget = derivePetToolTarget(
              firstTool.name,
              firstTool.id,
              runner.chatState.messages
            );
          }
        }

        // agent 级错误：以 compactError 为代表（v1 仅有这一个 runner 级错误源）
        const error = runner.compactError;

        // 已读判定（v2 宠物 attention 修复）：
        //   isUnread = !isRunning && (!seenAt || seenAt < s.modified)
        //   read     = !isUnread
        // 不再因为 active 就自动算已读——active 也可能"用户根本没看"
        // （宠物窗口前置、主窗口被遮挡）。已读由 markSessionSeen 在用户
        // 切换 / 主窗口聚焦时主动写入，宠物 attention 才有意义。
        // 没有 sess（找不到 SessionInfoLite）→ 没有 modified 可比，视为已读
        let read = true;
        if (sess) {
          const isRunning = !!sess.isRunning;
          const seenAt = lastSeenMapRef.current[sess.id];
          const isUnread =
            !isRunning && (!seenAt || seenAt < sess.modified);
          read = !isUnread;
        }

        const sessionId = sess?.id ?? key;
        const pendingApproval = derivePendingApproval(
          runner.chatState.messages
        );
        const pendingClarification = derivePendingClarification(
          runner.chatState.messages
        );
        const matchingBudgetTrigger =
          budgetPausedTrigger?.agentId === runner.agentId
            ? budgetPausedTrigger
            : null;
        const budget =
          runner.agentId === activeAgentId
            ? deriveBudgetSummary(budgetStatus, matchingBudgetTrigger)
            : null;
        pushedSessionIds.add(sessionId);
        petSessions.push({
          id: sessionId,
          agentId: runner.agentId,
          name: sess?.name ?? sess?.firstMessage?.slice(0, 20) ?? "新会话",
          streaming: runner.streaming,
          agentPhase: runner.agentPhase,
          lastMessage: lastText,
          currentTool,
          currentToolTarget,
          retry: runner.retryInfo,
          compacting: runner.compacting,
          pendingApproval,
          pendingClarification,
          budget,
          error,
          sseStatus: runner.sseStatus,
          streamingStartedAt,
          read,
        });
      }

      // 兜底：当前 selectedId 对应的 session 若没被 runner 路径加入
      // （比如刚切到一个历史 session、agentId 还没建立），也要 push 一个
      // 最小化条目，保证宠物侧 displaySession.find(focusedSessionId) 能命中。
      // 否则宠物侧会显示空 placeholder（"等待启动"）即使主窗口已有内容。
      if (selectedId && !pushedSessionIds.has(selectedId)) {
        const sess = sessions.find((s) => s.id === selectedId);
        if (sess) {
          // 与 runner 路径同一套已读公式（v2：不再硬编码 active=已读）
          const seenAt = lastSeenMapRef.current[sess.id];
          const isRunning = !!sess.isRunning;
          const isUnread =
            !isRunning && (!seenAt || seenAt < sess.modified);
          const read = !isUnread;
          petSessions.push({
            id: sess.id,
            agentId: null,
            name: sess.name ?? sess.firstMessage?.slice(0, 20) ?? "新会话",
            streaming: false,
            agentPhase: null,
            lastMessage: "",
            currentTool: null,
            currentToolTarget: null,
            retry: null,
            compacting: false,
            pendingApproval: null,
            pendingClarification: null,
            budget: null,
            error: null,
            sseStatus: "idle",
            streamingStartedAt: null,
            read,
          });
        }
      }

      const petState: PetState = {
        sessions: petSessions,
        focusedSessionId: selectedId,
        petVisible: true,
        petAlwaysShow: true,
      };

      api.pet.sendState(petState);
    };

    // 暴露给 markActiveSessionRead 等外部调用
    petDoPushRef.current = doPush;

    // 节流：距上次推送 ≥ 100ms 直接推；否则 setTimeout 等剩余时长
    const now = Date.now();
    const sinceLast = now - petLastPushedAtRef.current;
    if (sinceLast >= 100) {
      doPush();
    } else {
      if (petPushTimerRef.current) clearTimeout(petPushTimerRef.current);
      petPushTimerRef.current = setTimeout(doPush, 100 - sinceLast);
    }

    return () => {
      if (petPushTimerRef.current) {
        clearTimeout(petPushTimerRef.current);
        petPushTimerRef.current = null;
      }
    };
     
  }, [
    activeSnapshot,
    sessions,
    selectedId,
    lastSeenMapRef,
    runnersRef,
    activeAgentId,
    budgetStatus,
    budgetPausedTrigger,
  ]); // activeSnapshot 变化涵盖了 runner 的流式更新
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PetState, PetSessionInfo } from "@/lib/electron-bridge";

/**
 * 宠物动画状态，由 PetSessionInfo 派生
 *
 * - idle: 会话从未开始（无 lastMessage 或无 agent）—— 灰，"等待启动"
 * - complete: 会话有历史回复且已读 —— 绿，"已完成"（区别于 idle 的"从未"）
 * - done: 流式刚结束的 2s 过渡态 —— 绿，"已完成 共耗时 Xs"，之后自然过渡到 complete
 * - thinking / running: 流式中 —— 紫/靛
 * - attention: 有 lastMessage 但用户没看到（未读） —— 蓝
 * - error / offline: 异常 —— 红/灰
 */
export type PetAnimState =
  | "idle"
  | "complete"
  | "thinking"
  | "running"
  | "attention"
  | "done"
  | "error"
  | "offline";

/** 气泡显示的文案（主文案 + 副文案） */
export interface PetBubbleText {
  /** 主文案，最长 24 字 */
  primary: string;
  /** 副文案，可选 */
  secondary: string | null;
  /** 文案优先级：high=主动错误/L4，需要强制弹出 */
  priority: "high" | "normal";
}

/** 从 PetSessionInfo 派生宠物动画状态（5 主态 + 2 异常态） */
export function derivePetAnimState(
  session: PetSessionInfo | null
): PetAnimState {
  if (!session || !session.agentId) return "idle";

  // 异常优先
  if (session.error) return "error";
  if (session.sseStatus === "lost") return "offline";

  if (!session.streaming) {
    // agent 存在但不在流式：
    //   无 lastMessage → idle（从未对话过）
    //   有 lastMessage 且未读 → attention（需要吸引用户注意）
    //   有 lastMessage 且已读 → complete（已完成，等待新输入）
    if (!session.lastMessage) return "idle";
    if (!session.read) return "attention";
    return "complete";
  }

  const phase = session.agentPhase;
  if (!phase) return "idle";
  if (phase.kind === "thinking" || phase.kind === "waiting_model")
    return "thinking";
  if (phase.kind === "running_tools") return "running";
  return "idle";
}

/**
 * 从 PetSessionInfo + animState + now 派生气泡文案（设计 §4.1）。
 *
 * - now 是外部传入的"当前墙钟时间 ms"，用于计算 streaming 耗时，每秒刷新一次
 * - lostElapsedMs：当前 session 处于 lost 态已持续的毫秒数，由 usePetState
 *   用 ref 在 sseStatus 边沿维护并传入；非 lost 时传 null
 * - 异常文案（error / offline / retry / compacting）优先级高，直接覆盖
 */
export function derivePetBubbleText(
  session: PetSessionInfo | null,
  animState: PetAnimState,
  now: number,
  lostElapsedMs: number | null = null
): PetBubbleText {
  // 无 session
  if (!session) {
    return { primary: "等待启动", secondary: null, priority: "normal" };
  }

  // L4: agent error
  if (session.error) {
    return {
      primary: "出错了",
      secondary: session.error.slice(0, 40),
      priority: "high",
    };
  }

  // L4/L3: SSE 离线
  if (session.sseStatus === "lost") {
    // 有 lostElapsedMs 时显示"距上次正常 Xs"，否则保留"点击重连"兜底
    const secondary =
      lostElapsedMs != null && lostElapsedMs >= 1000
        ? `距上次正常 ${formatDuration(lostElapsedMs)} · 点击重连`
        : "点击重连";
    return {
      primary: "连接已断开",
      secondary,
      priority: "high",
    };
  }

  // L2: auto retry
  if (session.retry) {
    return {
      primary: `重试中 (${session.retry.attempt}/${session.retry.maxAttempts})`,
      secondary: session.retry.errorMessage?.slice(0, 40) ?? null,
      priority: "normal",
    };
  }

  // L2: 压缩中
  if (session.compacting) {
    return {
      primary: "正在压缩上下文…",
      secondary: null,
      priority: "normal",
    };
  }

  // 主状态
  switch (animState) {
    case "idle": {
      // 无 lastMessage = 真的从未对话过
      return { primary: "等待启动", secondary: session.name, priority: "normal" };
    }
    case "complete": {
      // 有 lastMessage 且已读 = 历史上完成过、用户已看过
      return { primary: "已完成", secondary: session.name, priority: "normal" };
    }
    case "thinking": {
      const kind = session.agentPhase?.kind;
      const primary =
        kind === "waiting_model" ? "等待模型响应…" : "正在思考…";
      const elapsed = formatElapsed(session.streamingStartedAt, now);
      return {
        primary,
        secondary: elapsed,
        priority: "normal",
      };
    }
    case "running": {
      const toolName = session.currentTool ?? "";
      const tools = session.agentPhase?.tools ?? [];
      const target = session.currentToolTarget;
      // 多 tool 并发
      if (tools.length > 1) {
        return {
          primary: `正在执行 ${tools.length} 个任务`,
          secondary: toolName,
          priority: "normal",
        };
      }
      const primary = describeToolPrimary(toolName);
      return {
        primary,
        secondary: target,
        priority: "normal",
      };
    }
    case "attention": {
      return {
        primary: "有新回复",
        secondary: session.lastMessage.slice(0, 40) || null,
        priority: "normal",
      };
    }
    case "done": {
      const elapsed = formatElapsed(session.streamingStartedAt, now);
      return {
        primary: "已完成",
        secondary: elapsed ? `共耗时 ${elapsed}` : null,
        priority: "normal",
      };
    }
    case "error":
      // 已在前面 session.error 分支处理
      return { primary: "出错了", secondary: null, priority: "high" };
    case "offline":
      // 已在前面 sseStatus 分支处理（带 lostElapsed）
      return {
        primary: "连接已断开",
        secondary: "点击重连",
        priority: "high",
      };
  }
}

/** 把毫秒数格式化为 "Xs" / "X分Ys" / "Xh Ym"（用于"距上次正常"） */
function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}分${rs}s` : `${m}分`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}分` : `${h}h`;
}

/** "正在 X" 文案（设计 §4.1） */
function describeToolPrimary(toolName: string): string {
  const n = toolName.toLowerCase();
  if (!n) return "正在执行…";
  if (n.includes("read")) return "正在读取文件";
  if (n.includes("edit")) return "正在修改文件";
  if (n.includes("write")) return "正在写入文件";
  if (n.includes("bash") || n.includes("shell")) return "正在执行命令";
  if (n.includes("grep") || n.includes("find") || n.includes("search"))
    return "正在搜索";
  if (n.includes("ls") || n.includes("list")) return "正在列出目录";
  return `正在使用 ${toolName}`;
}

/** 把 streamingStartedAt → "X.Ys" / "Xs" / "X分Ys"；为 null 返回 null */
function formatElapsed(
  startedAt: number | null,
  now: number
): string | null {
  if (startedAt == null) return null;
  const ms = Math.max(0, now - startedAt);
  if (ms < 1000) return "0.1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}分${rs}s`;
}

/** done 状态短暂持续时长（ms） */
const DONE_LINGER_MS = 2000;
/** 耗时文案刷新频率（ms） */
const ELAPSED_TICK_MS = 1000;

export function usePetState() {
  const [petState, setPetState] = useState<PetState | null>(null);
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [animState, setAnimState] = useState<PetAnimState>("idle");
  const prevStreamingRef = useRef<boolean>(false);
  // 用于宠物本地切换展示哪个 session（不推回主窗口）
  const [localFocusId, setLocalFocusId] = useState<string | null>(null);
  // 每秒 tick，用于刷新"已耗时 Xs" / "距上次正常 Xs" 文案
  const [now, setNow] = useState<number>(() => Date.now());
  // 记录每个 session 进入 lost 态的时间戳；恢复（非 lost）即清除。
  // 用 ref 避免不必要的 re-render（恢复时不需要 trigger 渲染，因为 sseStatus
  // 变化本身已经会导致 petState 更新进而 re-render）。
  const lostAtMapRef = useRef<Map<string, number>>(new Map());

  // 订阅 IPC 推送
  useEffect(() => {
    // 兼容 web 模式（无 Electron API 时 noop）
    const api = window.miniPi;
    if (!api?.pet?.onState) return;
    const unsub = api.pet.onState((state) => {
      setPetState(state);
    });
    return unsub;
  }, []);

  // 维护 lostAtMapRef：sessions 中任何 session 进入/离开 lost 都同步更新。
  // 同时清理 sessions 中已不存在的 session 的残留记录，避免内存泄漏。
  useEffect(() => {
    if (!petState) {
      lostAtMapRef.current.clear();
      return;
    }
    const map = lostAtMapRef.current;
    const aliveIds = new Set<string>();
    for (const s of petState.sessions) {
      aliveIds.add(s.id);
      if (s.sseStatus === "lost") {
        if (!map.has(s.id)) map.set(s.id, Date.now());
      } else {
        if (map.has(s.id)) map.delete(s.id);
      }
    }
    // 清理已下线的 session
    for (const id of Array.from(map.keys())) {
      if (!aliveIds.has(id)) map.delete(id);
    }
  }, [petState]);

  // 每秒刷新 now（仅当有 streaming 或 lost 时启动，避免空跑）
  useEffect(() => {
    const needTick =
      petState?.sessions.some(
        (s) => s.streaming || s.sseStatus === "lost"
      ) ?? false;
    if (!needTick) return;
    const id = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, [petState]);

  // 从 petState 派生 animState，处理 done 短暂闪现
  useEffect(() => {
    if (!petState) return;

    // 严格按 focused id 查找；找不到就返回 null，由 derivePetBubbleText
    // 显示"等待启动"占位。绝不 fallback 到 sessions[0]，避免显示
    // 与主窗口 active session 完全无关的会话（v1 设计修复）。
    const targetId = localFocusId ?? petState.focusedSessionId;
    const focused =
      petState.sessions.find((s) => s.id === targetId) ?? null;

    const wasStreaming = prevStreamingRef.current;
    const isStreaming = focused?.streaming ?? false;
    prevStreamingRef.current = isStreaming;

    // streaming 刚结束 → done 闪现（仅在无 error/offline 时）
    if (wasStreaming && !isStreaming && focused) {
      const nextState = derivePetAnimState(focused);
      // 异常态不显示 done（错误比成功优先级高）
      if (nextState !== "error" && nextState !== "offline") {
        setAnimState("done");
        if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
        doneTimerRef.current = setTimeout(() => {
          doneTimerRef.current = null;
          setAnimState(derivePetAnimState(focused));
        }, DONE_LINGER_MS);
        return;
      }
    }

    // done 计时期间不打断（除非进入异常态）
    if (doneTimerRef.current) {
      const next = derivePetAnimState(focused);
      if (next === "error" || next === "offline") {
        clearTimeout(doneTimerRef.current);
        doneTimerRef.current = null;
        setAnimState(next);
      }
      return;
    }
    setAnimState(derivePetAnimState(focused));
  }, [petState, localFocusId]);

  // 清理计时器
  useEffect(
    () => () => {
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    },
    []
  );

  /** 当前宠物展示的 session（严格按 focused id 查找，找不到返回 null） */
  const displaySession: PetSessionInfo | null = (() => {
    if (!petState) return null;
    const targetId = localFocusId ?? petState.focusedSessionId;
    return petState.sessions.find((s) => s.id === targetId) ?? null;
  })();

  /** 当前展示 session 处于 lost 态时的已断线时长（ms），否则 null */
  const lostElapsedMs: number | null = (() => {
    if (!displaySession || displaySession.sseStatus !== "lost") return null;
    const lostAt = lostAtMapRef.current.get(displaySession.id);
    if (lostAt == null) return null;
    return Math.max(0, now - lostAt);
  })();

  /** 派生气泡文案（每次 render 重算，依赖 now 实现每秒刷新） */
  const bubbleText: PetBubbleText = derivePetBubbleText(
    displaySession,
    animState,
    now,
    lostElapsedMs
  );

  /** 聚焦主窗口并切到对应 session */
  const focusMain = useCallback(
    (sessionId?: string) => {
      window.miniPi?.pet?.focusMain?.(sessionId ?? displaySession?.id);
    },
    [displaySession]
  );

  /**
   * 直接注入 petState（用于非 Electron 环境下的 mock 调试）。
   * 在 Electron 中由 IPC 推送，不应调用此方法。
   */
  const injectMockState = useCallback((state: PetState | null) => {
    setPetState(state);
  }, []);

  return {
    petState,
    animState,
    displaySession,
    allSessions: petState?.sessions ?? [],
    localFocusId,
    setLocalFocusId,
    focusMain,
    bubbleText,
    injectMockState,
  };
}

// 已暴露 petState 给 PetApp 使用（右键菜单需要 focusedSessionId 来标 radio）

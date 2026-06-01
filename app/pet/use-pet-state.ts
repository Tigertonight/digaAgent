"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PetState, PetSessionInfo } from "@/lib/electron-bridge";

/** 宠物动画状态，由 PetSessionInfo 派生 */
export type PetAnimState =
  | "idle"
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
    // agent 存在但不在流式 → 曾对话过则等待输入，否则空闲
    // read=true 表示用户已在主窗口看过这条 lastMessage，跳过 attention
    if (!session.lastMessage) return "idle";
    if (session.read) return "idle";
    return "attention";
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
 * - 异常文案（error / offline / retry / compacting）优先级高，直接覆盖
 */
export function derivePetBubbleText(
  session: PetSessionInfo | null,
  animState: PetAnimState,
  now: number
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
    return {
      primary: "连接已断开",
      secondary: "点击重连",
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

  // 5 主状态
  switch (animState) {
    case "idle": {
      const primary = session.lastMessage ? "准备就绪" : "等待启动";
      return { primary, secondary: session.name, priority: "normal" };
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
      // 已在前面 sseStatus 分支处理
      return {
        primary: "连接已断开",
        secondary: "点击重连",
        priority: "high",
      };
  }
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
  // 每秒 tick，用于刷新"已耗时 Xs"文案
  const [now, setNow] = useState<number>(() => Date.now());

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

  // 每秒刷新 now（仅当有 streaming 时启动，避免空跑）
  useEffect(() => {
    const hasStreaming = petState?.sessions.some((s) => s.streaming) ?? false;
    if (!hasStreaming) return;
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

  /** 派生气泡文案（每次 render 重算，依赖 now 实现每秒刷新） */
  const bubbleText: PetBubbleText = derivePetBubbleText(
    displaySession,
    animState,
    now
  );

  /** 聚焦主窗口并切到对应 session */
  const focusMain = useCallback(
    (sessionId?: string) => {
      window.miniPi?.pet?.focusMain?.(sessionId ?? displaySession?.id);
    },
    [displaySession]
  );

  return {
    petState,
    animState,
    displaySession,
    allSessions: petState?.sessions ?? [],
    localFocusId,
    setLocalFocusId,
    focusMain,
    bubbleText,
  };
}

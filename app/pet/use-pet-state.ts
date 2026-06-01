"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PetState, PetSessionInfo } from "@/lib/electron-bridge";

/** 宠物动画状态，由 PetSessionInfo 派生 */
export type PetAnimState =
  | "idle"
  | "thinking"
  | "running"
  | "attention"
  | "done";

/** 从 PetSessionInfo 派生宠物动画状态 */
export function derivePetAnimState(session: PetSessionInfo | null): PetAnimState {
  if (!session || !session.agentId) return "idle";
  if (!session.streaming) {
    // agent 存在但不在流式 → 曾对话过则等待输入，否则空闲
    return session.lastMessage ? "attention" : "idle";
  }
  const phase = session.agentPhase;
  if (!phase) return "idle";
  if (phase.kind === "thinking" || phase.kind === "waiting_model") return "thinking";
  if (phase.kind === "running_tools") return "running";
  return "idle";
}

/** done 状态短暂持续时长（ms） */
const DONE_LINGER_MS = 2000;

export function usePetState() {
  const [petState, setPetState] = useState<PetState | null>(null);
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [animState, setAnimState] = useState<PetAnimState>("idle");
  const prevStreamingRef = useRef<boolean>(false);
  // 用于宠物本地切换展示哪个 session（不推回主窗口）
  const [localFocusId, setLocalFocusId] = useState<string | null>(null);

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

  // 从 petState 派生 animState，处理 done 短暂闪现
  useEffect(() => {
    if (!petState) return;

    const focused =
      petState.sessions.find(
        (s) => s.id === (localFocusId ?? petState.focusedSessionId)
      ) ??
      petState.sessions[0] ??
      null;

    const wasStreaming = prevStreamingRef.current;
    const isStreaming = focused?.streaming ?? false;
    prevStreamingRef.current = isStreaming;

    // streaming 刚结束 → done 闪现
    if (wasStreaming && !isStreaming && focused) {
      setAnimState("done");
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
      doneTimerRef.current = setTimeout(() => {
        doneTimerRef.current = null;
        setAnimState(derivePetAnimState(focused));
      }, DONE_LINGER_MS);
      return;
    }

    // done 计时期间不打断
    if (doneTimerRef.current) return;
    setAnimState(derivePetAnimState(focused));
  }, [petState, localFocusId]);

  // 清理计时器
  useEffect(
    () => () => {
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    },
    []
  );

  /** 当前宠物展示的 session */
  const displaySession: PetSessionInfo | null =
    petState?.sessions.find(
      (s) => s.id === (localFocusId ?? petState.focusedSessionId)
    ) ??
    petState?.sessions[0] ??
    null;

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
  };
}

"use client";

import { useEffect, useRef, useState } from "react";
import type { PetSessionInfo, PetState } from "@/lib/electron-bridge";

/**
 * 临时事件 toast（P1 §5.3）
 *
 * 与"常态气泡"区分：
 *   - 常态气泡：被动 derive 自当前 session 状态（如 "正在思考…"）
 *   - toast：由"事件边沿"主动驱动（如 retry 开始/成功、压缩完成、显著错误）
 *
 * 实现要点：
 *   - 用 ref 存上次 sessions 快照，对比每个 session 的 retry/compacting/error 字段
 *   - 触发后 push 到队列，N ms 后自动出队
 *   - 队列上限 3 条，超出舍弃最旧（不是丢新，避免 burst 时漏掉最新事件）
 *   - 同一 (sessionId, kind) 短时间内去重（避免 retry 多次 update 时狂闪）
 */

export type PetToastKind =
  | "retry_start"
  | "retry_success"
  | "retry_fail"
  | "compact_done"
  | "agent_error";

export interface PetToast {
  /** 全局唯一 id，用作 React key */
  id: string;
  kind: PetToastKind;
  primary: string;
  secondary: string | null;
  /** 显示时长（ms），到期自动出队 */
  durationMs: number;
  /** 主色（左侧色条 / 边框） */
  color: string;
  /** 关联 session id，用于去重 + 调试 */
  sessionId: string;
  /** 创建时间戳（performance.now 量级） */
  createdAt: number;
}

const MAX_QUEUE = 3;
/** 同一 (sessionId, kind) 在此窗口内只发一次，防止抖动 */
const DEDUPE_WINDOW_MS = 1500;

/** 单条快照：只保留触发 toast 所需字段 */
interface SessionSnapshot {
  retryAttempt: number | null;
  compacting: boolean;
  error: string | null;
  /** lastMessage 长度，用于判断 retry 是否"成功"（成功后通常会进入下一轮思考） */
  hasLastMessage: boolean;
}

function snapshotOf(s: PetSessionInfo): SessionSnapshot {
  return {
    retryAttempt: s.retry?.attempt ?? null,
    compacting: !!s.compacting,
    error: s.error ?? null,
    hasLastMessage: !!s.lastMessage,
  };
}

let toastIdSeq = 0;

export function usePetToasts(petState: PetState | null) {
  const [toasts, setToasts] = useState<PetToast[]>([]);
  /** 上次 sessions 快照（key = sessionId） */
  const prevRef = useRef<Map<string, SessionSnapshot>>(new Map());
  /** 去重记录：key = `${sessionId}:${kind}` → 上次入队时间 */
  const dedupeRef = useRef<Map<string, number>>(new Map());
  /** toast 出队定时器，卸载时清理 */
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // 监听 petState 变化，对每个 session 计算事件边沿
  useEffect(() => {
    if (!petState) return;

    const next = new Map<string, SessionSnapshot>();
    const events: Omit<PetToast, "id" | "createdAt">[] = [];

    for (const s of petState.sessions) {
      const snap = snapshotOf(s);
      next.set(s.id, snap);
      const prev = prevRef.current.get(s.id);
      if (!prev) continue; // 第一次见到该 session，不发 toast

      // ----- retry 边沿 -----
      // null → number：retry 开始
      if (prev.retryAttempt == null && snap.retryAttempt != null) {
        events.push({
          kind: "retry_start",
          primary: `自动重试 (${snap.retryAttempt}/${s.retry?.maxAttempts ?? "?"})`,
          secondary: s.retry?.errorMessage?.slice(0, 60) ?? null,
          durationMs: 3000,
          color: "var(--pet-state-approval)",
          sessionId: s.id,
        });
      }
      // number → null：retry 结束
      else if (prev.retryAttempt != null && snap.retryAttempt == null) {
        // 没 error → 视为成功
        if (!snap.error) {
          events.push({
            kind: "retry_success",
            primary: "重试成功",
            secondary: null,
            durationMs: 2500,
            color: "var(--pet-state-complete)",
            sessionId: s.id,
          });
        } else {
          events.push({
            kind: "retry_fail",
            primary: "重试失败",
            secondary: snap.error.slice(0, 60),
            durationMs: 5000,
            color: "var(--pet-state-error)",
            sessionId: s.id,
          });
        }
      }

      // ----- compacting 边沿（true → false 视为完成） -----
      if (prev.compacting && !snap.compacting) {
        events.push({
          kind: "compact_done",
          primary: "上下文压缩完成",
          secondary: null,
          durationMs: 2500,
          color: "var(--pet-state-thinking)",
          sessionId: s.id,
        });
      }

      // ----- error 边沿（null → string 或内容变更视为新错误） -----
      if (snap.error && snap.error !== prev.error) {
        events.push({
          kind: "agent_error",
          primary: "出错了",
          secondary: snap.error.slice(0, 80),
          durationMs: 5000,
          color: "var(--pet-state-error)",
          sessionId: s.id,
        });
      }
    }

    prevRef.current = next;
    if (events.length === 0) return;

    // 去重 + 入队
    const now = performance.now();
    const accepted: PetToast[] = [];
    for (const e of events) {
      const dedupeKey = `${e.sessionId}:${e.kind}`;
      const last = dedupeRef.current.get(dedupeKey) ?? -Infinity;
      if (now - last < DEDUPE_WINDOW_MS) continue;
      dedupeRef.current.set(dedupeKey, now);
      accepted.push({
        ...e,
        id: `t${++toastIdSeq}`,
        createdAt: now,
      });
    }
    if (accepted.length === 0) return;

    queueMicrotask(() => {
      setToasts((cur) => {
        const merged = [...cur, ...accepted];
        // 超出上限 → 丢最旧（FIFO 满了）
        return merged.length > MAX_QUEUE
          ? merged.slice(merged.length - MAX_QUEUE)
          : merged;
      });
    });

    // 起出队定时器
    for (const t of accepted) {
      const timer = setTimeout(() => {
        timersRef.current.delete(timer);
        setToasts((cur) => cur.filter((x) => x.id !== t.id));
      }, t.durationMs);
      timersRef.current.add(timer);
    }
  }, [petState]);

  // 卸载时清理所有定时器
  useEffect(
    () => () => {
      for (const t of timersRef.current) clearTimeout(t);
      timersRef.current.clear();
    },
    []
  );

  return toasts;
}

"use client";

/**
 * useSseManager —— SSE 连接池（RFC-1 阶段 A2）
 *
 * 职责：
 *   - 唯一持有 esMapRef（Map<RunnerKey, EventSource>）—— 所有会话的 SSE 连接表
 *   - 暴露 attachSseFor / closeSseFor 两个连接生命周期 API
 *   - 解析 SSE envelope（lastEventId → seq）并把事件转发给外部 onEvent
 *   - SSE 状态变化（onopen / onerror）通过 onStatusChange 通知外部
 *
 * 设计要点：
 *   - hook 内不持有任何业务状态（不知道 RunnerState / chatState）
 *   - 事件解析后直接回调 onEvent(event, agentId, key)，由外部决定怎么消费
 *   - SSE 状态（active/lost）和 lastSeq 通过 onStatusChange 同步到 runner（外部决定怎么存）
 *   - attachSseFor 内部先关旧连接再开新连接，调用方不需要先 close
 *
 * 不在本 hook 内的职责（属于外部 / 其他 hook）：
 *   - runner 容器写入 → useRunners（A1）
 *   - agent 事件业务分发 → useAgentEvents + event-handlers.ts（A3）
 *   - 重连 / 断线重试策略 → 暂留 ChatApp（pet 窗口的 reconnect 触发器是上游事件源）
 *
 * 与 useRunners 的协作：
 *   - LRU 淘汰 runner 时，useRunners 通过 onEvict 回调拿到 key，
 *     ChatApp 在 onEvict 内直接调本 hook 的 closeSseFor —— 闭环
 */

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import type { RunnerKey, SseStatus } from "@/lib/session-runner";

/**
 * RAF 合批：useSseManager 在 onmessage 时不立即派发 onEvent，
 * 而是把事件 push 进 pendingDispatchRef，调度一次 requestAnimationFrame。
 * RAF 回调里包在 batchUpdates(...) 内顺序 dispatch 所有事件，让
 * 同一帧内 N 条 SSE 事件合并成 1 次 React commit。
 *
 * 见 perf 调研笔记：streaming text 50–100/s 每条都触发 ChatApp 全树 re-render，
 * RAF 合批后 ≤ 60fps，commit 次数下降 1–2 个量级。
 */
interface PendingSseEvent {
  event: unknown;
  agentId: string;
  key: RunnerKey;
}

/** S2：断线重连的指数退避间隔（ms）。模块级常量，避免每次 render 重建。 */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

/** SSE 状态变更 patch；ChatApp 把它写到对应 runner */
export interface SseStatusPatch {
  sseStatus?: SseStatus;
  lastSeq?: number;
}

export interface UseSseManagerOptions {
  /**
   * 收到一条 agent 事件时回调。
   * @param event SSE 反序列化后的 agent event 对象
   * @param agentId 该连接对应的 agentId（attachSseFor 时传入）
   * @param key 该连接对应的 RunnerKey（attachSseFor 时传入）
   */
  onEvent: (event: unknown, agentId: string, key: RunnerKey) => void;
  /**
   * SSE 状态 / seq 变化时回调（onopen → active，onerror → lost，每条消息 → lastSeq）。
   * ChatApp 把它直接转发到 updateRunner(key, patch)。
   */
  onStatusChange: (key: RunnerKey, patch: SseStatusPatch) => void;
  /**
   * 性能合批：RAF 回调中顺序 dispatch 多条事件时，包在 batchUpdates(fn) 内，
   * 让 useRunners.updateRunner 在 fn 期间只写 ref 不 setActiveSnapshot，fn 返回
   * 后统一 commit 一次。不传也能运行（退化为逐事件 commit）。
   */
  batchUpdates?: <T>(fn: () => T) => T;
}

export interface UseSseManagerReturn {
  /**
   * SSE 连接表的只读引用 —— 外部读用（如 e2e 诊断 / pet 窗口查询活跃连接）。
   * **禁止外部直接 mutate**，写入必须走 attachSseFor / closeSseFor。
   */
  esMapRef: MutableRefObject<Map<RunnerKey, EventSource>>;
  /**
   * 为指定 runner 打开 SSE。若该 key 已有连接，先关旧的再开新的。
   *  - onopen → onStatusChange(key, { sseStatus: 'active' })
   *  - onmessage → onStatusChange(key, { lastSeq }) + onEvent(event, agentId, key)
   *  - onerror → onStatusChange(key, { sseStatus: 'lost' })
   */
  attachSseFor: (key: RunnerKey, agentId: string) => void;
  /**
   * 关闭指定 runner 的 SSE（仅释放 EventSource，不动 runner 状态）。
   * LRU 淘汰 / 删除 session / +New chat reset 都走这里。
   */
  closeSseFor: (key: RunnerKey) => void;
}

export function useSseManager(
  opts: UseSseManagerOptions
): UseSseManagerReturn {
  const { onEvent, onStatusChange, batchUpdates } = opts;

  // ===== 连接池 =====
  const esMapRef = useRef<Map<RunnerKey, EventSource>>(new Map());

  // ===== RAF 合批（性能 A 方案）=====
  // pendingDispatchRef：当前帧内还未 dispatch 的 SSE 事件（保证顺序）
  // rafIdRef：已调度的 RAF 句柄（避免重复调度）
  const pendingDispatchRef = useRef<PendingSseEvent[]>([]);
  const rafIdRef = useRef<number | null>(null);

  // 回调 ref：让 RAF 闭包读到最新的 onEvent / batchUpdates
  const batchUpdatesRef = useRef(batchUpdates);
  useEffect(() => {
    batchUpdatesRef.current = batchUpdates;
  }, [batchUpdates]);
  const lastSeqRef = useRef<
    Map<RunnerKey, { agentId: string; seq: number }>
  >(new Map());
  // F5：为每个连接分配 generation token。close 后迟到的 message 不会被发布。
  const generationRef = useRef<Map<RunnerKey, number>>(new Map());
  const nextGenRef = useRef<number>(1);

  // S2：断线自动重连。onerror 后浏览器原生不会重试已 CLOSED 的 EventSource，
  // 需要我们指数退避重 attach。每 key 记一个定时器句柄和已重试次数。
  const reconnectTimerRef = useRef<Map<RunnerKey, ReturnType<typeof setTimeout>>>(
    new Map()
  );
  const reconnectAttemptRef = useRef<Map<RunnerKey, number>>(new Map());
  // 记住每个 key 当前的 agentId，重连时复用（attachSseFor 内会按 agentId 续传 lastSeq）。
  const keyAgentRef = useRef<Map<RunnerKey, string>>(new Map());
  // 自引用：onerror 闭包里要重新调用 attachSseFor。
  const attachSseForRef = useRef<UseSseManagerReturn["attachSseFor"]>(() => {});

  const clearReconnect = useCallback((key: RunnerKey) => {
    const t = reconnectTimerRef.current.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      reconnectTimerRef.current.delete(key);
    }
  }, []);

  // 回调 ref：让 attachSseFor 不依赖 onEvent / onStatusChange 的引用稳定性
  // （ChatApp 内 handleAgentEvent 是函数声明，每次 render 重建；
  //  把回调放 ref 里转发，attachSseFor 的 useCallback 依赖才能为空）
  const onEventRef = useRef(onEvent);
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  // RAF flush：一口气 dispatch 当前帧内所有累积事件，包在 batchUpdates 里
  // 让 useRunners 只触发 1 次 setActiveSnapshot。
  const flushPendingDispatch = useCallback(() => {
    rafIdRef.current = null;
    const pending = pendingDispatchRef.current;
    if (pending.length === 0) return;
    pendingDispatchRef.current = [];
    const dispatch = () => {
      for (const item of pending) {
        try {
          onEventRef.current(item.event, item.agentId, item.key);
        } catch (err) {
          // 单条事件错不塑中后续事件
          console.error("[sse] dispatch failed", err);
        }
      }
    };
    const wrap = batchUpdatesRef.current;
    if (wrap) {
      wrap(dispatch);
    } else {
      dispatch();
    }
  }, []);

  // scheduleDispatch：下一帧 flush。已调度过一次则不重复；SSR 退化同步。
  // 依赖 [flushPendingDispatch] 但后者也是 useCallback([])，实际稳定。
  const scheduleDispatch = useCallback(() => {
    if (rafIdRef.current !== null) return;
    if (
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      flushPendingDispatch();
      return;
    }
    rafIdRef.current = window.requestAnimationFrame(() => {
      flushPendingDispatch();
    });
  }, [flushPendingDispatch]);

  // attachSseFor 闭包要读 scheduleDispatch；走 ref 以保证 useCallback([]) 不失效。
  const scheduleDispatchRef = useRef(scheduleDispatch);
  useEffect(() => {
    scheduleDispatchRef.current = scheduleDispatch;
  }, [scheduleDispatch]);

  // ===== 关闭 =====
  const closeSseFor = useCallback<UseSseManagerReturn["closeSseFor"]>((key) => {
    // S2：主动关闭（LRU 淘汰 / 删除 session / reset）必须取消待执行的自动重连，
    // 否则定时器会把已被关闭的 key 又重新连起来。
    clearReconnect(key);
    reconnectAttemptRef.current.delete(key);
    keyAgentRef.current.delete(key);
    const es = esMapRef.current.get(key);
    if (es) {
      try {
        // F5：先拆 handler（避免迟到 message 还走老闭包）再 close。
        es.onmessage = null;
        es.onerror = null;
        es.onopen = null;
        es.close();
      } catch {
        // close 失败不影响 map 清理
      }
      esMapRef.current.delete(key);
    }
    generationRef.current.delete(key);
    lastSeqRef.current.delete(key);
    // RAF 合批：从 pending 中过滤掉该 key 的待派发事件，避免 close 后迟到 RAF
    // 把 dead session 的 token dispatch 到 reducer 里（造成 stale assistant 出现）。
    if (pendingDispatchRef.current.length > 0) {
      pendingDispatchRef.current = pendingDispatchRef.current.filter(
        (item) => item.key !== key
      );
    }
  }, [clearReconnect]);

  // ===== 打开 =====
  const attachSseFor = useCallback<UseSseManagerReturn["attachSseFor"]>(
    (key, agentId) => {
      // S2：本次 attach 取消任何待执行的重连定时器（手动 attach 优先），并记下
      // 当前 agentId 供重连复用。注意不清 lastSeqRef，保证重连能按 since 续传。
      clearReconnect(key);
      keyAgentRef.current.set(key, agentId);
      // F5：老连接状态独立拆除。不能复用同一 ES 的 lastSeqRef，避免
      // 同一 key 被不同 agent 复用时 since 起点错乱。
      const prev = esMapRef.current.get(key);
      if (prev) {
        try {
          prev.onmessage = null;
          prev.onerror = null;
          prev.onopen = null;
          prev.close();
        } catch {
          // ignore
        }
      }

      const myGen = nextGenRef.current++;
      generationRef.current.set(key, myGen);

      const lastSeqRecord = lastSeqRef.current.get(key);
      const lastSeq =
        lastSeqRecord && lastSeqRecord.agentId === agentId
          ? lastSeqRecord.seq
          : undefined;
      const sinceValue =
        typeof lastSeq === "number" && Number.isFinite(lastSeq)
          ? String(lastSeq)
          : "-1";
      const es = new EventSource(
        `/api/agent/${agentId}/events?since=${encodeURIComponent(sinceValue)}`
      );
      esMapRef.current.set(key, es);

      // 任何回调都要在 dispatch 前校验：
      //   1. esMapRef.current.get(key) === es（当前有效连接仍是我）
      //   2. generationRef.current.get(key) === myGen（同一 key 从未被重 attach）
      // 迟到事件会被丢。
      const isStillCurrent = (): boolean => {
        return (
          esMapRef.current.get(key) === es &&
          generationRef.current.get(key) === myGen
        );
      };

      es.onopen = () => {
        if (!isStillCurrent()) return;
        // S2：连接恢复，重置退避计数。
        reconnectAttemptRef.current.delete(key);
        onStatusChangeRef.current(key, { sseStatus: "active" });
      };

      es.onmessage = (ev) => {
        if (!isStillCurrent()) return;
        try {
          const event = JSON.parse(ev.data);
          // 后端 SSE envelope 带 id: <seq>，浏览器把它写到 ev.lastEventId
          const seq = ev.lastEventId ? Number(ev.lastEventId) : NaN;
          if (Number.isFinite(seq)) {
            const lastSeen = lastSeqRef.current.get(key);
            if (lastSeen?.agentId === agentId && seq <= lastSeen.seq) {
              return;
            }
            lastSeqRef.current.set(key, { agentId, seq });
            onStatusChangeRef.current(key, { lastSeq: seq });
          }
          // RAF 合批：入队，同一帧内 N 条事件只 commit 1 次。
          // 顺序保证：Array push + RAF flush 按插入顺序依次迭代。
          pendingDispatchRef.current.push({ event, agentId, key });
          scheduleDispatchRef.current();
        } catch (e) {
          console.error("bad sse data", e, ev.data);
        }
      };

      es.onerror = (e) => {
        if (!isStillCurrent()) return;
        console.warn("sse error", e);
        onStatusChangeRef.current(key, { sseStatus: "lost" });
        // S2：EventSource 已 CLOSED 时浏览器不会自动重试，这里做指数退避重连。
        // CONNECTING（readyState===0）说明浏览器仍在自行重试，交给它即可。
        if (es.readyState !== EventSource.CLOSED) return;
        // 已经安排了一次重连就不重复安排。
        if (reconnectTimerRef.current.has(key)) return;
        const attempt = reconnectAttemptRef.current.get(key) ?? 0;
        const delay =
          RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
        reconnectAttemptRef.current.set(key, attempt + 1);
        const timer = setTimeout(() => {
          reconnectTimerRef.current.delete(key);
          // 仅当这条连接仍是“当前”且未被主动关闭时才重连。
          if (esMapRef.current.get(key) !== es) return;
          const aid = keyAgentRef.current.get(key) ?? agentId;
          attachSseForRef.current(key, aid);
        }, delay);
        reconnectTimerRef.current.set(key, timer);
      };
    },
    [clearReconnect]
  );

  // 自引用：让 onerror 闭包能重新 attach（指数退避重连）。
  useEffect(() => {
    attachSseForRef.current = attachSseFor;
  }, [attachSseFor]);

  // ===== 卸载时清理所有连接 =====
  useEffect(() => {
    const map = esMapRef.current;
    const lastSeq = lastSeqRef.current;
    const generations = generationRef.current;
    const reconnectTimers = reconnectTimerRef.current;
    return () => {
      // S2：清掉所有待执行的重连定时器，避免卸载后还触发 attach。
      for (const t of reconnectTimers.values()) clearTimeout(t);
      reconnectTimers.clear();
      for (const es of map.values()) {
        try {
          es.onmessage = null;
          es.onerror = null;
          es.onopen = null;
          es.close();
        } catch {
          // ignore
        }
      }
      map.clear();
      lastSeq.clear();
      generations.clear();
      // 清 RAF：卸载后不再 flush。不手动 dispatch 未刷出的事件：组件都没了 / hook 卸载了。
      if (rafIdRef.current !== null) {
        try {
          window.cancelAnimationFrame(rafIdRef.current);
        } catch {
          /* ignore */
        }
        rafIdRef.current = null;
      }
      pendingDispatchRef.current = [];
    };
  }, []);

  return {
    esMapRef,
    attachSseFor,
    closeSseFor,
  };
}

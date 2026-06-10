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
  const { onEvent, onStatusChange } = opts;

  // ===== 连接池 =====
  const esMapRef = useRef<Map<RunnerKey, EventSource>>(new Map());
  const lastSeqRef = useRef<
    Map<RunnerKey, { agentId: string; seq: number }>
  >(new Map());

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

  // ===== 关闭 =====
  const closeSseFor = useCallback<UseSseManagerReturn["closeSseFor"]>((key) => {
    const es = esMapRef.current.get(key);
    if (es) {
      try {
        es.close();
      } catch {
        // close 失败不影响 map 清理
      }
      esMapRef.current.delete(key);
    }
  }, []);

  // ===== 打开 =====
  const attachSseFor = useCallback<UseSseManagerReturn["attachSseFor"]>(
    (key, agentId) => {
      // 已存在则先关掉，避免泄漏
      const prev = esMapRef.current.get(key);
      if (prev) {
        try {
          prev.close();
        } catch {
          // ignore
        }
      }

      const lastSeqRecord = lastSeqRef.current.get(key);
      const lastSeq =
        lastSeqRecord && lastSeqRecord.agentId === agentId
          ? lastSeqRecord.seq
          : undefined;
      const sinceValue =
        typeof lastSeq === "number" && Number.isFinite(lastSeq)
          ? String(lastSeq)
          : "latest";
      const es = new EventSource(
        `/api/agent/${agentId}/events?since=${encodeURIComponent(sinceValue)}`
      );
      esMapRef.current.set(key, es);

      es.onopen = () => {
        onStatusChangeRef.current(key, { sseStatus: "active" });
      };

      es.onmessage = (ev) => {
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
          onEventRef.current(event, agentId, key);
        } catch (e) {
          console.error("bad sse data", e, ev.data);
        }
      };

      es.onerror = (e) => {
        console.warn("sse error", e);
        onStatusChangeRef.current(key, { sseStatus: "lost" });
      };
    },
    []
  );

  // ===== 卸载时清理所有连接 =====
  useEffect(() => {
    const map = esMapRef.current;
    const lastSeq = lastSeqRef.current;
    return () => {
      for (const es of map.values()) {
        try {
          es.close();
        } catch {
          // ignore
        }
      }
      map.clear();
      lastSeq.clear();
    };
  }, []);

  return {
    esMapRef,
    attachSseFor,
    closeSseFor,
  };
}

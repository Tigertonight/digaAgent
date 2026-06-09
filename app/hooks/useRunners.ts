"use client";

/**
 * useRunners —— multi-runner 容器（RFC-1 阶段 A1）
 *
 * 职责：
 *   - 唯一持有 runnersRef（Map<RunnerKey, RunnerState>）—— 所有会话工作面的"权威存储"
 *   - 暴露 updateRunner / updateActive / switchTo 三个写入入口
 *   - 暴露 activeKey / activeSnapshot 用于触发渲染（UI 从 activeSnapshot 读当前会话）
 *   - LRU 淘汰：runners > MAX_RUNNERS 时踢掉最久未触达的非活跃/非流式/非压缩 runner
 *
 * 设计要点：
 *   - 通过 onEvict 回调通知外部（用于关 SSE 等外部副作用），不在 hook 内直接操作 SSE
 *     （SSE 池由后续 useSseManager 管，本 hook 不耦合）
 *   - runnersRef.current 的所有 mutate 都通过本 hook 暴露的方法，禁止外部直接写
 *   - activeKeyRef 用于 callback 内同步读最新 active key（避免 stale closure）
 *
 * 不在本 hook 内的职责（属于外部 / 其他 hook）：
 *   - SSE 连接生命周期 → useSseManager（RFC-1 A2）
 *   - agent 事件解析 → useAgentEvents（RFC-1 A3）
 *   - session 列表 / 选中 → useSessions（RFC-1 B1）
 *   - DRAFT → sessionFile 的草稿升级（涉及 esMapRef，仍在 ChatApp 内）
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  emptyRunner,
  DRAFT_KEY,
  type RunnerKey,
  type RunnerPatch,
  type RunnerState,
} from "@/lib/session-runner";

const DEFAULT_MAX_RUNNERS = 8;

export interface UseRunnersOptions {
  /**
   * LRU 淘汰某 runner 时回调（同步，在删除 runnersRef 条目"之前"调用）。
   * 用于让外部（如 SSE 池）做清理，比如关连接。
   */
  onEvict?: (key: RunnerKey) => void;
  /** 最大 runner 数，超过会触发 LRU；默认 8 */
  maxRunners?: number;
}

export interface UseRunnersReturn {
  /** 多 runner 权威存储；外部只读，写入必须走下方 API */
  runnersRef: MutableRefObject<Map<RunnerKey, RunnerState>>;
  /** 当前活跃 runner 的 key（驱动 UI 渲染） */
  activeKey: RunnerKey;
  /** 当前活跃 runner 的不可变快照（UI 直接解构使用） */
  activeSnapshot: RunnerState;
  /** activeKey 的同步 ref，callbacks 内读最新值用，避免 stale closure */
  activeKeyRef: MutableRefObject<RunnerKey>;

  /** 写入指定 runner；若该 runner 是当前活跃的，同步 setActiveSnapshot 触发渲染 */
  updateRunner: (key: RunnerKey, patch: RunnerPatch) => void;
  /** 写当前活跃 runner —— 等价于 updateRunner(activeKey, patch) */
  updateActive: (patch: RunnerPatch) => void;
  /**
   * 切换活跃 runner。
   *  - 不动 SSE（让后台流式继续）
   *  - 目标 runner 不存在时兜底建空 runner（防止渲染崩）
   */
  switchTo: (newKey: RunnerKey) => void;
  /**
   * 新增 / 覆盖一个 runner 到容器（**唯一允许的"添加 runner"入口**）。
   *  - 已存在则覆盖（lastTouched 会被刷新）
   *  - 操作完成后自动触发 LRU 检查 —— 这是它和裸 `runnersRef.current.set` 的关键区别
   *  - 不切换 activeKey；如需同时切，调用方在 setRunner 之后自行 switchTo
   *  - 若该 key 恰好是当前 activeKey，会同步 setActiveSnapshot 触发渲染
   *
   * 设计理由：runner 数量的增长只可能发生在 setRunner，所以把 LRU 触发绑在这里最自然，
   *           调用方不需要记着"add 之后调 evictIfNeeded"。
   */
  setRunner: (key: RunnerKey, runner: RunnerState) => void;
}

export function useRunners(opts: UseRunnersOptions = {}): UseRunnersReturn {
  const { onEvict, maxRunners = DEFAULT_MAX_RUNNERS } = opts;

  // ===== 容器 =====
  const runnersRef = useRef<Map<RunnerKey, RunnerState>>(
    new Map([[DRAFT_KEY, emptyRunner()]])
  );
  const [activeKey, setActiveKey] = useState<RunnerKey>(DRAFT_KEY);
  const [activeSnapshot, setActiveSnapshot] = useState<RunnerState>(() =>
    emptyRunner()
  );

  // 同步 ref：setState 异步，callbacks 里读 activeKeyRef.current 永远是最新值。
  const activeKeyRef = useRef<RunnerKey>(DRAFT_KEY);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  // ===== 写入 =====
  const updateRunner = useCallback<UseRunnersReturn["updateRunner"]>(
    (key, patch) => {
      const cur = runnersRef.current.get(key);
      if (!cur) return; // 已被 LRU 淘汰或还没 lazy 加载，丢弃
      const delta = typeof patch === "function" ? patch(cur) : patch;
      const next: RunnerState = {
        ...cur,
        ...delta,
        lastTouched: Date.now(),
      };
      runnersRef.current.set(key, next);
      if (key === activeKeyRef.current) {
        setActiveSnapshot(next);
      }
    },
    []
  );

  const updateActive = useCallback<UseRunnersReturn["updateActive"]>(
    (patch) => {
      updateRunner(activeKeyRef.current, patch);
    },
    [updateRunner]
  );

  // ===== LRU =====
  // lruEvictRef 用于解决 switchTo 与 lruEvict 的前向引用循环。
  const lruEvictRef = useRef<(() => void) | null>(null);

  const switchTo = useCallback<UseRunnersReturn["switchTo"]>((newKey) => {
    if (newKey === activeKeyRef.current) return;
    const target = runnersRef.current.get(newKey);
    if (!target) {
      // 目标不存在 —— 调用方应该先 lazy create runner 再 switchTo。
      // 这里兜底建空 runner，避免渲染崩。
      const fresh = emptyRunner();
      runnersRef.current.set(newKey, fresh);
      activeKeyRef.current = newKey;
      setActiveKey(newKey);
      setActiveSnapshot(fresh);
      lruEvictRef.current?.();
      return;
    }
    // 更新 lastTouched 进 LRU 表
    const touched: RunnerState = { ...target, lastTouched: Date.now() };
    runnersRef.current.set(newKey, touched);
    activeKeyRef.current = newKey;
    setActiveKey(newKey);
    setActiveSnapshot(touched);
    lruEvictRef.current?.();
  }, []);

  /**
   * LRU 淘汰：runners > maxRunners 时，挑出"最久未触达"的非活跃/非流式/非压缩 runner 踢掉。
   *
   * 踢的语义：
   *   - 先调 onEvict(key) 通知外部清理（如关 SSE）
   *   - 再 runnersRef.delete(key)
   *   - 不调 abort（后端 agent 继续跑；用户切回该 session 时会冷启动重连或新建）
   *   - draft runner 永不淘汰（全局只有一个）
   */
  const lruEvict = useCallback(() => {
    const map = runnersRef.current;
    if (map.size <= maxRunners) return;
    const candidates: { key: RunnerKey; touched: number }[] = [];
    for (const [key, r] of map) {
      if (key === DRAFT_KEY) continue;
      if (key === activeKeyRef.current) continue;
      if (r.streaming) continue;
      if (r.compacting) continue;
      candidates.push({ key, touched: r.lastTouched });
    }
    candidates.sort((a, b) => a.touched - b.touched);
    const need = map.size - maxRunners;
    for (let i = 0; i < Math.min(need, candidates.length); i++) {
      const key = candidates[i].key;
      try {
        onEvict?.(key);
      } catch {
        // 外部清理失败不影响 runner 淘汰
      }
      map.delete(key);
    }
  }, [maxRunners, onEvict]);

  useEffect(() => {
    lruEvictRef.current = lruEvict;
  }, [lruEvict]);

  // ===== setRunner（唯一的"添加 runner"入口，自带 LRU 触发） =====
  // 注意：直接调 lruEvict（同一 hook 内定义，无前向引用问题），不走 lruEvictRef，
  //       避免首次 render 时 ref 还没赋值导致漏淘汰。
  const setRunner = useCallback<UseRunnersReturn["setRunner"]>(
    (key, runner) => {
      const touched: RunnerState = { ...runner, lastTouched: Date.now() };
      runnersRef.current.set(key, touched);
      if (key === activeKeyRef.current) {
        setActiveSnapshot(touched);
      }
      lruEvict();
    },
    [lruEvict]
  );

  return {
    runnersRef,
    activeKey,
    activeSnapshot,
    activeKeyRef,
    updateRunner,
    updateActive,
    switchTo,
    setRunner,
  };
}

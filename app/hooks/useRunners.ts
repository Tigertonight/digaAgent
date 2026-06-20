"use client";

/**
 * useRunners —— multi-runner 容器（RFC-1 阶段 A1）
 *
 * 职责：
 *   - 唯一持有 runnersRef（Map<RunnerKey, RunnerState>）—— 所有会话工作面的"权威存储"
 *   - 暴露 updateRunner / updateActive / switchTo 三个写入入口
 *   - 暴露 activeKey / activeSnapshot 用于触发渲染（UI 从 activeSnapshot 读当前会话）
 *   - LRU 淘汰：runners > MAX_RUNNERS 时只踢掉最久未触达的非活跃/非流式/非压缩 runner；
 *     若全部被保护，允许软超限并保留后台任务，避免复杂并发任务被前端状态层误释放
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

export interface RunnerEvictionPlan {
  evict: RunnerKey[];
  softLimitExceeded: boolean;
}

/**
 * M3: runner 是否处于“等待用户操作”态——chatState 里存在未决的 approval 或
 * clarification（agent 已阻塞等用户响应）。这类 runner 不应被 LRU 淘汰，否则关闭
 * SSE 后用户回来可能看不到/收不到那条待批准请求。
 */
function hasPendingUserAction(r: RunnerState): boolean {
  for (const msg of r.chatState.messages) {
    const parts = msg.parts;
    if (!parts) continue;
    for (const p of parts) {
      if (
        (p.kind === "approval" || p.kind === "clarification") &&
        p.status === "pending"
      ) {
        return true;
      }
    }
  }
  return false;
}

export function planRunnerEviction(params: {
  runners: ReadonlyMap<RunnerKey, RunnerState>;
  activeKey: RunnerKey;
  maxRunners: number;
}): RunnerEvictionPlan {
  const { runners, activeKey, maxRunners } = params;
  if (runners.size <= maxRunners) return { evict: [], softLimitExceeded: false };
  const candidates: { key: RunnerKey; touched: number }[] = [];
  for (const [key, r] of runners) {
    if (key === DRAFT_KEY) continue;
    if (key === activeKey) continue;
    if (r.streaming) continue;
    if (r.compacting) continue;
    if (r.pendingImages.length > 0 || r.pendingFiles.length > 0) continue;
    if (hasPendingUserAction(r)) continue;
    candidates.push({ key, touched: r.lastTouched });
  }
  candidates.sort((a, b) => a.touched - b.touched);
  const need = runners.size - maxRunners;
  if (candidates.length === 0) {
    return { evict: [], softLimitExceeded: true };
  }
  return {
    evict: candidates.slice(0, need).map((item) => item.key),
    softLimitExceeded: candidates.length < need,
  };
}

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
  /**
   * 性能批处理：在 fn 执行期间，对 active runner 的多次 updateRunner 只触发一次
   * setActiveSnapshot（在 fn 返回后）。
   *
   * 用途：useSseManager 的 RAF 合批 —— 把同一帧内的 N 条 SSE 事件折叠成 1 次 React commit，
   * 避免 streaming 文本流时每个 token 都触发整条 ChatApp 重渲染。
   *
   * 语义：
   *   - fn 同步执行（不 await）；fn 内调用 updateRunner / updateActive 仍然立刻把数据
   *     写到 runnersRef，**只是**推迟 setActiveSnapshot。
   *   - fn 内调用 setRunner / switchTo 会 commit 自己的 setActiveSnapshot（因为这两个
   *     是"切换/接管"动作，需要 UI 立即更新）。
   *   - 嵌套调用安全：内层 batch 不会单独 commit，统一由最外层 commit。
   *   - fn 抛错时仍然会尝试 commit 已写入的数据。
   */
  batchUpdates: <T>(fn: () => T) => T;
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

  // ===== 批处理上下文 =====
  // batchUpdates(fn) 期间，updateRunner 写入 ref 后**不**立即 setActiveSnapshot；
  // 由最外层 batchUpdates 在 fn 返回后统一 commit。
  // batchDepthRef > 0 表示当前在 batch 内；activeDirtyRef 记录 active 是否被修改。
  const batchDepthRef = useRef(0);
  const activeDirtyRef = useRef(false);

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
        if (batchDepthRef.current > 0) {
          // 批内：只标 dirty，等 batch 结束统一 commit
          activeDirtyRef.current = true;
        } else {
          setActiveSnapshot(next);
        }
      }
    },
    []
  );

  const batchUpdates = useCallback<UseRunnersReturn["batchUpdates"]>((fn) => {
    batchDepthRef.current += 1;
    try {
      return fn();
    } finally {
      batchDepthRef.current -= 1;
      if (batchDepthRef.current === 0 && activeDirtyRef.current) {
        activeDirtyRef.current = false;
        const cur = runnersRef.current.get(activeKeyRef.current);
        if (cur) setActiveSnapshot(cur);
      }
    }
  }, []);

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
   * LRU 淘汰：runners > maxRunners 时，只挑出"最久未触达"的
   * 非活跃/非流式/非压缩 runner 踢掉。若所有后台 runner 都被保护，允许软超限；
   * 否则复杂 workflow/subagent 并发下会出现“后台任务还在跑，但前端状态被释放”的错觉。
   *
   * 踢的语义：
   *   - 先调 onEvict(key) 通知外部清理（如关 SSE）
   *   - 再 runnersRef.delete(key)
   *   - 不调 abort（后端 agent 继续跑；用户切回该 session 时会冷启动重连或新建）
   *   - draft runner 永不淘汰（全局只有一个）
   */
  const lruEvict = useCallback(() => {
    const map = runnersRef.current;
    const plan = planRunnerEviction({
      runners: map,
      activeKey: activeKeyRef.current,
      maxRunners,
    });
    if (plan.softLimitExceeded) {
      console.warn(
        `[runners] LRU soft limit exceeded (${map.size}/${maxRunners}); protected background runners were kept.`
      );
    }
    for (const key of plan.evict) {
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
    batchUpdates,
  };
}

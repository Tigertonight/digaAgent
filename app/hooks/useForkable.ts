"use client";

/**
 * useForkable —— 把 ChatApp 的 "fork 与 navigate_tree" 模块收口到一个 hook。
 *
 * 涵盖范围：
 *   - 4 个 setter wrappers（setForkableUserMessages / setForkingIndex /
 *     setForkText / setForkBusy）—— forkBusy 仅 hook 内部用，不 export
 *   - forksCollapsed UI 状态（折叠 fork 按钮 + localStorage 持久化）
 *   - refreshForkList —— GET /api/agent/:id?action=user_messages_for_forking
 *   - 5 个 fork handler：
 *       startFork           打开内联编辑器（写 forkingIndex/forkText）
 *       cancelFork          关闭内联编辑器
 *       submitFork          提交修改 → navigate_tree + 重发 prompt（沿用当前 session）
 *       forkToNewSession    fork 到一个新 session 文件 + 新 agent + navigate
 *
 * 设计原则（沿用 B2-a / B3）：
 *   - hook 完全无状态（除 forksCollapsed UI 状态）；所有 runner state 通过 setter / updateRunner 写入
 *   - setForkText 通过 return 给 UI（onChangeForkText 直接传给 ForkableUserMessageRow）
 *   - setForkableUserMessages 通过 return 给 ChatApp 的 reloadFromCurrentSession（navigate_tree 后刷新）
 *   - refreshForkList 通过 return，供 useAgentEvents 的 agent_done 事件反向注入
 *   - agentAction 通过参数注入（来自 useChatStream），避免重复实现 POST 通道
 */

import type React from "react";
import { startTransition, useCallback, useState } from "react";
import type { ForkableUserMessage, ThinkingLevel, SessionInfoLite } from "@/lib/types";
import type { SubagentBatch } from "@/lib/subagents/types";
import {
  appendRestoredSubagentBatches,
  createInitialState,
  ctxToMessages,
} from "@/lib/chat-reducer";
import {
  emptyRunner,
  type RunnerKey,
  type RunnerState,
  type RunnerPatch,
} from "@/lib/session-runner";
import { userFacingMessage } from "@/lib/user-facing-error";

export interface UseForkableParams {
  // ── active runner 字段（来自 ChatApp 解构）───────────────────────────
  agentId: string | null;
  agentSessionId: string | null;
  selectedId: string | null;
  forkText: string;

  // ── 全局会话上下文 ─────────────────────────────────────────────────
  providerId: string | null;
  modelId: string | null;
  cwd: string | null;
  thinkingLevel: ThinkingLevel;
  sessions: SessionInfoLite[];

  // ── refs ───────────────────────────────────────────────────────────
  activeKeyRef: React.MutableRefObject<RunnerKey>;

  // ── runner 写入接口（来自 useRunners） ─────────────────────────────
  setRunner: (key: RunnerKey, runner: RunnerState) => void;
  updateRunner: (key: RunnerKey, patch: RunnerPatch) => void;

  // ── 4 个 fork setter wrappers（runner state，hook 内部用） ─────────
  setForkableUserMessages: (
    v: ForkableUserMessage[] | ((prev: ForkableUserMessage[]) => ForkableUserMessage[])
  ) => void;
  setForkingIndex: (
    v: number | null | ((prev: number | null) => number | null)
  ) => void;
  setForkText: (v: string | ((prev: string) => string)) => void;

  // ── SSE 管理（来自 useSseManager） ─────────────────────────────────
  attachSseFor: (key: RunnerKey, agentId: string) => void;

  // ── session 列表 / 切换 / 错误（来自 useSessions / useRunners） ───
  switchTo: (key: RunnerKey) => void;
  setSelectedId: (id: string | null) => void;
  refreshSessions: () => void;
  setError: (msg: string | null) => void;

  // ── runner 派生数据刷新（来自 ChatApp，暂留——C 后期会再抽） ─────
  refreshStats: (aid: string, ownerKey?: RunnerKey) => void;
  refreshToolsCount: (aid: string, ownerKey?: RunnerKey) => void;

  // ── 通用 agent POST（来自 useChatStream） ──────────────────────────
  agentAction: (aid: string, payload: Record<string, unknown>) => Promise<unknown>;
}

export interface UseForkableReturn {
  /** 折叠 fork 按钮 UI 状态（pi-web 风格 Collapse/Expand forks） */
  forksCollapsed: boolean;
  toggleForks: () => void;

  /** 拉当前 agent 的 forkable user messages 列表 */
  refreshForkList: (aid: string, ownerKey?: RunnerKey) => Promise<void>;

  /** 打开内联 fork 编辑器（写 forkingIndex / forkText） */
  startFork: (index: number, currentText: string) => void;
  /** 关闭内联编辑器 */
  cancelFork: () => void;
  /** 提交：navigate_tree + 重发 prompt（沿用当前 session） */
  submitFork: (entryId: string) => Promise<void>;
  /** fork 到一个新 session 文件 + 新 agent */
  forkToNewSession: (entryId: string) => Promise<void>;

  // 透传给 ChatApp（reloadFromCurrentSession / UI 直接绑定）
  setForkText: UseForkableParams["setForkText"];
  setForkableUserMessages: UseForkableParams["setForkableUserMessages"];
}

export function useForkable(params: UseForkableParams): UseForkableReturn {
  const {
    agentId,
    agentSessionId,
    selectedId,
    forkText,
    providerId,
    modelId,
    cwd,
    thinkingLevel,
    sessions,
    activeKeyRef,
    setRunner,
    updateRunner,
    setForkableUserMessages,
    setForkingIndex,
    setForkText,
    attachSseFor,
    switchTo,
    setSelectedId,
    refreshSessions,
    setError,
    refreshStats,
    refreshToolsCount,
    agentAction,
  } = params;

  // ===== forksCollapsed（UI 折叠状态，localStorage 持久化）=====
  const [forksCollapsed, setForksCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return localStorage.getItem("pi-forks-collapsed") === "1";
    } catch {}
    return false;
  });
  const toggleForks = useCallback(() => {
    setForksCollapsed((v) => {
      const nv = !v;
      try {
        localStorage.setItem("pi-forks-collapsed", nv ? "1" : "0");
      } catch {}
      return nv;
    });
  }, []);

  // ===== refreshForkList =====
  // 写到指定 runner；ownerKey 缺省 = 当前活跃 runner —— 兼容老调用点。
  const refreshForkList = useCallback(
    async (aid: string, ownerKey?: RunnerKey) => {
      try {
        const r = await fetch(
          `/api/agent/${aid}?action=user_messages_for_forking`
        );
        const data = await r.json();
        if (Array.isArray(data.messages)) {
          // P2-I: forkable user message 列表是不紧急的背景资源。变化会让
          // ChatApp 重算 messageRenderState，抖动到整个 list。包进 startTransition
          // 让输入交互优先保持响应。
          startTransition(() => {
            updateRunner(ownerKey ?? activeKeyRef.current, {
              forkableUserMessages: data.messages as ForkableUserMessage[],
            });
          });
        }
      } catch (e) {
        console.warn("refreshForkList failed", e);
      }
    },
    [updateRunner, activeKeyRef]
  );

  // ===== Fork handlers =====
  const startFork = useCallback(
    (index: number, currentText: string) => {
      setForkingIndex(index);
      setForkText(currentText);
    },
    [setForkingIndex, setForkText]
  );

  const cancelFork = useCallback(() => {
    setForkingIndex(null);
    setForkText("");
  }, [setForkingIndex, setForkText]);

  /**
   * 从某条 user message 起 fork 出一个**新 session 文件**：
   *   1. POST /api/sessions/{srcId}/fork  -> 拿到新 session 的 id/path/cwd
   *   2. POST /api/agent/new  with sessionPath=新文件 -> 新 agent
   *   3. navigate_tree(targetEntryId)  -> 把 leaf 截断到 fork 点
   *   4. 切到新 session 的 UI（左侧高亮、右侧重载 context）
   *   5. 刷新 sessions 列表（新 session 应作为 child 显示在 parent 下）
   */
  const forkToNewSession = useCallback(
    async (entryId: string) => {
      if (!selectedId && !agentSessionId) {
        setError("当前没有可 fork 的 session");
        return;
      }
      if (!providerId || !modelId) {
        setError("请先选择 provider 和 model");
        return;
      }
      const srcId = agentSessionId ?? selectedId!;
      setError(null);
      try {
        // 1. 创建新 session 文件
        const fr = await fetch(`/api/sessions/${srcId}/fork`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetEntryId: entryId }),
        });
        const fd = (await fr.json()) as {
          ok?: boolean;
          id?: string;
          path?: string;
          cwd?: string;
          error?: string;
        };
        if (fd.error || !fd.id || !fd.path) {
          setError(fd.error || "fork failed");
          return;
        }
        // 2. 创建新 agent,绑定新 session 文件(不动父 runner)
        const ar = await fetch("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: providerId,
            modelId,
            cwd: fd.cwd || cwd,
            thinkingLevel,
            sessionPath: fd.path,
          }),
        });
        const ad = await ar.json();
        if (ad.error) {
          setError(ad.error);
          return;
        }
        const newAid = ad.id as string;
        const newKey: RunnerKey = ad.sessionFile ?? fd.path;
        // 3. 为 fork 出来的 session 建一个全新 runner,放进 Map（setRunner 会触发 LRU 检查）
        const forkRunner = emptyRunner();
        forkRunner.agentId = newAid;
        forkRunner.agentSessionId = ad.sessionId;
        forkRunner.sessionFile = ad.sessionFile ?? fd.path;
        setRunner(newKey, forkRunner);
        // 4. 切到新 runner(父 runner 仍保留在 Map 里,SSE 也不动)
        switchTo(newKey);
        attachSseFor(newKey, newAid);
        // 5. 把 leaf 截到 fork 点
        await agentAction(newAid, {
          type: "navigate_tree",
          targetId: entryId,
          summarize: false,
        });
        // 6. 重新拉 context 渲染到新 runner
        try {
          const ctx = await fetch(`/api/sessions/${ad.sessionId}/context`).then(
            (r) => r.json()
          );
          if (!ctx.error) {
            updateRunner(newKey, {
              chatState: createInitialState(
                appendRestoredSubagentBatches(
                  ctxToMessages(ctx.messages ?? []),
                  Array.isArray(ctx.subagentBatches)
                    ? (ctx.subagentBatches as SubagentBatch[])
                    : undefined
                )
              ),
              ...(Array.isArray(ctx.forkableUserMessages)
                ? {
                    forkableUserMessages:
                      ctx.forkableUserMessages as ForkableUserMessage[],
                  }
                : {}),
            });
          }
        } catch {
          /* ignore */
        }
        await refreshForkList(newAid, newKey);
        void refreshStats(newAid, newKey);
        void refreshToolsCount(newAid, newKey);
        // 7. 列表更新 + 选中新 session
        setSelectedId(ad.sessionId);
        refreshSessions();
      } catch (e) {
        setError(userFacingMessage(e));
      }
    },
    [
      selectedId,
      agentSessionId,
      providerId,
      modelId,
      cwd,
      thinkingLevel,
      switchTo,
      setRunner,
      attachSseFor,
      updateRunner,
      agentAction,
      refreshForkList,
      refreshSessions,
      refreshStats,
      refreshToolsCount,
      setError,
      setSelectedId,
    ]
  );

  const submitFork = useCallback(
    async (entryId: string) => {
      const text = forkText.trim();
      if (!text) {
        setError("fork 文本不能为空");
        return;
      }
      const ownerKey = activeKeyRef.current;
      // 没 agent 就基于当前 session 现起一个(用户可能直接打开历史 session 就 hover Edit)
      let aid = agentId;
      if (!aid) {
        if (!providerId || !modelId) {
          setError("请先选择 provider 和 model");
          return;
        }
        const sel = selectedId
          ? sessions.find((s) => s.id === selectedId)
          : undefined;
        if (!sel) {
          setError("无法定位当前 session");
          return;
        }
        const r = await fetch("/api/agent/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: providerId,
            modelId,
            cwd: sel.cwd || cwd,
            thinkingLevel,
            sessionPath: sel.path,
          }),
        });
        const data = await r.json();
        if (data.error) {
          setError(userFacingMessage(data.error));
          return;
        }
        aid = data.id as string;
        updateRunner(ownerKey, {
          agentId: aid,
          agentSessionId: data.sessionId,
          sessionFile: data.sessionFile ?? null,
        });
        attachSseFor(ownerKey, aid);
      }
      updateRunner(ownerKey, { forkBusy: true });
      setError(null);
      try {
        // 1. 切到该 entry(不 summarize,直接截断)
        await agentAction(aid, {
          type: "navigate_tree",
          targetId: entryId,
          summarize: false,
        });
        // 2. 重新拉 session context(reducer 从头来)
        if (selectedId || agentSessionId) {
          // session 文件可能没立刻 flush;优先用 sessionId
          const sid = agentSessionId ?? selectedId;
          try {
            const ctx = await fetch(`/api/sessions/${sid}/context`).then((r) =>
              r.json()
            );
            if (!ctx.error) {
              updateRunner(ownerKey, {
                chatState: createInitialState(
                  appendRestoredSubagentBatches(
                    ctxToMessages(ctx.messages ?? []),
                    Array.isArray(ctx.subagentBatches)
                      ? (ctx.subagentBatches as SubagentBatch[])
                      : undefined
                  )
                ),
              });
            }
          } catch {
            /* 忽略:发完 prompt 后 SSE 也会重建 messages */
          }
        }
        // 3. 用新文本发 prompt
        await agentAction(aid, { type: "prompt", text });
        // 4. 关编辑器、刷 fork 列表
        updateRunner(ownerKey, { forkingIndex: null, forkText: "" });
        await refreshForkList(aid, ownerKey);
      } catch (e) {
        setError(userFacingMessage(e));
      } finally {
        updateRunner(ownerKey, { forkBusy: false });
      }
    },
    [
      agentId,
      agentSessionId,
      selectedId,
      sessions,
      providerId,
      modelId,
      cwd,
      thinkingLevel,
      forkText,
      attachSseFor,
      updateRunner,
      agentAction,
      refreshForkList,
      activeKeyRef,
      setError,
    ]
  );

  return {
    forksCollapsed,
    toggleForks,
    refreshForkList,
    startFork,
    cancelFork,
    submitFork,
    forkToNewSession,
    setForkText,
    setForkableUserMessages,
  };
}

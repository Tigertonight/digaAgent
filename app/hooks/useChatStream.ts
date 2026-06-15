/**
 * useChatStream — Turn 控制中枢（RFC-1 阶段 B2-a）
 *
 * 把 ChatApp.tsx 内"用户发起一轮对话"相关的所有 callback 收口到一个 hook：
 *
 *   agentAction       —— 通用 POST /api/agent/:id 通道（其他 callback 的基础）
 *   send              —— 发送一条新 prompt（含草稿升级 / agent 兜底创建 / 滚动锚定）
 *   onAbort           —— 中断当前 turn
 *   onCompact         —— 触发 history compaction
 *   onAbortCompaction —— 中断 compaction
 *   onSteer           —— streaming 中插入 system 引导
 *   onFollowUp        —— streaming 中排队下一轮 prompt
 *   onChangeThinking  —— 切换 thinking level（同步到 runner + 后端 agent）
 *
 * 设计要点：
 * 1. hook 不直接持有任何 React state——所有可变状态都来自参数（订阅式读取）
 * 2. 草稿升级闭包 upgradeDraftIfNeeded 完整搬入 send 内部，依赖 runnersRef + SSE 操作
 *    全部通过参数注入
 * 3. onSteer / onFollowUp 95% 重复 → 抽内部 sendAgentText('steer' | 'follow_up') 公共 fn
 * 4. agentAction 失败时调用 setError 注入错误；不抛出（onAbort/onCompact 等已 try/catch）
 *
 * 不进 B2-a 的（划清边界）：
 * - startNewSession：与 sidebar +New chat 强相关，留 ChatApp
 * - refreshStats / refreshToolsCount / refreshForkList：被 useAgentEvents 反向依赖，留 ChatApp
 * - runSlashCommand：依赖太散（5 个 modal 开关 + setInput）
 * - 图片附件 4 个 callback：B2-b useComposerAttachments
 */
import { useCallback } from "react";
import type {
  ChatMessage,
  ImageContentLite,
  SessionInfoLite,
  ThinkingLevel,
} from "@/lib/types";
import {
  DRAFT_KEY,
  emptyRunner,
  type PendingAttachment,
  type RunnerKey,
  type RunnerPatch,
  type RunnerState,
} from "@/lib/session-runner";
import type { AgentProgress, ProgressStep } from "@/lib/progress/types";
import { userFacingMessage } from "@/lib/user-facing-error";
import { applyEvent } from "@/lib/chat-reducer";
import {
  CONTEXT_ASIDE_CLOSE,
  CONTEXT_ASIDE_OPEN,
} from "@/lib/context-aside";
import { upsertOptimisticSession } from "@/lib/sessions/optimistic";
import {
  deleteInput as deleteStoreInput,
  getInput as getStoreInput,
  setInput as setStoreInput,
} from "@/lib/composer/input-store";

function makeClientRequestId(): string {
  // F3：optimistic dedupe key。如果 crypto.randomUUID 不可用则 fallback。
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `crid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type Updater<T> = T | ((prev: T) => T);

function failOpenProgressSteps(progress: AgentProgress | null): AgentProgress | null {
  if (!progress) return progress;
  const now = Date.now();
  const closeStep = (step: ProgressStep): ProgressStep => {
    if (step.status !== "running" && step.status !== "pending") return step;
    return {
      ...step,
      status: "failed",
      summary: step.summary
        ? `${step.summary}\n用户已中止当前任务。`
        : "用户已中止当前任务。",
      completedAt: now,
    };
  };
  const groups = progress.groups.map((group) => ({
    ...group,
    steps: group.steps.map(closeStep),
    endedAt:
      group.endedAt ??
      (group.steps.some(
        (step) => step.status === "running" || step.status === "pending"
      )
        ? now
        : undefined),
  }));
  return {
    ...progress,
    steps: progress.steps.map(closeStep),
    groups,
    updatedAt: now,
  };
}

/**
 * Backup parser（F7 fallback）：后端现在总是返回明确的 sessionId，但这个函数仍
 * 保留作为双保险。
 */
function extractSessionIdFromPath(p: string): string | null {
  const base = p.split("/").pop() ?? "";
  const noExt = base.replace(/\.jsonl$/, "");
  const m = noExt.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  return m ? m[1] : null;
}

export interface UseChatStreamParams {
  // ===== 活跃 runner 数据（每次 render 拿最新） =====
  agentId: string | null;
  getInput: () => string;
  pendingImages: ImageContentLite[];
  pendingFiles: PendingAttachment[];
  currentSessionFile: string | null;

  // ===== 全局状态（非 runner） =====
  providerId: string;
  modelId: string;
  cwd: string;
  thinkingLevel: ThinkingLevel;
  selectedId: string | null;
  sessions: SessionInfoLite[];
  messages: ChatMessage[]; // send 用来算 currentUserCount

  // ===== runner store（useRunners 提供） =====
  runnersRef: React.RefObject<Map<RunnerKey, RunnerState>>;
  activeKeyRef: React.RefObject<RunnerKey>;
  updateRunner: (key: RunnerKey, patch: RunnerPatch) => void;
  setRunner: (key: RunnerKey, state: RunnerState) => void;
  switchTo: (key: RunnerKey) => void;

  // ===== SSE（useSseManager 提供） =====
  attachSseFor: (key: RunnerKey, agentId: string) => void;
  closeSseFor: (key: RunnerKey) => void;

  // ===== runner-as-store setter wrappers =====
  setInput: (v: Updater<string>) => void;
  setPendingImages: (v: Updater<ImageContentLite[]>) => void;
  setPendingFiles: (v: Updater<PendingAttachment[]>) => void;

  // ===== 顶层 state setters =====
  setError: (e: string | null) => void;
  setSelectedId: (id: string | null) => void;
  /**
   * Optimistic sidebar：ensureAgent 拿到 sessionFile/sessionId 后立即 upsert
   * 一条 “loading” 会话到列表顶部，避免 “发送后等很久 sidebar 才出现”。
   */
  setSessions: React.Dispatch<React.SetStateAction<SessionInfoLite[]>>;

  // ===== 数据拉取（注入，B2-a 不抽） =====
  refreshStats: (aid: string, ownerKey?: RunnerKey) => void | Promise<void>;
  refreshToolsCount: (aid: string, ownerKey?: RunnerKey) => void | Promise<void>;

  // ===== UI 滚动锚定（hook 不知道细节，只触发） =====
  pendingPinUserCountRef: React.MutableRefObject<number | null>;
  setPinSpacer: (v: boolean) => void;
}

export interface UseChatStreamReturn {
  agentAction: (
    aid: string,
    payload: Record<string, unknown>
  ) => Promise<unknown>;
  ensureAgent: () => Promise<{
    aid: string;
    ownerKey: RunnerKey;
  } | null>;
  send: () => Promise<void>;
  onAbort: () => Promise<void>;
  onCompact: () => Promise<void>;
  onAbortCompaction: () => Promise<void>;
  onSteer: () => Promise<void>;
  onFollowUp: () => Promise<void>;
  onChangeThinking: (lv: ThinkingLevel) => Promise<void>;
  startGoal: (objective: string) => Promise<void>;
  startWorkflow: (objective: string) => Promise<void>;
}

export function useChatStream(
  params: UseChatStreamParams
): UseChatStreamReturn {
  const {
    agentId,
    getInput,
    pendingImages,
    pendingFiles,
    currentSessionFile,
    providerId,
    modelId,
    cwd,
    thinkingLevel,
    selectedId,
    sessions,
    messages,
    runnersRef,
    activeKeyRef,
    updateRunner,
    setRunner,
    switchTo,
    attachSseFor,
    closeSseFor,
    setInput,
    setPendingImages,
    setPendingFiles,
    setError,
    setSelectedId,
    setSessions,
    refreshStats,
    refreshToolsCount,
    pendingPinUserCountRef,
    setPinSpacer,
  } = params;

  // 通用 agent action POST：失败时 setError 并 throw（让调用方决定吞或继续抛）
  const agentAction = useCallback(
    async (aid: string, payload: Record<string, unknown>) => {
      const r = await fetch(`/api/agent/${aid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (data.error) {
        const message = userFacingMessage(data.error);
        setError(message);
        throw new Error(message);
      }
      return data;
    },
    [setError]
  );

  /**
   * F7/F8：草稿 → 正式 session 升级。
   *   - 接收明确的 sessionId（从 /api/agent/new 返回），不再依赖路径正则。
   *   - 只负责 runner key 迁移 + selectedId 联动；SSE attach 由调用方唯一负责。
   */
  const upgradeDraftIfNeeded = useCallback(
    (
      sessionFilePath: string | null,
      sessionId?: string | null
    ): RunnerKey => {
      const currentKey = activeKeyRef.current ?? DRAFT_KEY;
      if (currentKey !== DRAFT_KEY || !sessionFilePath) return currentKey;
      const newKey: RunnerKey = sessionFilePath;
      const idFromBackend =
        sessionId && sessionId.length > 0 ? sessionId : null;
      const idFromPath = idFromBackend ?? extractSessionIdFromPath(sessionFilePath);
      if (runnersRef.current?.has(newKey)) {
        switchTo(newKey);
        if (idFromPath) setSelectedId(idFromPath);
        return newKey;
      }
      const upgraded = runnersRef.current?.get(DRAFT_KEY);
      if (!upgraded) return currentKey;
      const draftInput = getStoreInput(DRAFT_KEY);
      runnersRef.current?.set(newKey, upgraded);
      runnersRef.current?.delete(DRAFT_KEY);
      if (draftInput) setStoreInput(newKey, draftInput);
      deleteStoreInput(DRAFT_KEY);
      closeSseFor(DRAFT_KEY);
      switchTo(newKey);
      if (idFromPath) setSelectedId(idFromPath);
      setRunner(DRAFT_KEY, emptyRunner());
      // F8：草稿升级本身不 attach SSE。调用方（首次 ensureAgent）会 attach。
      // 如果未来需要从其它入口调这个函数迁移运行中的 agent，从那处 attach 即可。
      return newKey;
    },
    [
      activeKeyRef,
      runnersRef,
      switchTo,
      setSelectedId,
      closeSseFor,
      setRunner,
    ]
  );

  const ensureAgent = useCallback(async (): Promise<{
    aid: string;
    ownerKey: RunnerKey;
  } | null> => {
    if (agentId) {
      return {
        aid: agentId,
        ownerKey: upgradeDraftIfNeeded(currentSessionFile),
      };
    }
    if (!providerId || !modelId) {
      setError("请先选择 provider 和 model");
      return null;
    }
    // F1：优先 runner.cwd，避免使用老 agent 环境下用户修改 cwd 但未作用。
    const ownerKeyAtStart = activeKeyRef.current ?? DRAFT_KEY;
    const runnerCwd =
      runnersRef.current?.get(ownerKeyAtStart)?.cwd ?? null;
    const effectiveCwd = runnerCwd ?? cwd;
    const r = await fetch("/api/agent/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: providerId,
        modelId,
        cwd: effectiveCwd,
        thinkingLevel,
        sessionPath: selectedId
          ? sessions.find((s) => s.id === selectedId)?.path
          : undefined,
      }),
    });
    const data = await r.json();
    if (data.error) {
      setError(userFacingMessage(data.error));
      return null;
    }
    const ownerKey = activeKeyRef.current ?? DRAFT_KEY;
    updateRunner(ownerKey, {
      agentId: data.id,
      agentSessionId: data.sessionId,
      sessionFile: data.sessionFile ?? null,
      cwd: effectiveCwd,
      pendingCwd: null,
      ...(data.thinkingLevel
        ? { thinkingLevel: data.thinkingLevel as ThinkingLevel }
        : {}),
      ...(data.availableThinkingLevels
        ? {
            availableThinkingLevels:
              data.availableThinkingLevels as ThinkingLevel[],
          }
        : {}),
      ...(typeof data.supportsThinking === "boolean"
        ? { supportsThinking: data.supportsThinking }
        : {}),
    });
    const upgradedKey = upgradeDraftIfNeeded(
      data.sessionFile ?? null,
      data.sessionId ?? null
    );
    // F8：SSE 只在这个唯一入口 attach。
    attachSseFor(upgradedKey, data.id);
    void refreshStats(data.id, upgradedKey);
    void refreshToolsCount(data.id, upgradedKey);
    // Optimistic sidebar：sessionId/sessionFile 一拿到就把会话插到左侧顶部，
    // firstMessage 取当前输入框快照（如果调者是 /goal、/workflow、附件发送等场景，
    // 都仍是用户原话）。后续 refreshSessions 会以服务端真值覆盖。
    if (data.sessionId && data.sessionFile) {
      const firstHint = (() => {
        try {
          return (getInput() ?? "").trim();
        } catch {
          return "";
        }
      })();
      const parentSessionPath = selectedId
        ? sessions.find((s) => s.id === selectedId)?.path
        : undefined;
      setSessions((prev) =>
        upsertOptimisticSession(prev, {
          id: data.sessionId,
          path: data.sessionFile,
          cwd: effectiveCwd,
          firstMessage: firstHint,
          parentSessionPath,
        })
      );
    }
    return { aid: data.id, ownerKey: upgradedKey };
  }, [
    agentId,
    currentSessionFile,
    providerId,
    modelId,
    cwd,
    thinkingLevel,
    selectedId,
    sessions,
    runnersRef,
    activeKeyRef,
    updateRunner,
    upgradeDraftIfNeeded,
    attachSseFor,
    refreshStats,
    refreshToolsCount,
    setError,
    setSessions,
    getInput,
  ]);

  // F2 / G1：任何在“当前会话”上创建东西（发 prompt / 起 goal / 起 workflow）的
  // 入口都必须走这个闸门。避免用户在 selectedId 已变、但 activeKey 还未同步
  // 到目标 runner 的短暂窗口里、把变动发到错的 owner。
  const guardActiveKeyMatchesSelected = useCallback((): boolean => {
    const activeKeyAtSend = activeKeyRef.current ?? DRAFT_KEY;
    if (!selectedId) return true;
    const selectedSession = sessions.find((s) => s.id === selectedId);
    if (!selectedSession?.path) return true;
    if (activeKeyAtSend === DRAFT_KEY) return true;
    if (selectedSession.path === activeKeyAtSend) return true;
    setError("当前窗口还未完成 session 切换，请稍后再试。");
    return false;
  }, [activeKeyRef, selectedId, sessions, setError]);

  // 发送一条新 prompt。fix-S4.b：不再重复写 ensureAgent 冷启动逻辑，
  // 直接复用。ensureAgent 已经处理了：冷启动 → fetch new → 升级草稿
  // → attachSSE → 拉 stats / tools。fast path 只走草稿升级。
  const send = useCallback(async () => {
    const input = getInput();
    if (
      !input.trim() &&
      pendingImages.length === 0 &&
      pendingFiles.length === 0
    )
      return;
    if (!guardActiveKeyMatchesSelected()) return;
    const ensured = await ensureAgent();
    if (!ensured) return; // ensureAgent 内部已调 setError
    const aid = ensured.aid;
    const ownerKey = ensured.ownerKey;
    const userText = input;
    const images = pendingImages;
    const attachments = pendingFiles;
    // 展示文本 = 用户原话（不再把 @path 拼进去）。
    // 附件引用单独通过 attachments 字段传给后端，由后端作为上下文 aside 喂给模型，
    // 这样前台气泡只显示用户输入的原文。
    const attachmentPaths = attachments.map((a) => a.path);
    // F3：optimistic user message + clientRequestId。
    const clientRequestId = makeClientRequestId();
    const promptText =
      userText || (attachmentPaths.length > 0 ? "(see attachments)" : "(image)");
    updateRunner(ownerKey, (state) => ({
      chatState: applyEvent(state.chatState, {
        type: "__optimistic_user",
        clientRequestId,
        text: promptText,
        images: images.map((img) => ({ data: img.data, mimeType: img.mimeType })),
        attachments: attachmentPaths,
      }),
    }));
    setInput("");
    setPendingImages([]);
    setPendingFiles([]);
    setError(null);
    // 锚定：期望"现有 user 数 + 1"那条新消息一出现就滚到屏顶
    // 同时启用底部 60vh 占位，确保最后一条 user 能被滚到屏顶；锚定完成后会自动移除。
    const currentUserCount = messages.filter((m) => m.role === "user").length;
    pendingPinUserCountRef.current = currentUserCount + 1;
    setPinSpacer(true);
    try {
      await agentAction(aid, {
        type: "prompt",
        text: promptText,
        images: images.length > 0 ? images : undefined,
        attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
        clientRequestId,
      });
    } catch {
      /* error 已被 agentAction 设置 */
      // F3：标记发送失败，供用户可见。
      updateRunner(ownerKey, (state) => ({
        chatState: applyEvent(state.chatState, {
          type: "__optimistic_user_failed",
          clientRequestId,
          reason: "failed",
        }),
      }));
    }
  }, [
    ensureAgent,
    getInput,
    guardActiveKeyMatchesSelected,
    messages,
    pendingImages,
    pendingFiles,
    agentAction,
    updateRunner,
    setInput,
    setPendingImages,
    setPendingFiles,
    setError,
    pendingPinUserCountRef,
    setPinSpacer,
  ]);

  const startGoal = useCallback(
    async (objective: string) => {
      const text = objective.trim();
      if (!text) return;
      // G1：与 send() 同样的 owner 保护。goal 丢到老 runner 特别隐蔽。
      if (!guardActiveKeyMatchesSelected()) return;
      const ensured = await ensureAgent();
      if (!ensured) return;
      setError(null);
      // 结构化 Composer A6：在本地先插一条 optimistic user 气泡，携带 mode=goal。
      // 然后 SSE message_start reconcile 路径会保留 composerMeta（reducer 已实现）。
      const ownerKey = ensured.ownerKey;
      updateRunner(ownerKey, (state) => ({
        chatState: applyEvent(state.chatState, {
          type: "__optimistic_user",
          text,
          composerMode: "goal",
        }),
      }));
      const currentUserCount = messages.filter((m) => m.role === "user").length;
      pendingPinUserCountRef.current = currentUserCount + 1;
      setPinSpacer(true);
      try {
        await agentAction(ensured.aid, {
          type: "goal_set",
          objective: text,
        });
      } catch {
        /* error 已被 agentAction 设置 */
      }
    },
    [
      ensureAgent,
      guardActiveKeyMatchesSelected,
      agentAction,
      setError,
      updateRunner,
      messages,
      pendingPinUserCountRef,
      setPinSpacer,
    ]
  );

  /**
   * /workflow 命令入口：把一句目标描述转成「让 agent 用 dynamic workflow 执行」的
   * 标准 prompt（要求它调用 run_workflow_script）。措辞与历史 workflow resume 卡片
   * 对齐，确保模型稳定走 workflow harness 而不是普通对话。
   */
  const startWorkflow = useCallback(
    async (objective: string) => {
      const text = objective.trim();
      if (!text) return;
      // G1：与 send() 同样的 owner 保护。
      if (!guardActiveKeyMatchesSelected()) return;
      const ensured = await ensureAgent();
      if (!ensured) return;
      setError(null);

      // 设计：UI 可见部分 = 用户原话；控制指令走 CONTEXT_ASIDE。
      // session jsonl 存的是拼接后的全文 —— 重启后加载仍然能 stripContextAside
      // 仅看到用户原话，不会出现“系统把我的表达改写”的体感。
      const aside = [
        "请使用 dynamic workflow（run_workflow_script 工具）来完成上面这个目标，",
        "不要直接在对话里手动一步步执行。",
        "请规划出一个 workflow script：先拆解步骤，在关键节点写 checkpoint 和 artifact，",
        "执行完后综合给出最终结果。",
      ].join("\n");
      const prompt = [
        text,
        "",
        CONTEXT_ASIDE_OPEN,
        aside,
        CONTEXT_ASIDE_CLOSE,
      ].join("\n");

      // 滚动锚定：让新出现的这条 user 消息滚到屏顶（与 send 一致）。
      const currentUserCount = messages.filter((m) => m.role === "user").length;
      pendingPinUserCountRef.current = currentUserCount + 1;
      setPinSpacer(true);

      // 结构化 Composer A6：optimistic user 气泡携 mode=workflow。
      // text 只带用户原话；SSE message_start 收到的 finalText 含 aside，reducer 会 strip 后衰变。
      const ownerKeyW = ensured.ownerKey;
      updateRunner(ownerKeyW, (state) => ({
        chatState: applyEvent(state.chatState, {
          type: "__optimistic_user",
          text,
          composerMode: "workflow",
        }),
      }));

      try {
        await agentAction(ensured.aid, {
          type: "prompt",
          text: prompt,
        });
      } catch {
        /* error 已被 agentAction 设置 */
      }
    },
    [
      ensureAgent,
      guardActiveKeyMatchesSelected,
      agentAction,
      setError,
      updateRunner,
      messages,
      pendingPinUserCountRef,
      setPinSpacer,
    ]
  );

  // 中断当前 turn
  const onAbort = useCallback(async () => {
    if (!agentId) return;
    const ownerKey = activeKeyRef.current ?? DRAFT_KEY;
    updateRunner(ownerKey, (state) => ({
      streaming: false,
      agentPhase: null,
      progress: failOpenProgressSteps(state.progress),
    }));
    try {
      await agentAction(agentId, { type: "abort" });
    } catch {}
  }, [activeKeyRef, agentId, agentAction, updateRunner]);

  // 触发 history compaction
  const onCompact = useCallback(async () => {
    if (!agentId) return;
    const ownerKey = activeKeyRef.current ?? DRAFT_KEY;
    try {
      updateRunner(ownerKey, { compacting: true, compactError: null });
      await agentAction(agentId, { type: "compact" });
      updateRunner(ownerKey, { compacting: false });
    } catch (e) {
      updateRunner(ownerKey, {
        compacting: false,
        compactError: e instanceof Error ? e.message : "compact failed",
      });
    }
  }, [agentId, agentAction, updateRunner, activeKeyRef]);

  // 中断 compaction
  const onAbortCompaction = useCallback(async () => {
    if (!agentId) return;
    const ownerKey = activeKeyRef.current ?? DRAFT_KEY;
    updateRunner(ownerKey, { compacting: false });
    try {
      await agentAction(agentId, { type: "abort_compaction" });
    } catch {}
  }, [activeKeyRef, agentId, agentAction, updateRunner]);

  /**
   * Steer / Follow-up 公共实现。
   *   - steer: streaming 时把输入框内容塞进当前 turn 的 system 引导
   *   - follow_up: streaming 时把输入框内容排队到当前 turn 结束后追发
   * 两者除 action type 外完全一致。
   */
  const sendAgentText = useCallback(
    async (type: "steer" | "follow_up") => {
      if (!agentId) return;
      const text = getInput().trim();
      if (
        !text &&
        pendingImages.length === 0 &&
        pendingFiles.length === 0
      )
        return;
      const refLine = pendingFiles.map((a) => `@${a.path}`).join(" ");
      const finalText = refLine
        ? text
          ? `${refLine}\n${text}`
          : refLine
        : text;
      try {
        await agentAction(agentId, {
          type,
          text: finalText,
          ...(pendingImages.length ? { images: pendingImages } : {}),
        });
        setInput("");
        setPendingImages([]);
        setPendingFiles([]);
      } catch {}
    },
    [
      agentId,
      agentAction,
      getInput,
      pendingImages,
      pendingFiles,
      setInput,
      setPendingImages,
      setPendingFiles,
    ]
  );

  const onSteer = useCallback(() => sendAgentText("steer"), [sendAgentText]);
  const onFollowUp = useCallback(
    () => sendAgentText("follow_up"),
    [sendAgentText]
  );

  // 切换 thinking level（同步到 runner + 后端 agent）
  const onChangeThinking = useCallback(
    async (lv: ThinkingLevel) => {
      const ownerKey = activeKeyRef.current ?? DRAFT_KEY;
      updateRunner(ownerKey, { thinkingLevel: lv });
      if (agentId) {
        try {
          await agentAction(agentId, { type: "set_thinking_level", level: lv });
        } catch {}
      }
    },
    [agentId, agentAction, updateRunner, activeKeyRef]
  );

  return {
    agentAction,
    ensureAgent,
    send,
    onAbort,
    onCompact,
    onAbortCompaction,
    onSteer,
    onFollowUp,
    onChangeThinking,
    startGoal,
    startWorkflow,
  };
}

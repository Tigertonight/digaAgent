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
import { useCallback, useRef } from "react";
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
  /** 仅供外部调用方读取该 ChatApp 当前渲染的 messages；send / startGoal /
   *  startWorkflow 内部现在不再读它，但保留在 params 上不动，避免调用方修改。 */
  messages: ChatMessage[];

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
  send: (textOverride?: string) => Promise<void>;
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
   *
   * P1 修复（新建 Agent 归属竞态）：明确接收 “发起者的 ownerKey”，不再从
   *   activeKeyRef.current 实时读。await 期间用户可能已切 session，该函数会根
   *   据 ownerAtStart 判定是否仍需要迁移、是否需要 switchTo / setSelectedId：
   *     - 只有仍是当前 active 且仍在 DRAFT 上 → switchTo + setSelectedId（不抢 UI）。
   *     - 如果 active 已变 → 仅迁移 runner 到 newKey，不 switchTo / setSelectedId。
   */
  const upgradeDraftIfNeeded = useCallback(
    (
      sessionFilePath: string | null,
      sessionId?: string | null,
      ownerKeyAtStart?: RunnerKey
    ): RunnerKey => {
      const currentActive = activeKeyRef.current ?? DRAFT_KEY;
      // P1：“创建请求属于谁，响应就写回谁”。传入明确的 ownerKey 为准；
      // 未传（老调用点）则退化为 current active，保持背后兼容。
      const ownerAtStart = ownerKeyAtStart ?? currentActive;
      if (ownerAtStart !== DRAFT_KEY || !sessionFilePath) return ownerAtStart;
      const newKey: RunnerKey = sessionFilePath;
      const idFromBackend =
        sessionId && sessionId.length > 0 ? sessionId : null;
      const idFromPath = idFromBackend ?? extractSessionIdFromPath(sessionFilePath);
      const ownerStillActive = currentActive === ownerAtStart;

      if (runnersRef.current?.has(newKey)) {
        if (ownerStillActive) {
          switchTo(newKey);
          if (idFromPath) setSelectedId(idFromPath);
        }
        return newKey;
      }
      const upgraded = runnersRef.current?.get(DRAFT_KEY);
      if (!upgraded) return ownerAtStart;
      const draftInput = getStoreInput(DRAFT_KEY);
      runnersRef.current?.set(newKey, upgraded);
      runnersRef.current?.delete(DRAFT_KEY);
      if (draftInput) setStoreInput(newKey, draftInput);
      deleteStoreInput(DRAFT_KEY);
      closeSseFor(DRAFT_KEY);
      // P1：仅在 owner 仍是当前 active 时才 switchTo / setSelectedId。
      // 用户已手动切到其它 session 时，不抢他的 UI 焦点。
      if (ownerStillActive) {
        switchTo(newKey);
        if (idFromPath) setSelectedId(idFromPath);
      }
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

  // M4：同一 ownerKey 的 agent 创建去重。第一次 POST /agent/new 还没返回时
  // （render 闭包里 agentId 仍为 null），用户再按 Enter 会再发一次创建，导致
  // 同一 DRAFT runner 上挂出两个 agent。这里用 in-flight Promise 把同 owner 的
  // 创建串起来：第二次直接 await 第一次的结果。
  const inflightEnsureRef = useRef<
    Map<RunnerKey, Promise<{ aid: string; ownerKey: RunnerKey } | null>>
  >(new Map());

  const ensureAgent = useCallback(async (): Promise<{
    aid: string;
    ownerKey: RunnerKey;
  } | null> => {
    if (agentId) {
      // 已有 agent：同步返回，不会 await，不存在竞态。
      const ownerKeyAtStart = activeKeyRef.current ?? DRAFT_KEY;
      return {
        aid: agentId,
        ownerKey: upgradeDraftIfNeeded(
          currentSessionFile,
          undefined,
          ownerKeyAtStart
        ),
      };
    }
    if (!providerId || !modelId) {
      setError("请先选择 provider 和 model");
      return null;
    }
    // M4：若同一 owner 已有创建在途，复用之，避免重复 POST /agent/new。
    const ownerKeyForInflight = activeKeyRef.current ?? DRAFT_KEY;
    const existingInflight = inflightEnsureRef.current.get(ownerKeyForInflight);
    if (existingInflight) return existingInflight;
    // P1：“创建请求属于谁，响应就写回谁”。发起时固定 ownerKey，
    // await 之后一律以 ownerKeyAtStart 为准写 runner / 升级 / attach SSE。
    // F1：优先 runner.cwd，避免使用老 agent 环境下用户修改 cwd 但未作用。
    const ownerKeyAtStart = activeKeyRef.current ?? DRAFT_KEY;
    // M4：把真正的创建逻辑包进一个可追踪的 promise，登记到 in-flight map，
    // 同 owner 的并发调用复用它；结算后清理。
    const createPromise = (async (): Promise<{
      aid: string;
      ownerKey: RunnerKey;
    } | null> => {
    const selectedIdAtStart = selectedId;
    const sessionPathAtStart = selectedIdAtStart
      ? sessions.find((s) => s.id === selectedIdAtStart)?.path
      : undefined;
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
        sessionPath: sessionPathAtStart,
      }),
    });
    const data = await r.json();
    if (data.error) {
      setError(userFacingMessage(data.error));
      return null;
    }
    if (!runnersRef.current?.has(ownerKeyAtStart)) {
      // The owning runner may have been deleted while /api/agent/new was in
      // flight. Do not attach an orphan SSE connection; dispose the fresh
      // backend agent best-effort and drop the response.
      void fetch(`/api/agent/${data.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "abort" }),
      }).catch(() => {});
      return null;
    }
    // P1：不再读 activeKeyRef.current。await 期间用户可能已切 session，
    // 留在 ownerKeyAtStart 写是“whose request, whose response”原则。
    updateRunner(ownerKeyAtStart, {
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
      data.sessionId ?? null,
      ownerKeyAtStart
    );
    // F8：SSE 只在这个唯一入口 attach，绑 owner 迁移后的 key。
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
      // P1：parentSessionPath 也用发起时的 capture，避免 await 期间用户切到
      // 其它 session 后，optimistic sidebar 以“新表”作为 parent。
      setSessions((prev) =>
        upsertOptimisticSession(prev, {
          id: data.sessionId,
          path: data.sessionFile,
          cwd: effectiveCwd,
          firstMessage: firstHint,
          parentSessionPath: sessionPathAtStart,
        })
      );
    }
    return { aid: data.id, ownerKey: upgradedKey };
    })();
    inflightEnsureRef.current.set(ownerKeyForInflight, createPromise);
    try {
      return await createPromise;
    } finally {
      if (inflightEnsureRef.current.get(ownerKeyForInflight) === createPromise) {
        inflightEnsureRef.current.delete(ownerKeyForInflight);
      }
    }
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
  const send = useCallback(async (textOverride?: string) => {
    // 【性能】接收可选的 textOverride 是为了让 Composer 可以直接传本地 localInput，
    // 不再需要 flushSync 同步写回上层 store 后才发送。flushSync 在 800 条消息的会话
    // 里只点击 Send 的这一下会同步阻塞 UI 几十毫秒，是点击到气泡出现延迟的最大项。
    const input = textOverride ?? getInput();
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
    // 【性能】一次 commit 完成所有 RunnerState 变动：optimistic user + 清 pending images/files。
    // await ensureAgent() 后的多次 setState 在 React 18 不再自动批处理，手工合并可
    // 把这段的整树 commit 从 3 次降到 1 次。
    updateRunner(ownerKey, (state) => ({
      chatState: applyEvent(state.chatState, {
        type: "__optimistic_user",
        clientRequestId,
        text: promptText,
        images: images.map((img) => ({ data: img.data, mimeType: img.mimeType })),
        attachments: attachmentPaths,
      }),
      pendingImages: [],
      pendingFiles: [],
    }));
    // setInput 走外部 store，只通知 Composer 订阅者，不进 React 树 commit。不进 batch。
    setInput("");
    setError(null);
    // 滚动行为：发送后保持贴底跟随（不锚顶）。stickToBottomRef 由滚动监听维护，
    // streamSignature effect 会在 user 气泡 + 后续 token 流入时持续 snap 到底。
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
    pendingImages,
    pendingFiles,
    agentAction,
    updateRunner,
    setInput,
    setError,
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
      // P1 修复：goal 路径也生成 clientRequestId。不这样的话 reducer 的
      // “optimistic user 衰变”逻辑在 SDK message_start 回来时不会命中，
      // 会让 UI 出现两条重复的 user 气泡。
      const clientRequestId = makeClientRequestId();
      // 结构化 Composer A6：在本地先插一条 optimistic user 气泡，携带 mode=goal。
      // 然后 SSE message_start reconcile 路径会保留 composerMeta（reducer 已实现）。
      const ownerKey = ensured.ownerKey;
      updateRunner(ownerKey, (state) => ({
        chatState: applyEvent(state.chatState, {
          type: "__optimistic_user",
          clientRequestId,
          text,
          composerMode: "goal",
        }),
      }));
      // 滚动行为：保持贴底跟随，不再锚顶 user 气泡。
      try {
        await agentAction(ensured.aid, {
          type: "goal_set",
          objective: text,
          clientRequestId,
        });
      } catch {
        /* error 已被 agentAction 设置 */
        // 发失败同样要标记，让 UI 可见 / 可重发。
        updateRunner(ownerKey, (state) => ({
          chatState: applyEvent(state.chatState, {
            type: "__optimistic_user_failed",
            clientRequestId,
            reason: "failed",
          }),
        }));
      }
    },
    [
      ensureAgent,
      guardActiveKeyMatchesSelected,
      agentAction,
      setError,
      updateRunner,
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
      // Soft guidance (Claude Code style): steer toward the workflow harness and
      // good orchestration habits, but DO NOT forbid brief read-only recon —
      // grounding a plan in the actual repo/state is healthy agent behavior.
      const aside = [
        "请用 dynamic workflow 来完成上面这个目标。建议流程：",
        "1) 复用优先：先调用 list_workflow_skills / list_workflow_templates，若已有可复用的，用 run_workflow_script({ skillRef }) 或 run_workflow_template 执行，不要从头重写大脚本。",
        "2) 允许少量只读探查（如读文件/检索）来把计划落到真实代码/状态上，但不要在对话里手动一步步把整件事做完——真正的执行应放进 workflow harness。",
        "3) 规划 workflow script：拆解步骤，在关键节点写 checkpoint 和 artifact；按复杂度配置 agent 数量（简单任务 1 个、对比类 2-4 个、复杂任务更多且分工明确），不要为简单任务过度并发。",
        "4) 质量门槛：扇出的子任务在进入综合前用 workflow.requireSuccess 把关；产出报告/产物时声明 successCriteria，避免“形式完成、实质为空”。",
        "5) 执行完综合给出最终结果；若可复用，用 save_workflow_skill 沉淀。",
      ].join("\n");
      const prompt = [
        text,
        "",
        CONTEXT_ASIDE_OPEN,
        aside,
        CONTEXT_ASIDE_CLOSE,
      ].join("\n");

      // 滚动行为：保持贴底跟随，不再锚顶 user 气泡。

      // P1 修复：workflow 路径也生成 clientRequestId；workflow 下发靠的是
      // type:"prompt"，后端 prompt 分支本身支持 cri 去重 + ack，不需要动后端。
      const clientRequestId = makeClientRequestId();
      // 结构化 Composer A6：optimistic user 气泡携 mode=workflow。
      // text 只带用户原话；SSE message_start 收到的 finalText 含 aside，reducer 会 strip 后衰变。
      const ownerKeyW = ensured.ownerKey;
      updateRunner(ownerKeyW, (state) => ({
        chatState: applyEvent(state.chatState, {
          type: "__optimistic_user",
          clientRequestId,
          text,
          composerMode: "workflow",
        }),
      }));

      try {
        await agentAction(ensured.aid, {
          type: "prompt",
          text: prompt,
          clientRequestId,
        });
      } catch {
        /* error 已被 agentAction 设置 */
        updateRunner(ownerKeyW, (state) => ({
          chatState: applyEvent(state.chatState, {
            type: "__optimistic_user_failed",
            clientRequestId,
            reason: "failed",
          }),
        }));
      }
    },
    [
      ensureAgent,
      guardActiveKeyMatchesSelected,
      agentAction,
      setError,
      updateRunner,
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
      // P2 修复：不再把 @path 拼进可见文本（会让历史 user 气泡里出玄路径）。
      // 附件以独立字段 attachments 下发，后端复用与 prompt 一致的 aside 起装。
      const attachmentPaths = pendingFiles.map((a) => a.path);
      try {
        await agentAction(agentId, {
          type,
          text,
          ...(pendingImages.length ? { images: pendingImages } : {}),
          ...(attachmentPaths.length
            ? { attachments: attachmentPaths }
            : {}),
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

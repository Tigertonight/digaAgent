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
import {
  deleteInput as deleteStoreInput,
  getInput as getStoreInput,
  setInput as setStoreInput,
} from "@/lib/composer/input-store";

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
 * 从 sessionFile 路径里解出 sessionId（UUID）。
 * 形如 ".../<timestamp>_<uuid>.jsonl" 或 ".../<uuid>.jsonl"。
 * 解不出返回 null —— 调用方走兜底（等 refreshSessions 后从列表里匹配）。
 *
 * 备注：与 ChatApp.tsx 内同名 helper 一份复制（避免 app/ → app/hooks/ 反向依赖）；
 * 后续阶段可统一搬到 lib/session-utils.ts。
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

  const upgradeDraftIfNeeded = useCallback(
    (sessionFilePath: string | null): RunnerKey => {
      const currentKey = activeKeyRef.current ?? DRAFT_KEY;
      if (currentKey !== DRAFT_KEY || !sessionFilePath) return currentKey;
      const newKey: RunnerKey = sessionFilePath;
      if (runnersRef.current?.has(newKey)) {
        switchTo(newKey);
        const idFromPath = extractSessionIdFromPath(sessionFilePath);
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
      const idFromPath = extractSessionIdFromPath(sessionFilePath);
      if (idFromPath) setSelectedId(idFromPath);
      setRunner(DRAFT_KEY, emptyRunner());
      const aid = upgraded.agentId;
      if (aid) attachSseFor(newKey, aid);
      return newKey;
    },
    [
      activeKeyRef,
      runnersRef,
      switchTo,
      setSelectedId,
      closeSseFor,
      setRunner,
      attachSseFor,
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
    const r = await fetch("/api/agent/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: providerId,
        modelId,
        cwd,
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
    const upgradedKey = upgradeDraftIfNeeded(data.sessionFile ?? null);
    attachSseFor(upgradedKey, data.id);
    void refreshStats(data.id, upgradedKey);
    void refreshToolsCount(data.id, upgradedKey);
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
    activeKeyRef,
    updateRunner,
    upgradeDraftIfNeeded,
    attachSseFor,
    refreshStats,
    refreshToolsCount,
    setError,
  ]);

  // 发送一条新 prompt
  // 两条分支：
  //   - 冷启动（agentId == null）：fetch /api/agent/new → 升级草稿 → attachSSE → 拉 stats
  //   - 已有 agent（startNewSession eager create 过）：只走草稿升级
  const send = useCallback(async () => {
    const input = getInput();
    if (
      !input.trim() &&
      pendingImages.length === 0 &&
      pendingFiles.length === 0
    )
      return;
    let aid = agentId;
    let ownerKeyForPrompt = activeKeyRef.current ?? DRAFT_KEY;
    if (!aid) {
      if (!providerId || !modelId) {
        setError("请先选择 provider 和 model");
        return;
      }
      const r = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          modelId,
          cwd,
          thinkingLevel,
          sessionPath: selectedId
            ? sessions.find((s) => s.id === selectedId)?.path
            : undefined,
        }),
      });
      const data = await r.json();
      if (data.error) {
        setError(userFacingMessage(data.error));
        return;
      }
      aid = data.id;
      // 当前活跃 runner 接收 agent 信息（可能是 draft，也可能是 session.path）
      const ownerKey = activeKeyRef.current ?? DRAFT_KEY;
      updateRunner(ownerKey, {
        agentId: data.id,
        agentSessionId: data.sessionId,
        sessionFile: data.sessionFile ?? null,
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

      ownerKeyForPrompt = upgradeDraftIfNeeded(data.sessionFile ?? null);

      attachSseFor(ownerKeyForPrompt, data.id);
      void refreshStats(data.id, ownerKeyForPrompt);
      void refreshToolsCount(data.id, ownerKeyForPrompt);
    } else {
      // Fast path：agent 已被 startNewSession eager create。这里也要做 draft → sessionFile 升级，
      // 否则 +New chat 之后所有 session 都积压在 DRAFT_KEY 上，LRU/多 session 全失效。
      ownerKeyForPrompt = upgradeDraftIfNeeded(currentSessionFile);
    }
    const userText = input;
    const images = pendingImages;
    const attachments = pendingFiles;
    // 展示文本 = 用户原话（不再把 @path 拼进去）。
    // 附件引用单独通过 attachments 字段传给后端，由后端作为上下文 aside 喂给模型，
    // 这样前台气泡只显示用户输入的原文。
    const attachmentPaths = attachments.map((a) => a.path);
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
      await agentAction(aid!, {
        type: "prompt",
        text: userText || (attachmentPaths.length > 0 ? "(see attachments)" : "(image)"),
        images: images.length > 0 ? images : undefined,
        attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
      });
    } catch {
      /* error 已被 agentAction 设置 */
    }
  }, [
    agentId,
    getInput,
    messages,
    pendingImages,
    pendingFiles,
    cwd,
    selectedId,
    sessions,
    providerId,
    modelId,
    thinkingLevel,
    currentSessionFile,
    attachSseFor,
    agentAction,
    refreshStats,
    refreshToolsCount,
    updateRunner,
    activeKeyRef,
    upgradeDraftIfNeeded,
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
      const ensured = await ensureAgent();
      if (!ensured) return;
      setError(null);
      try {
        await agentAction(ensured.aid, {
          type: "goal_set",
          objective: text,
        });
      } catch {
        /* error 已被 agentAction 设置 */
      }
    },
    [ensureAgent, agentAction, setError]
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
      const ensured = await ensureAgent();
      if (!ensured) return;
      setError(null);

      const prompt = [
        "请使用 dynamic workflow（run_workflow_script 工具）来完成下面这个目标，",
        "不要直接在对话里手动一步步执行：",
        "",
        `objective: ${text}`,
        "",
        "请规划出一个 workflow script：先拆解步骤，在关键节点写 checkpoint 和 artifact，",
        "执行完后综合给出最终结果。",
      ].join("\n");

      // 滚动锚定：让新出现的这条 user 消息滚到屏顶（与 send 一致）。
      const currentUserCount = messages.filter((m) => m.role === "user").length;
      pendingPinUserCountRef.current = currentUserCount + 1;
      setPinSpacer(true);

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
      agentAction,
      setError,
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

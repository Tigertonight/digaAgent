/**
 * /api/agent/[id]
 *
 * 单口多 action（对齐 @agegr/pi-web）。
 *
 * POST body 形如 { type: "<action>", ...args }
 * 支持的 action（snake_case）：
 *   - prompt              { text }                            发送一条 user message
 *   - steer               { text }                            打断当前 turn，立即插入
 *   - follow_up           { text }                            追加到当前 turn 后
 *   - abort                                                   中止当前 agent 操作
 *   - abort_compaction                                        取消进行中的压缩
 *   - compact             { customInstructions? }             手动触发压缩
 *   - set_model           { provider, modelId }               切换模型
 *   - set_thinking_level  { level }                           切换 thinking level
 *   - get_tools                                               读取当前工具列表（GET 形态在下方）
 *   - set_tools           { tools: string[] }                 设置工具白名单（暂未接 SDK，预留）
 *   - navigate_tree       { targetId, summarize?, ... }       fork/分支跳转
 */
import { NextResponse } from "next/server";
import {
  createAgent,
  getAgent,
  disposeAgent,
  getModelRegistry,
  abortSubagentsForParent,
  abortWorkflowsForParent,
  pushExternalEvent,
  pushGoalEvent,
  pushProgressEvent,
  claimClientRequest,
  clearClientRequest,
  isLocalCodingAssistantAgent,
  promptLocalCodingAssistantAgent,
  abortLocalCodingAssistantAgent,
  LOCAL_CODING_ASSISTANT_MODELS,
  LOCAL_CODING_ASSISTANT_PROVIDER_ID,
  finishStreamingAfterPromptError,
} from "@/lib/agent-registry";
import {
  clearGoal,
  findAgentIdBySessionId,
  getGoal,
  listGoalEvidence,
  listGoalTurns,
  normalizeObjective,
  setGoal,
  setGoalStatus,
} from "@/lib/goal/server-store";
import { internalErrorResponse } from "@/lib/api/error-response";
import { applyGoalUpdate } from "@/lib/goal/update";
import { listDefinitions } from "@/lib/subagents/registry";
import {
  composePromptWithAside,
  parseAttachments,
} from "@/lib/composer/aside-prompt";
import { withCommunicationInstructions } from "@/lib/communication/instructions";
import { getCommunicationSettings } from "@/lib/communication/settings";
import {
  clearProgress,
  failOpenProgress,
  getProgress,
  updateProgress,
} from "@/lib/progress/server-store";
import {
  readPersistedProgress,
  writePersistedProgress,
} from "@/lib/progress/file-store";
import { listEvidence } from "@/lib/evidence/server-store";
import type { EvidenceKind } from "@/lib/evidence/types";
import { listRuntimeEvents } from "@/lib/runtime/event-store";
import type {
  RuntimeEventSource,
  RuntimeEventStatus,
} from "@/lib/runtime/events";
import {
  listPendingClarifications,
  resolveClarification,
} from "@/lib/clarification/server-store";
import {
  CONTEXT_ASIDE_OPEN,
  CONTEXT_ASIDE_CLOSE,
  stripContextAside,
} from "@/lib/context-aside";
import { assertRemoteAuth } from "@/lib/remote/auth";
import type { ProgressUpdateInput } from "@/lib/progress/types";
import type { ThinkingLevel, ImageContentLite } from "@/lib/types";

/** 校验并清洗 body.images */
function parseImages(raw: unknown): ImageContentLite[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ImageContentLite[] = [];
  for (const it of raw) {
    if (
      it &&
      typeof it === "object" &&
      typeof (it as { data?: unknown }).data === "string" &&
      typeof (it as { mimeType?: unknown }).mimeType === "string"
    ) {
      out.push({
        type: "image",
        data: (it as { data: string }).data,
        mimeType: (it as { mimeType: string }).mimeType,
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseProgressUpdate(body: Record<string, unknown>): ProgressUpdateInput {
  return {
    steps: Array.isArray(body.steps)
      ? (body.steps as ProgressUpdateInput["steps"])
      : undefined,
    artifacts: Array.isArray(body.artifacts)
      ? (body.artifacts as ProgressUpdateInput["artifacts"])
      : undefined,
    replaceSteps: body.replaceSteps === true,
    replaceArtifacts: body.replaceArtifacts === true,
  };
}

async function persistProgressForAgent(
  rec: NonNullable<ReturnType<typeof getAgent>>,
  progress: ReturnType<typeof getProgress>
): Promise<void> {
  try {
    await writePersistedProgress(rec.session.sessionId, progress);
  } catch {
    // Progress persistence is best-effort; UI should not fail a tool/run because
    // the auxiliary runtime cache cannot be written.
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: agent meta + 可选 ?action=get_tools / context / thinking_levels */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  const { id } = await params;

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // G2：goal_timeline 不要求 live agent 存在。重启 / 版本更新后，只要
  // goal/turn/evidence 在磁盘上（根据 agentId 或 sessionId）能 hydrate 出来，就能返回。
  if (action === "goal_timeline") {
    const directGoal = getGoal(id);
    if (directGoal) {
      return NextResponse.json({
        goal: directGoal,
        turns: listGoalTurns(id),
        evidence: listGoalEvidence(id),
      });
    }
    // 本 agentId 没有 envelope，试看能不能通过该 agent 的 sessionId 反查老 envelope。
    const liveRec = getAgent(id);
    const fallbackSessionId = liveRec?.session.sessionId;
    if (fallbackSessionId) {
      const fallbackAgentId = findAgentIdBySessionId(fallbackSessionId);
      if (fallbackAgentId && fallbackAgentId !== id) {
        return NextResponse.json({
          goal: getGoal(fallbackAgentId),
          turns: listGoalTurns(fallbackAgentId),
          evidence: listGoalEvidence(fallbackAgentId),
        });
      }
    }
    return NextResponse.json({ goal: null, turns: [], evidence: [] });
  }

  const rec = getAgent(id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (action === "get_tools") {
    // 用 SDK 的 getAllTools()/getActiveToolNames() 返回全量工具 + 当前已启用的名字
    try {
      const all = rec.session.getAllTools();
      const active = rec.session.getActiveToolNames();
      return NextResponse.json({ tools: all, active });
    } catch (e) {
      return NextResponse.json(
        { error: (e as Error).message, tools: [], active: [] },
        { status: 500 }
      );
    }
  }
  if (action === "thinking_levels") {
    return NextResponse.json({
      levels: rec.session.getAvailableThinkingLevels(),
      current: rec.session.thinkingLevel,
      supports: rec.session.supportsThinking(),
    });
  }
  if (action === "user_messages_for_forking") {
    // 剥离「上下文 aside」，fork 列表只显示用户原话。
    const messages = rec.session.getUserMessagesForForking().map((m) => ({
      ...m,
      text: typeof m.text === "string" ? stripContextAside(m.text) : m.text,
    }));
    return NextResponse.json({ messages });
  }
  if (action === "tree") {
    // 返回 SDK 的 session tree + 当前 leafId，用于 Branches 视图。
    // tree 节点带 entry/children/label，前端按 type=message 展示，其它类型可省略或淡化。
    try {
      const sm = rec.session.sessionManager;
      const tree = sm.getTree();
      const leafId = sm.getLeafId();
      return NextResponse.json({ tree, leafId });
    } catch (e) {
      return NextResponse.json(
        { error: (e as Error).message, tree: [], leafId: null },
        { status: 500 }
      );
    }
  }
  if (action === "system_prompt") {
    try {
      return NextResponse.json({
        systemPrompt: rec.session.systemPrompt ?? "",
      });
    } catch (e) {
      return NextResponse.json(
        { error: (e as Error).message, systemPrompt: "" },
        { status: 500 }
      );
    }
  }
  if (action === "runtime_events") {
    return NextResponse.json({
      events: listRuntimeEvents({
        agentId: id,
        source: parseRuntimeEventSource(url.searchParams.get("source")),
        status: parseRuntimeEventStatus(url.searchParams.get("status")),
        browserId: url.searchParams.get("browserId") ?? undefined,
        taskId: url.searchParams.get("taskId") ?? undefined,
        workflowId: url.searchParams.get("workflowId") ?? undefined,
        parentId: url.searchParams.get("parentId") ?? undefined,
      }),
    });
  }

  if (action === "evidence") {
    return NextResponse.json({
      evidence: listEvidence({
        agentId: id,
        kind: parseEvidenceKind(url.searchParams.get("kind")),
        browserId: url.searchParams.get("browserId") ?? undefined,
        taskId: url.searchParams.get("taskId") ?? undefined,
        workflowId: url.searchParams.get("workflowId") ?? undefined,
      }),
    });
  }

  if (action === "stats") {
    // 实时 token/cost/context window 统计（pi-web 风格 HUD）
    try {
      const stats = rec.session.getSessionStats();
      const ctxUsage = rec.session.getContextUsage();
      const model = rec.session.model;
      return NextResponse.json({
        stats,
        contextUsage: ctxUsage ?? null,
        contextWindow: model?.contextWindow ?? null,
        model: model
          ? { provider: model.provider, id: model.id, name: model.name }
          : null,
      });
    } catch (e) {
      return NextResponse.json(
        { error: (e as Error).message },
        { status: 500 }
      );
    }
  }

  const memoryProgress = getProgress(id);
  const persistedProgress =
    memoryProgress.groups.length === 0 &&
    memoryProgress.steps.length === 0 &&
    memoryProgress.artifacts.length === 0
      ? await readPersistedProgress(rec.session.sessionId)
      : null;

  return NextResponse.json({
    id: rec.id,
    sessionId: rec.session.sessionId,
    sessionFile: rec.session.sessionFile,
    isStreaming: rec.isStreaming,
    isCompacting: (rec.session as unknown as { isCompacting?: boolean })
      .isCompacting,
    thinkingLevel: rec.session.thinkingLevel,
    supportsThinking: rec.session.supportsThinking(),
    availableThinkingLevels: rec.session.getAvailableThinkingLevels(),
    model: rec.session.model
      ? {
          provider: rec.session.model.provider,
          id: rec.session.model.id,
          name: rec.session.model.name,
          contextWindow: rec.session.model.contextWindow,
        }
      : null,
    pendingMessageCount: rec.session.pendingMessageCount,
    nextSeq: rec.nextSeq,
    goal: getGoal(id),
    progress: persistedProgress ?? memoryProgress,
  });
}

function parseRuntimeEventSource(
  value: string | null
): RuntimeEventSource | undefined {
  return value === "agent" ||
    value === "browser" ||
    value === "workflow" ||
    value === "subagent" ||
    value === "goal" ||
    value === "approval" ||
    value === "progress"
    ? value
    : undefined;
}

function parseRuntimeEventStatus(
  value: string | null
): RuntimeEventStatus | undefined {
  return value === "queued" ||
    value === "running" ||
    value === "done" ||
    value === "error" ||
    value === "blocked" ||
    value === "aborted"
    ? value
    : undefined;
}

function parseEvidenceKind(value: string | null): EvidenceKind | undefined {
  return value === "browser_snapshot" ||
    value === "browser_step" ||
    value === "browser_annotation" ||
    value === "workflow_artifact" ||
    value === "subagent_result" ||
    value === "goal_turn" ||
    value === "approval_decision" ||
    value === "progress_artifact" ||
    value === "log"
    ? value
    : undefined;
}

/** POST: 多 action 派发 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  const { id } = await params;
  const rec = getAgent(id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // 允许空 body（abort 等）
  }

  // 兼容老字段 action（驼峰），新字段 type（snake_case）
  const type =
    (body.type as string | undefined) ?? (body.action as string | undefined);

  if (!type) {
    return NextResponse.json(
      { error: "missing 'type' field" },
      { status: 400 }
    );
  }

  try {
    switch (type) {
      case "prompt": {
        const text = body.text as string;
        if (!text || typeof text !== "string") {
          return NextResponse.json(
            { error: "text required" },
            { status: 400 }
          );
        }
        const clientRequestId =
          typeof body.clientRequestId === "string"
            ? body.clientRequestId.trim().slice(0, 128)
            : "";
        if (
          clientRequestId &&
          !claimClientRequest(rec.id, clientRequestId)
        ) {
          return NextResponse.json({ ok: true, deduped: true });
        }
        const images = parseImages(body.images) ?? [];
        // 附件引用（@path）：前端单独传 attachments，不再拼进展示文本。
        const attachments = Array.isArray(body.attachments)
          ? (body.attachments as unknown[]).filter(
              (a): a is string => typeof a === "string"
            )
          : [];

        // 浏览器交互不再在 prompt 前「预执行」。
        // agent 现在通过结构化 browser_* 工具自主多步操作浏览器
        // （见 lib/browser/extension.ts），每步会通过 SSE 推 browser_state，
        // 因此这里不再做基于正则的意图预跑（避免同一句话被执行两次）。

        // 1) 提取 @agent 提及 + 包装 attachments aside，统一走 composePromptWithAside。
        //    同样的函数也被 steer / follow_up 复用于 attachments（但不启用 mention 路由）。
        const specialistIds = listDefinitions(rec.cwd).map((d) => d.id);
        const { displayText, finalText, mentionDirective } =
          composePromptWithAside(text, attachments, { specialistIds });
        const finalTextWithMode = withCommunicationInstructions(
          finalText,
          await getCommunicationSettings()
        );

        // F-A5 双气泡修复：prompt 进 SDK 之前先 push 一条 optimistic_user_ack，
        // 让前端 reducer 按 clientRequestId 把 pending user 气泡的 text 衰变为 displayText
        // （stripAgentMentions 后的版本）。后面 SDK 的 user message_start 同文本重间
        // 同一条不会产生双气泡。仅在拿到 clientRequestId 时 push。
        if (clientRequestId) {
          pushExternalEvent(rec, {
            type: "optimistic_user_ack",
            clientRequestId,
            displayText,
          });
        }

        try {
          const pendingClarifications = listPendingClarifications(id);
          if (
            pendingClarifications.length > 0 &&
            displayText.trim() &&
            images.length === 0 &&
            attachments.length === 0
          ) {
            const pending = pendingClarifications.at(-1)!;
            const ok = resolveClarification(pending.id, {
              customText: displayText.trim(),
            });
            if (ok) {
              return NextResponse.json({
                ok: true,
                resolvedClarification: pending.requestId,
              });
            }
          }
          if (isLocalCodingAssistantAgent(rec)) {
            await promptLocalCodingAssistantAgent(rec, finalTextWithMode);
            return NextResponse.json({
              ok: true,
              ...(mentionDirective
                ? { routedSpecialists: mentionDirective.agentIds }
                : {}),
            });
          }
          // 如果当前在 streaming，默认按 followUp 处理；否则正常 prompt
          // P3 修复：`images` 在上面被 `?? []` 归一为数组，虚假 truthy，
          // 会让无图请求也传 `{ images: [] }`。该参数必须是
          // images.length > 0 才传，避免 SDK 对空 multimodal 参数敏感。
          const imagesOpt = images.length > 0 ? { images } : undefined;
          if (rec.isStreaming) {
            await rec.session.prompt(finalTextWithMode, {
              streamingBehavior: "followUp",
              ...(imagesOpt ?? {}),
            });
          } else {
            await rec.session.prompt(finalTextWithMode, imagesOpt);
          }
        } catch (e) {
          finishStreamingAfterPromptError(rec.id);
          clearClientRequest(rec.id, clientRequestId);
          throw e;
        }
        return NextResponse.json({
          ok: true,
          ...(mentionDirective
            ? { routedSpecialists: mentionDirective.agentIds }
            : {}),
        });
      }

      case "steer":
      case "steering": {
        const text = body.text as string;
        if (!text || typeof text !== "string") {
          return NextResponse.json(
            { error: "text required" },
            { status: 400 }
          );
        }
        // P2 修复：steer 也接受 attachments，复用 prompt 的 aside 起装。
        // 不走 mention 路由（specialistIds = []）以免扩大 streaming 路径的行为面。
        const attachments = parseAttachments(body.attachments);
        const { finalText } = composePromptWithAside(text, attachments, {
          specialistIds: [],
        });
        const finalTextWithMode = withCommunicationInstructions(
          finalText,
          await getCommunicationSettings()
        );
        const images = parseImages(body.images);
        if (isLocalCodingAssistantAgent(rec)) {
          void images;
          await promptLocalCodingAssistantAgent(rec, finalTextWithMode);
          return NextResponse.json({ ok: true });
        }
        await rec.session.steer(finalTextWithMode, images);
        return NextResponse.json({ ok: true });
      }

      case "follow_up":
      case "followUp": {
        const text = body.text as string;
        if (!text || typeof text !== "string") {
          return NextResponse.json(
            { error: "text required" },
            { status: 400 }
          );
        }
        // P2 修复：follow_up 也接受 attachments，复用 prompt 的 aside 起装。
        const attachments = parseAttachments(body.attachments);
        const { finalText } = composePromptWithAside(text, attachments, {
          specialistIds: [],
        });
        const finalTextWithMode = withCommunicationInstructions(
          finalText,
          await getCommunicationSettings()
        );
        const images = parseImages(body.images);
        if (isLocalCodingAssistantAgent(rec)) {
          void images;
          await promptLocalCodingAssistantAgent(rec, finalTextWithMode);
          return NextResponse.json({ ok: true });
        }
        await rec.session.followUp(finalTextWithMode, images);
        return NextResponse.json({ ok: true });
      }

      case "goal_status": {
        return NextResponse.json({
          ok: true,
          goal: getGoal(id),
          progress: getProgress(id),
        });
      }

      case "goal_set": {
        const objective = normalizeObjective(body.objective);
        if (!objective) {
          return NextResponse.json(
            { error: "objective required" },
            { status: 400 }
          );
        }
        // P1 修复：goal 也接受 clientRequestId，跟 prompt 路径一致：
        //   1. claim 去重（同一 cri 双击 / 重提交不会双调 setGoal）
        //   2. 在调 SDK prompt 之前先 push optimistic_user_ack，让 reducer 衰变
        //      pending optimistic 为“干净原文”，避免后续 message_start 产生双气泡。
        const clientRequestId =
          typeof body.clientRequestId === "string"
            ? body.clientRequestId.trim().slice(0, 128)
            : "";
        if (
          clientRequestId &&
          !claimClientRequest(rec.id, clientRequestId)
        ) {
          return NextResponse.json({ ok: true, deduped: true });
        }
        const tokenBudget =
          typeof body.tokenBudget === "number" ? body.tokenBudget : undefined;
        const goal = setGoal(id, objective, tokenBudget);
        pushGoalEvent(rec, goal);
        const progress = clearProgress(id);
        await persistProgressForAgent(rec, progress);
        pushProgressEvent(rec, progress);

        // 控制规则走 CONTEXT_ASIDE，UI 可见部分 = 用户 objective 原文。
        const goalAside = [
          "This is the active goal context. Treat the visible text above as the goal to start working toward.",
          "The goal text is both the starting prompt and the completion criteria.",
          "For multi-step work, call update_progress early with concrete progress nodes and keep it current as milestones finish.",
          "Attach evidence artifacts with update_progress when you create files, URLs, screenshots, tests, diffs, logs, or browser observations.",
          "If the full goal is achieved, call goal_update with status=complete.",
          "If you are truly blocked and cannot make meaningful progress without user input or an external change, call goal_update with status=blocked and include a short blockedReason.",
        ].join("\n");
        const prompt = withCommunicationInstructions(
          [
            objective,
            "",
            CONTEXT_ASIDE_OPEN,
            goalAside,
            CONTEXT_ASIDE_CLOSE,
          ].join("\n"),
          await getCommunicationSettings()
        );

        // F-A5 双气泡修复（goal 同补）：调 SDK 之前先 push optimistic_user_ack。
        // displayText = objective（SDK 后续 message_start 的文本是 objective + aside，
        // 但 reducer 会 stripContextAside）。
        if (clientRequestId) {
          pushExternalEvent(rec, {
            type: "optimistic_user_ack",
            clientRequestId,
            displayText: objective,
          });
        }
        try {
          if (rec.isStreaming) await rec.session.followUp(prompt);
          else await rec.session.prompt(prompt);
        } catch (e) {
          finishStreamingAfterPromptError(rec.id);
          clearClientRequest(rec.id, clientRequestId);
          throw e;
        }
        return NextResponse.json({ ok: true, goal });
      }

      case "goal_pause": {
        const goal = setGoalStatus(id, "paused", {
          pauseReason:
            typeof body.reason === "string" ? body.reason : "Paused by user.",
        });
        pushGoalEvent(rec, goal);
        return NextResponse.json({ ok: true, goal });
      }

      case "goal_resume": {
        const goal = setGoalStatus(id, "active");
        pushGoalEvent(rec, goal);
        if (goal && !rec.isStreaming) {
          // 同样：UI 可见 = goal.objective、控制指令走 aside。
          const resumeAside = [
            "Resume working toward this active goal. Treat the visible text above as the goal.",
            "Do the next useful step. Use goal_update when the goal is complete or truly blocked.",
          ].join("\n");
          try {
            await rec.session.prompt(
              withCommunicationInstructions(
                [
                  goal.objective,
                  "",
                  CONTEXT_ASIDE_OPEN,
                  resumeAside,
                  CONTEXT_ASIDE_CLOSE,
                ].join("\n"),
                await getCommunicationSettings()
              )
            );
          } catch (e) {
            finishStreamingAfterPromptError(rec.id);
            throw e;
          }
        }
        return NextResponse.json({ ok: true, goal });
      }

      case "goal_clear": {
        clearGoal(id);
        const progress = clearProgress(id);
        await persistProgressForAgent(rec, progress);
        pushGoalEvent(rec, null);
        pushProgressEvent(rec, progress);
        return NextResponse.json({ ok: true, goal: null });
      }

      case "progress_update": {
        const progress = updateProgress(id, parseProgressUpdate(body));
        await persistProgressForAgent(rec, progress);
        pushProgressEvent(rec, progress);
        return NextResponse.json({ ok: true, progress });
      }

      case "goal_update": {
        const status = body.status;
        if (status !== "complete" && status !== "blocked") {
          return NextResponse.json(
            { error: "status must be complete or blocked" },
            { status: 400 }
          );
        }
        // Route through the stop-time verifier so a premature `complete` is
        // rejected instead of silently closing the goal.
        const result = applyGoalUpdate(id, {
          status,
          blockedReason:
            typeof body.blockedReason === "string"
              ? body.blockedReason
              : undefined,
        });
        if (result.accepted) pushGoalEvent(rec, result.goal);
        return NextResponse.json({
          ok: true,
          goal: result.goal,
          accepted: result.accepted,
          ...(result.rejectionNote
            ? { rejectionNote: result.rejectionNote }
            : {}),
          ...(result.evaluation ? { evaluation: result.evaluation } : {}),
        });
      }

      case "abort": {
        const progress = failOpenProgress(id, "用户已中止当前任务。");
        await persistProgressForAgent(rec, progress);
        pushProgressEvent(rec, progress);
        await abortWorkflowsForParent(id);
        await abortSubagentsForParent(id);
        if (isLocalCodingAssistantAgent(rec)) await abortLocalCodingAssistantAgent(rec);
        else await rec.session.abort();
        // SDK 不一定会再送 agent_end（底层 stream 已被拆）。为避免 sidebar 黄点
        // 一直亮着，这里主动将 record.isStreaming 扯低。getRunningSessionFiles 下一
        // 次被 GET /api/sessions 调用时就会不再含该 sessionFile。
        rec.isStreaming = false;
        rec.updatedAt = Date.now();
        return NextResponse.json({ ok: true, progress });
      }

      case "abort_compaction":
      case "abortCompaction": {
        rec.session.abortCompaction();
        return NextResponse.json({ ok: true });
      }

      case "compact": {
        const customInstructions = body.customInstructions as
          | string
          | undefined;
        const result = await rec.session.compact(customInstructions);
        return NextResponse.json({ ok: true, result });
      }

      case "set_model":
      case "setModel": {
        const provider = body.provider as string;
        const modelId = body.modelId as string;
        if (!provider || !modelId) {
          return NextResponse.json(
            { error: "provider and modelId required" },
            { status: 400 }
          );
        }
        if (provider === LOCAL_CODING_ASSISTANT_PROVIDER_ID) {
          const model = LOCAL_CODING_ASSISTANT_MODELS.find((item) => item.id === modelId);
          if (!model) {
            return NextResponse.json(
              { error: `model not found: ${provider}/${modelId}` },
              { status: 404 }
            );
          }
          if (!isLocalCodingAssistantAgent(rec)) {
            const replacement = await createAgent({
              provider,
              modelId,
              cwd: rec.cwd,
              thinkingLevel: rec.session.thinkingLevel,
            });
            disposeAgent(id);
            return NextResponse.json({
              ok: true,
              replacementAgent: replacement,
              model: {
                provider: LOCAL_CODING_ASSISTANT_PROVIDER_ID,
                id: model.id,
                name: model.name,
              },
            });
          }
          const nextModel = {
            provider: LOCAL_CODING_ASSISTANT_PROVIDER_ID,
            id: model.id,
            name: model.name,
            api: "local-cli",
            baseUrl: "local-cli",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 64000,
          };
          await rec.session.setModel(nextModel as never);
          return NextResponse.json({
            ok: true,
            model: {
              provider: nextModel.provider,
              id: nextModel.id,
              name: nextModel.name,
            },
          });
        }
        if (isLocalCodingAssistantAgent(rec)) {
          const mr = getModelRegistry();
          const model = mr.find(provider, modelId);
          if (!model) {
            return NextResponse.json(
              { error: `model not found: ${provider}/${modelId}` },
              { status: 404 }
            );
          }
          const replacement = await createAgent({
            provider,
            modelId,
            cwd: rec.cwd,
            thinkingLevel: rec.session.thinkingLevel,
          });
          disposeAgent(id);
          return NextResponse.json({
            ok: true,
            replacementAgent: replacement,
            model: { provider: model.provider, id: model.id, name: model.name },
          });
        }
        const mr = getModelRegistry();
        const model = mr.find(provider, modelId);
        if (!model) {
          return NextResponse.json(
            { error: `model not found: ${provider}/${modelId}` },
            { status: 404 }
          );
        }
        await rec.session.setModel(model);
        return NextResponse.json({
          ok: true,
          model: { provider: model.provider, id: model.id, name: model.name },
        });
      }

      case "set_thinking_level":
      case "setThinkingLevel": {
        const level = body.level as ThinkingLevel;
        if (!level) {
          return NextResponse.json(
            { error: "level required" },
            { status: 400 }
          );
        }
        rec.session.setThinkingLevel(level);
        return NextResponse.json({
          ok: true,
          thinkingLevel: rec.session.thinkingLevel,
        });
      }

      case "set_tools": {
        // tools: string[] — 要启用的工具名集合（其余会被禁用）
        const raw = body.tools as unknown;
        if (!Array.isArray(raw)) {
          return NextResponse.json(
            { error: "tools (string[]) required" },
            { status: 400 }
          );
        }
        const names = raw.filter((x): x is string => typeof x === "string");
        rec.session.setActiveToolsByName(names);
        return NextResponse.json({
          ok: true,
          active: rec.session.getActiveToolNames(),
        });
      }

      case "navigate_tree":
      case "navigateTree": {
        const targetId = body.targetId as string;
        if (!targetId) {
          return NextResponse.json(
            { error: "targetId required" },
            { status: 400 }
          );
        }
        const result = await rec.session.navigateTree(targetId, {
          summarize: body.summarize as boolean | undefined,
          customInstructions: body.customInstructions as string | undefined,
          replaceInstructions: body.replaceInstructions as boolean | undefined,
          label: body.label as string | undefined,
        });
        return NextResponse.json({ ok: true, result });
      }

      default:
        return NextResponse.json(
          { error: `unknown action: ${type}` },
          { status: 400 }
        );
    }
  } catch (e) {
    // N1: do not leak raw message + stack (abs paths, cwd, internal modules) to
    // the client. Mirror the sessions routes' S3 sanitization: log server-side,
    // return a generic message.
    return internalErrorResponse(e, { scope: "POST /api/agent/[id]" });
  }
}

/** DELETE: dispose agent */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  disposeAgent(id);
  return NextResponse.json({ ok: true });
}

/**
 * 把 AgentSession 流出来的事件累积成 ChatMessage[]。
 *
 * 我们维护一个 in-progress 的 assistant message，按事件顺序往 parts 里 push：
 *   - text_delta      → 合并到最后一个 text part（若不存在则新建）
 *   - thinking_delta  → 合并到最后一个 thinking part
 *   - tool_execution_start  → 新建一个 tool part（status="running"）
 *   - tool_execution_update → 找到对应 toolCallId 的 part，更新 partialResult
 *   - tool_execution_end    → 找到对应 part，写 result/isError，置 status
 *   - message_end           → 当前 assistant message 完结（不动 parts，只是把指针清掉）
 *
 * 这样可以保证 text/thinking/tool 的顺序与 LLM 实际产出顺序一致，
 * 跟 pi-web 的渲染模型对齐。
 */
import type {
  ChatMessage,
  ChatMessageMeta,
  ChatMessageUsage,
  MessagePart,
} from "./types";
import type { ClarificationOption } from "./clarification/types";
import type {
  SubagentAuditEvent,
  SubagentBatch,
  SubagentBatchPlan,
  SubagentBatchSynthesis,
  SubagentBatchVerification,
  SubagentResult,
  SubagentTaskAttempt,
  SubagentTaskVerification,
} from "./subagents/types";
import type {
  WorkflowArtifact,
  WorkflowCheckpoint,
  WorkflowManifest,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowScriptLog,
  WorkflowTraceEvent,
} from "./workflows/types";
import { stripContextAside } from "./context-aside";

/* SDK 事件的最小化类型（用 any-ish 但 narrow 到必要字段） */
interface AnyEvent {
  type: string;
  // message_*
  message?: {
    role: string;
    timestamp?: number;
    responseId?: string;
    provider?: string;
    model?: string;
    api?: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
      totalTokens?: number;
      cost?: number | { total?: number };
    };
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      data?: string;
      mimeType?: string;
    }>;
  };
  // message_update
  assistantMessageEvent?: {
    type: string;
    delta?: string;
    partial?: {
      responseId?: string;
      content?: Array<{
        type: string;
        text?: string;
        thinking?: string;
        data?: string;
        mimeType?: string;
      }>;
    };
  };
  // tool_execution_*
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  // approval_request (RFC-2 Phase B3 自定义事件)
  request?: {
    id: string;
    agentId?: string;
    requestId?: string;
    toolCallId?: string;
    toolName?: string;
    input?: Record<string, unknown>;
    ruleId?: string;
    title?: string;
    question?: string;
    context?: string;
    options?: ClarificationOption[];
    recommendedOptionId?: string;
    createdAt: number;
    // cowork clarification attribution
    originAgentId?: string;
    taskTitle?: string;
  };
  // approval_resolved (RFC-2 Phase B3 自定义事件)
  id?: string;
  decision?: "allow" | "deny";
  resolvedBy?: "user" | "timeout" | "default" | "abort";
  denyReason?: string;
  // clarification_request / clarification_resolved (RFC-5 自定义事件)
  selectedOptionId?: string;
  customText?: string;
  requestId?: string;
  // subagent_* (RFC-6 自定义事件)
  batch?: SubagentBatch;
  planning?: SubagentBatchPlan;
  batchId?: string;
  taskId?: string;
  title?: string;
  role?: string;
  status?: string;
  agentId?: string;
  answer?: string;
  answerPreview?: string;
  error?: string;
  sessionFile?: string;
  usage?: SubagentResult["usage"];
  attempts?: SubagentTaskAttempt[];
  verification?: SubagentTaskVerification | SubagentBatchVerification;
  synthesis?: SubagentBatchSynthesis;
  auditEvents?: SubagentAuditEvent[];
  startedAt?: number;
  endedAt?: number;
  results?: SubagentResult[];
  // workflow_* custom events
  run?: WorkflowRun;
  workflowId?: string;
  log?: WorkflowScriptLog;
  checkpoint?: WorkflowCheckpoint;
  artifact?: WorkflowArtifact;
  artifacts?: WorkflowArtifact[];
  checkpoints?: WorkflowCheckpoint[];
  logs?: WorkflowScriptLog[];
  trace?: WorkflowTraceEvent;
  traceEvents?: WorkflowTraceEvent[];
  returnValue?: unknown;
}

export interface ReducerState {
  messages: ChatMessage[];
  /** 当前正在生成的 assistant message 在 messages 里的 index；-1 表示无 */
  activeAssistantIndex: number;
  /** 当前 assistant message 的 responseId，用于兼容非标准 shim 的重复 delta */
  activeAssistantResponseId?: string;
  /** 非标准 shim 若已在 message_start 给文本，后续 text_delta 可能是在重放这段文本 */
  activeAssistantReplayText?: string;
  /** 已经吞掉的重放文本长度 */
  activeAssistantReplayOffset?: number;
  /** 已收尾 responseId，迟到的重复 delta 直接忽略 */
  completedAssistantResponseIds?: string[];
}

export function createInitialState(messages: ChatMessage[] = []): ReducerState {
  return { messages, activeAssistantIndex: -1 };
}

function ensureAssistant(state: ReducerState): {
  msg: ChatMessage;
  idx: number;
} {
  if (state.activeAssistantIndex >= 0) {
    const idx = state.activeAssistantIndex;
    return { msg: state.messages[idx], idx };
  }
  const msg: ChatMessage = { role: "assistant", parts: [] };
  state.messages.push(msg);
  state.activeAssistantIndex = state.messages.length - 1;
  return { msg, idx: state.activeAssistantIndex };
}

// 注意：reducer 必须是纯的，不能 in-place 改 part 对象。
// React 18+ StrictMode dev 会把 setState reducer 跑两次以检测副作用，
// 直接 `last.text += delta` 会让 delta 在每个 part 上累加两次（中文每字翻倍，英文每 chunk 翻倍）。
// 因此这里把 last part 替换成一个新对象。
function appendToLastTextPart(parts: MessagePart[], delta: string) {
  const last = parts[parts.length - 1];
  if (last && last.kind === "text") {
    parts[parts.length - 1] = { kind: "text", text: last.text + delta };
  } else {
    parts.push({ kind: "text", text: delta });
  }
}

function appendToLastThinkingPart(parts: MessagePart[], delta: string) {
  const last = parts[parts.length - 1];
  if (last && last.kind === "thinking") {
    parts[parts.length - 1] = { ...last, text: last.text + delta };
  } else {
    parts.push({ kind: "thinking", text: delta, startedAt: Date.now() });
  }
}

function partsFromContent(
  content?: Array<{
    type: string;
    text?: string;
    thinking?: string;
    data?: string;
    mimeType?: string;
  }>
): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const c of content ?? []) {
    if (c.type === "text" && c.text) parts.push({ kind: "text", text: c.text });
    else if (c.type === "thinking" && c.thinking)
      parts.push({ kind: "thinking", text: c.thinking });
    else if (c.type === "image" && c.data && c.mimeType)
      parts.push({ kind: "image", data: c.data, mimeType: c.mimeType });
  }
  return parts;
}

function textFromParts(parts: MessagePart[]) {
  return parts
    .filter((p): p is Extract<MessagePart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("");
}

function toNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function usageFromMessage(m?: AnyEvent["message"]): ChatMessageUsage | undefined {
  const u = m?.usage;
  if (!u) return undefined;
  const input = toNumber(u.input);
  const output = toNumber(u.output);
  const cacheRead = toNumber(u.cacheRead);
  const cacheWrite = toNumber(u.cacheWrite);
  const total =
    toNumber(u.totalTokens) ||
    toNumber(u.total) ||
    input + output + cacheRead + cacheWrite;
  const cost =
    typeof u.cost === "number" ? toNumber(u.cost) : toNumber(u.cost?.total);
  return { input, output, cacheRead, cacheWrite, total, cost };
}

function metaFromMessage(m?: AnyEvent["message"]): ChatMessageMeta | undefined {
  if (!m) return undefined;
  const usage = usageFromMessage(m);
  const meta: ChatMessageMeta = {
    provider: m.provider,
    model: m.model,
    api: m.api,
    responseId: m.responseId,
    usage,
  };
  return Object.values(meta).some((v) => v !== undefined) ? meta : undefined;
}

function assistantErrorText(message?: Pick<
  NonNullable<AnyEvent["message"]>,
  "stopReason" | "errorMessage"
>): string | null {
  if (!message || message.stopReason !== "error") return null;
  const raw = message.errorMessage?.trim();
  if (!raw) return "回复失败，请检查当前模型或凭证配置后重试。";
  if (raw.includes("authentication token has been invalidated")) {
    return "当前登录凭证已失效，请重新登录 ChatGPT Plus/Pro（Codex Subscription）或重新配置 Provider 凭证后再发送。";
  }
  return `回复失败：${raw}`;
}

function appendAssistantErrorFallback(
  parts: MessagePart[],
  message?: Pick<NonNullable<AnyEvent["message"]>, "stopReason" | "errorMessage">
): MessagePart[] {
  if (parts.some((p) => p.kind === "text" && p.text.trim().length > 0)) {
    return parts;
  }
  const text = assistantErrorText(message);
  return text ? [...parts, { kind: "text", text }] : parts;
}

function mergeMeta(
  prev: ChatMessageMeta | undefined,
  next: ChatMessageMeta | undefined
): ChatMessageMeta | undefined {
  if (!prev) return next;
  if (!next) return prev;
  return { ...prev, ...next, usage: next.usage ?? prev.usage };
}

function assistantIndexByResponseId(
  messages: ChatMessage[],
  responseId: string
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.meta?.responseId === responseId) return i;
  }
  return -1;
}

function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function assistantIndexInCurrentTurn(
  messages: ChatMessage[],
  responseId: string | undefined,
  parts: MessagePart[]
): number {
  const after = lastUserIndex(messages);
  const incomingText = textFromParts(parts);
  for (let i = messages.length - 1; i > after; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (responseId && m.meta?.responseId === responseId) return i;
    const existingText = textFromParts(m.parts ?? []);
    if (incomingText && existingText === incomingText) return i;
  }
  return -1;
}

/** thinking 段已经"翻篇"——出现 text 或 tool 时调用，给最后一个未结束的 thinking 打 endedAt */
function sealLastThinkingIfOpen(parts: MessagePart[]) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind !== "thinking") return;
    if (p.endedAt === undefined) {
      parts[i] = { ...p, endedAt: Date.now() };
    }
    return;
  }
}

function findToolPartIndex(parts: MessagePart[], toolCallId: string): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === "tool" && p.toolCallId === toolCallId) return i;
  }
  return -1;
}

function findApprovalPartIndex(parts: MessagePart[], id: string): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === "approval" && p.id === id) return i;
  }
  return -1;
}

function findClarificationPartIndex(
  parts: MessagePart[],
  id: string
): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === "clarification" && p.id === id) return i;
  }
  return -1;
}

function findSubagentBatchPartIndex(
  parts: MessagePart[],
  id: string
): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === "subagent_batch" && p.id === id) return i;
  }
  return -1;
}

function findWorkflowRunPartIndex(
  parts: MessagePart[],
  id: string
): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === "workflow_run" && p.id === id) return i;
  }
  return -1;
}

function previewSubagentAnswer(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 180 ? `${oneLine.slice(0, 177)}…` : oneLine;
}

function isSubagentStatus(status: unknown): status is SubagentResult["status"] {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "aborted" ||
    status === "timeout"
  );
}

function resultsByTaskId(results: SubagentResult[] | undefined) {
  const map = new Map<string, SubagentResult>();
  for (const result of results ?? []) map.set(result.taskId, result);
  return map;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asSubagentResults(value: unknown): SubagentResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SubagentResult[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec || typeof rec.taskId !== "string") continue;
    if (!isSubagentStatus(rec.status)) continue;
    out.push({
      taskId: rec.taskId,
      agentId: typeof rec.agentId === "string" ? rec.agentId : "",
      sessionFile:
        typeof rec.sessionFile === "string" ? rec.sessionFile : undefined,
      status: rec.status,
      answer: typeof rec.answer === "string" ? rec.answer : undefined,
      error: typeof rec.error === "string" ? rec.error : undefined,
      startedAt: typeof rec.startedAt === "number" ? rec.startedAt : Date.now(),
      endedAt: typeof rec.endedAt === "number" ? rec.endedAt : undefined,
      usage: asRecord(rec.usage) as SubagentResult["usage"],
    });
  }
  return out.length ? out : undefined;
}

function subagentRole(value: unknown) {
  return value === "general" ||
    value === "rag" ||
    value === "research" ||
    value === "code-review" ||
    value === "implementation"
    ? value
    : undefined;
}

function asSubagentSynthesis(value: unknown): SubagentBatchSynthesis | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  if (
    rec.status !== "ready" &&
    rec.status !== "partial" &&
    rec.status !== "blocked"
  ) {
    return undefined;
  }
  return {
    status: rec.status,
    generatedAt:
      typeof rec.generatedAt === "number" ? rec.generatedAt : Date.now(),
    summary: typeof rec.summary === "string" ? rec.summary : "",
    usableTaskIds: Array.isArray(rec.usableTaskIds)
      ? rec.usableTaskIds.filter((item): item is string => typeof item === "string")
      : [],
    cautionTaskIds: Array.isArray(rec.cautionTaskIds)
      ? rec.cautionTaskIds.filter((item): item is string => typeof item === "string")
      : [],
    rejectedTaskIds: Array.isArray(rec.rejectedTaskIds)
      ? rec.rejectedTaskIds.filter((item): item is string => typeof item === "string")
      : [],
    instructions:
      typeof rec.instructions === "string" ? rec.instructions : undefined,
  };
}

function asSubagentAuditEvents(value: unknown): SubagentAuditEvent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events = value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      type:
        typeof item.type === "string"
          ? (item.type as SubagentAuditEvent["type"])
          : "batch_completed",
      at: typeof item.at === "number" ? item.at : Date.now(),
      taskId: typeof item.taskId === "string" ? item.taskId : undefined,
      message: typeof item.message === "string" ? item.message : "",
      data:
        item.data && typeof item.data === "object" && !Array.isArray(item.data)
          ? (item.data as Record<string, unknown>)
          : undefined,
    }))
    .filter((item) => item.message.length > 0);
  return events.length > 0 ? events : undefined;
}

function subagentBatchPartFromToolResult(params: {
  toolCallId: string;
  args?: unknown;
  details?: unknown;
  result?: unknown;
}): Extract<MessagePart, { kind: "subagent_batch" }> | null {
  const details = asRecord(params.details) ?? asRecord(asRecord(params.result)?.details);
  const results = asSubagentResults(details?.results);
  const synthesis = asSubagentSynthesis(details?.synthesis);
  const auditEvents = asSubagentAuditEvents(details?.auditEvents);
  if (!results) return null;
  const args = asRecord(params.args);
  const inputTasks = Array.isArray(args?.tasks) ? args.tasks : [];
  const taskSources = inputTasks.length ? inputTasks : results;
  const resultMap = resultsByTaskId(results);
  const createdAt = results.reduce(
    (min, result) => Math.min(min, result.startedAt || min),
    results[0]?.startedAt ?? Date.now()
  );
  const endedAt = results.reduce(
    (max, result) => Math.max(max, result.endedAt ?? max),
    0
  );
  return {
    kind: "subagent_batch",
    id:
      typeof details?.batchId === "string"
        ? details.batchId
        : params.toolCallId,
    reason:
      typeof args?.reason === "string"
        ? args.reason
        : "Delegated subagent batch",
    status: results.some((result) => result.status === "completed")
      ? "completed"
      : "failed",
    synthesis,
    auditEvents,
    tasks: taskSources.map((raw, index) => {
      const task = asRecord(raw);
      const id =
        typeof task?.id === "string"
          ? task.id
          : results[index]?.taskId ?? `task-${index + 1}`;
      const result = resultMap.get(id) ?? results[index];
      return {
        id,
        title:
          typeof task?.title === "string"
            ? task.title
            : result?.taskId ?? `Task ${index + 1}`,
        role: subagentRole(task?.role),
        status: result?.status ?? "completed",
        agentId: result?.agentId,
        answer: result?.answer,
        answerPreview: previewSubagentAnswer(result?.answer),
        error: result?.error,
        sessionFile: result?.sessionFile,
        startedAt: result?.startedAt,
        endedAt: result?.endedAt,
        usage: result?.usage,
      };
    }),
    createdAt,
    endedAt: endedAt || undefined,
  };
}

function subagentBatchPartFromPersistedBatch(
  batch: SubagentBatch
): Extract<MessagePart, { kind: "subagent_batch" }> {
  return {
    kind: "subagent_batch",
    id: batch.id,
    reason: batch.reason,
    status: batch.status,
    restored: true,
    planning: batch.planning,
    verification: batch.verification,
    synthesis: batch.synthesis,
    auditEvents: batch.auditEvents,
    tasks: batch.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      role: task.role,
      status: task.status,
      agentId: task.agentId,
      answer: task.answer,
      answerPreview: task.answerPreview ?? previewSubagentAnswer(task.answer),
      error: task.error,
      sessionFile: task.sessionFile,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      usage: task.usage,
      verification: task.verification,
      attempts: task.attempts,
    })),
    createdAt: batch.createdAt,
    endedAt: batch.endedAt,
  };
}

export function appendRestoredSubagentBatches(
  messages: ChatMessage[],
  batches: SubagentBatch[] | undefined
): ChatMessage[] {
  if (!batches?.length) return messages;
  const existing = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.kind === "subagent_batch") existing.add(part.id);
    }
  }
  const restored = batches
    .filter((batch) => !existing.has(batch.id))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(subagentBatchPartFromPersistedBatch);
  if (restored.length === 0) return messages;
  return [
    ...messages,
    {
      role: "assistant",
      parts: restored,
      timestamp: restored[0]?.createdAt ?? Date.now(),
    },
  ];
}

function workflowStatus(value: unknown): WorkflowRunStatus | undefined {
  return value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "aborted"
    ? value
    : undefined;
}

function workflowRunPartFromToolResult(params: {
  toolCallId: string;
  args?: unknown;
  details?: unknown;
  result?: unknown;
}): Extract<MessagePart, { kind: "workflow_run" }> | null {
  const details = asRecord(params.details) ?? asRecord(asRecord(params.result)?.details);
  if (!details || typeof details.workflowId !== "string") return null;
  const args = asRecord(params.args);
  const artifacts = Array.isArray(details.artifacts)
    ? (details.artifacts as WorkflowArtifact[])
    : [];
  const checkpoints = Array.isArray(details.checkpoints)
    ? (details.checkpoints as WorkflowCheckpoint[])
    : [];
  const logs = Array.isArray(details.logs)
    ? (details.logs as WorkflowScriptLog[])
    : [];
  const manifest = asRecord(details.manifest) as WorkflowManifest | null;
  return {
    kind: "workflow_run",
    id: details.workflowId,
    objective:
      typeof details.objective === "string"
        ? details.objective
        : typeof args?.objective === "string"
          ? args.objective
          : "Dynamic workflow",
    rationale: typeof args?.rationale === "string" ? args.rationale : "",
    status: workflowStatus(details.status) ?? "completed",
    manifest: manifest ?? undefined,
    resumedFromWorkflowId:
      typeof details.resumedFromWorkflowId === "string"
        ? details.resumedFromWorkflowId
        : undefined,
    checkpoints,
    artifacts,
    logs,
    createdAt:
      typeof details.startedAt === "number" ? details.startedAt : Date.now(),
    endedAt: typeof details.endedAt === "number" ? details.endedAt : undefined,
    returnValue: details.returnValue,
    error: typeof details.error === "string" ? details.error : undefined,
  };
}

/**
 * 应用一个事件，返回**新的 state 引用**（messages 数组也是新引用，方便 React diff）。
 * 内部修改是 mutable 的，但出门前 clone 一层。
 */
export function applyEvent(prev: ReducerState, ev: AnyEvent): ReducerState {
  // 浅 clone：messages 是新引用，里面的 msg 对象在需要修改时也会替换
  const state: ReducerState = {
    messages: prev.messages.slice(),
    activeAssistantIndex: prev.activeAssistantIndex,
    activeAssistantResponseId: prev.activeAssistantResponseId,
    activeAssistantReplayText: prev.activeAssistantReplayText,
    activeAssistantReplayOffset: prev.activeAssistantReplayOffset,
    completedAssistantResponseIds: prev.completedAssistantResponseIds,
  };

  const replaceActive = (mutator: (m: ChatMessage) => ChatMessage) => {
    const { msg, idx } = ensureAssistant(state);
    state.messages[idx] = mutator(msg);
  };

  switch (ev.type) {
    case "message_start": {
      const m = ev.message;
      if (!m) return state;
      if (m.role === "user") {
        // 把 user message 拼成 parts（text + image 按顺序）。
        // text 部分要剥离「上下文 aside」标记，确保气泡只显示用户原话。
        const parts: MessagePart[] = [];
        let textJoined = "";
        for (const c of m.content ?? []) {
          if (c.type === "text" && c.text) {
            const visible = stripContextAside(c.text);
            if (visible) {
              parts.push({ kind: "text", text: visible });
              textJoined += visible;
            }
          } else if (c.type === "image" && c.data && c.mimeType) {
            parts.push({ kind: "image", data: c.data, mimeType: c.mimeType });
          }
        }
        state.messages.push({
          role: "user",
          parts,
          text: textJoined, // 兼容老字段
          timestamp: m.timestamp,
        });
        // user message 不算 active assistant
      } else if (m.role === "assistant") {
        const parts = partsFromContent(m.content);
        const nextMeta = metaFromMessage(m);
        const byResponseId = m.responseId
          ? assistantIndexByResponseId(state.messages, m.responseId)
          : -1;
        const existingIdx =
          byResponseId >= 0
            ? byResponseId
            : assistantIndexInCurrentTurn(state.messages, m.responseId, parts);
        if (existingIdx >= 0) {
          const existing = state.messages[existingIdx];
          const existingParts = existing.parts ?? [];
          state.messages[existingIdx] = {
            ...existing,
            parts:
              existingParts.length === 0 && parts.length > 0
                ? parts
                : existingParts,
            timestamp: existing.timestamp ?? m.timestamp,
            meta: mergeMeta(existing.meta, nextMeta),
          };
          state.activeAssistantIndex = existingIdx;
          state.activeAssistantResponseId =
            m.responseId ?? existing.meta?.responseId;
          const initialText = textFromParts(
            state.messages[existingIdx].parts ?? []
          );
          state.activeAssistantReplayText = initialText || undefined;
          state.activeAssistantReplayOffset = initialText ? 0 : undefined;
          return state;
        }
        // 起一个新的 active assistant 占位
        state.messages.push({
          role: "assistant",
          parts,
          timestamp: m.timestamp,
          meta: nextMeta,
        });
        state.activeAssistantIndex = state.messages.length - 1;
        state.activeAssistantResponseId = m.responseId;
        const initialText = textFromParts(parts);
        state.activeAssistantReplayText = initialText || undefined;
        state.activeAssistantReplayOffset = initialText ? 0 : undefined;
      } else if (m.role === "tool") {
        // tool result 类的 message，一般已经在 tool_execution_end 里处理过，跳过
      }
      return state;
    }

    case "message_update": {
      const sub = ev.assistantMessageEvent;
      if (!sub) return state;
      const responseId = sub.partial?.responseId ?? ev.message?.responseId;
      if (
        responseId &&
        state.activeAssistantIndex < 0 &&
        state.completedAssistantResponseIds?.includes(responseId)
      ) {
        return state;
      }
      replaceActive((msg) => {
        const parts = (msg.parts ?? []).slice();
        const nextMeta = mergeMeta(
          msg.meta,
          metaFromMessage(ev.message) ?? (responseId ? { responseId } : undefined)
        );
        if (sub.type === "text_delta" && sub.delta) {
          if (state.activeAssistantReplayText) {
            const offset = state.activeAssistantReplayOffset ?? 0;
            const replayText = state.activeAssistantReplayText;
            const replayChunk = replayText.slice(offset, offset + sub.delta.length);
            if (replayChunk === sub.delta) {
              state.activeAssistantReplayOffset = offset + sub.delta.length;
              if (state.activeAssistantReplayOffset >= replayText.length) {
                state.activeAssistantReplayText = undefined;
                state.activeAssistantReplayOffset = undefined;
              }
              return { ...msg, meta: nextMeta };
            }
            const remainingReplay = replayText.slice(offset);
            if (remainingReplay && sub.delta.startsWith(remainingReplay)) {
              state.activeAssistantReplayText = undefined;
              state.activeAssistantReplayOffset = undefined;
              const suffix = sub.delta.slice(remainingReplay.length);
              if (!suffix) return { ...msg, meta: nextMeta };
              sealLastThinkingIfOpen(parts);
              appendToLastTextPart(parts, suffix);
              return { ...msg, parts, meta: nextMeta };
            }
            state.activeAssistantReplayText = undefined;
            state.activeAssistantReplayOffset = undefined;
          }
          const currentText = textFromParts(parts);
          if (currentText === sub.delta) {
            return { ...msg, meta: nextMeta };
          }
          if (
            responseId &&
            responseId === state.activeAssistantResponseId &&
            currentText === sub.delta
          ) {
            return msg;
          }
          sealLastThinkingIfOpen(parts);
          appendToLastTextPart(parts, sub.delta);
        } else if (sub.type === "thinking_delta" && sub.delta) {
          state.activeAssistantReplayText = undefined;
          state.activeAssistantReplayOffset = undefined;
          appendToLastThinkingPart(parts, sub.delta);
        }
        return { ...msg, parts, meta: nextMeta };
      });
      return state;
    }

    case "message_end": {
      // assistant 这一轮结束；用 message.content 兜底（保证最终态准确）
      const m = ev.message;
      if (m && m.role === "assistant" && state.activeAssistantIndex >= 0) {
        const cur = state.messages[state.activeAssistantIndex];
        const finalTs = m.timestamp ?? cur.timestamp;
        let parts: MessagePart[];
        if (!cur.parts || cur.parts.length === 0) {
          // 兜底：deltas 没累积到 parts，从 message.content 重建
          parts = partsFromContent(m.content);
        } else {
          parts = cur.parts.slice();
        }
        parts = appendAssistantErrorFallback(parts, m);
        // 不管哪种来源，最后一个未结束的 thinking 在结束时间打个 endedAt
        sealLastThinkingIfOpen(parts);
        state.messages[state.activeAssistantIndex] = {
          ...cur,
          parts,
          timestamp: finalTs,
          meta: mergeMeta(cur.meta, metaFromMessage(m)),
        };
      }
      const responseId = m?.responseId ?? state.activeAssistantResponseId;
      if (responseId) {
        state.completedAssistantResponseIds = [
          responseId,
          ...(state.completedAssistantResponseIds ?? []).filter(
            (id) => id !== responseId
          ),
        ].slice(0, 20);
      }
      state.activeAssistantIndex = -1;
      state.activeAssistantResponseId = undefined;
      state.activeAssistantReplayText = undefined;
      state.activeAssistantReplayOffset = undefined;
      return state;
    }

    case "tool_execution_start": {
      if (!ev.toolCallId || !ev.toolName) return state;
      replaceActive((msg) => {
        const parts = (msg.parts ?? []).slice();
        sealLastThinkingIfOpen(parts);
        parts.push({
          kind: "tool",
          toolCallId: ev.toolCallId!,
          toolName: ev.toolName!,
          args: ev.args,
          status: "running",
        });
        return { ...msg, parts };
      });
      return state;
    }

    case "tool_execution_update": {
      if (!ev.toolCallId) return state;
      replaceActive((msg) => {
        const parts = (msg.parts ?? []).slice();
        const idx = findToolPartIndex(parts, ev.toolCallId!);
        if (idx >= 0) {
          const tp = parts[idx] as Extract<MessagePart, { kind: "tool" }>;
          parts[idx] = {
            ...tp,
            partialResult: ev.partialResult ?? tp.partialResult,
          };
        }
        return { ...msg, parts };
      });
      return state;
    }

    // ===== RFC-2 Phase B3：审批气泡 =====
    // 时序：approval_request 一定先于 tool_execution_start（审批通过后 SDK 才执行 tool）。
    // 所以这里 push approval part 时，active assistant 已经在了（agent_start 后 message_start 已建）。
    // 但保险起见：找不到 active assistant 时 ensureAssistant 兜底新建空壳。
    case "approval_request": {
      const r = ev.request;
      if (!r) return state;
      if (!r.toolCallId || !r.toolName || !r.input) return state;
      const toolCallId = r.toolCallId;
      const toolName = r.toolName;
      const input = r.input;
      replaceActive((msg) => {
        const parts = (msg.parts ?? []).slice();
        // 防御：同 id 重复 push（不应发生）→ 跳过
        if (findApprovalPartIndex(parts, r.id) >= 0) return msg;
        sealLastThinkingIfOpen(parts);
        parts.push({
          kind: "approval",
          id: r.id,
          toolCallId,
          toolName,
          input,
          ruleId: r.ruleId,
          status: "pending",
          createdAt: r.createdAt,
        });
        return { ...msg, parts };
      });
      return state;
    }

    case "approval_resolved": {
      const id = ev.id;
      if (!id || !ev.decision) return state;
      const resolvedBy =
        ev.resolvedBy === "user" ||
        ev.resolvedBy === "timeout" ||
        ev.resolvedBy === "default"
          ? ev.resolvedBy
          : undefined;
      // 不用 ensureAssistant：approval part 必然挂在某个已存在的 assistant message 上；
      // 而且 resolved 时可能 active 已经 closed（message_end 跑过了），找不到不 push 新 active。
      // 遍历倒序找最近一条带该 approval id 的 assistant message。
      for (let mi = state.messages.length - 1; mi >= 0; mi--) {
        const m = state.messages[mi];
        if (m.role !== "assistant" || !m.parts) continue;
        const pi = findApprovalPartIndex(m.parts, id);
        if (pi < 0) continue;
        const parts = m.parts.slice();
        const cur = parts[pi];
        if (cur.kind !== "approval") break; // 类型守卫，不会发生
        parts[pi] = {
          ...cur,
          status: ev.decision === "allow" ? "allowed" : "denied",
          resolvedBy,
          denyReason: ev.denyReason,
        };
        state.messages[mi] = { ...m, parts };
        break;
      }
      return state;
    }

    // ===== RFC-5：Agent 主动追问 / 推荐下一步 =====
    case "clarification_request": {
      const r = ev.request;
      if (!r) return state;
      if (!r.requestId || !r.title || !r.question || !r.options) return state;
      const requestId = r.requestId;
      const title = r.title;
      const question = r.question;
      const options = r.options;
      replaceActive((msg) => {
        const parts = (msg.parts ?? []).slice();
        if (findClarificationPartIndex(parts, r.id) >= 0) return msg;
        sealLastThinkingIfOpen(parts);
        parts.push({
          kind: "clarification",
          id: r.id,
          requestId,
          title,
          question,
          context: r.context,
          options,
          recommendedOptionId: r.recommendedOptionId,
          status: "pending",
          createdAt: r.createdAt,
          originAgentId: r.originAgentId,
          taskTitle: r.taskTitle,
        });
        return { ...msg, parts };
      });
      return state;
    }

    case "clarification_resolved": {
      const id = ev.id;
      if (!id) return state;
      for (let mi = state.messages.length - 1; mi >= 0; mi--) {
        const m = state.messages[mi];
        if (m.role !== "assistant" || !m.parts) continue;
        const pi = findClarificationPartIndex(m.parts, id);
        if (pi < 0) continue;
        const parts = m.parts.slice();
        const cur = parts[pi];
        if (cur.kind !== "clarification") break;
        parts[pi] = {
          ...cur,
          status: "resolved",
          selectedOptionId: ev.selectedOptionId,
          customText: ev.customText,
          resolvedBy:
            ev.resolvedBy === "abort" || ev.resolvedBy === "user"
              ? ev.resolvedBy
              : "user",
        };
        state.messages[mi] = { ...m, parts };
        break;
      }
      return state;
    }

    // ===== RFC-6：Multi-subagent 协作状态卡 =====
    case "subagent_batch_start": {
      const batch = ev.batch;
      if (!batch) return state;
      replaceActive((msg) => {
        const parts = (msg.parts ?? []).slice();
        if (findSubagentBatchPartIndex(parts, batch.id) >= 0) return msg;
        sealLastThinkingIfOpen(parts);
        parts.push({
          kind: "subagent_batch",
          id: batch.id,
          reason: batch.reason,
          status: batch.status,
          planning: batch.planning,
          verification: batch.verification,
          synthesis: batch.synthesis,
          auditEvents: batch.auditEvents,
          tasks: batch.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            role: task.role,
            status: task.status,
            agentId: task.agentId,
            answer: task.answer,
            answerPreview: task.answerPreview,
            error: task.error,
            sessionFile: task.sessionFile,
            startedAt: task.startedAt,
            endedAt: task.endedAt,
            usage: task.usage,
            verification: task.verification,
            attempts: task.attempts,
          })),
          createdAt: batch.createdAt,
          endedAt: batch.endedAt,
        });
        return { ...msg, parts };
      });
      return state;
    }

    case "subagent_task_start":
    case "subagent_task_update":
    case "subagent_task_end": {
      const batchId = ev.batchId;
      const taskId = ev.taskId;
      if (!batchId || !taskId) return state;
      for (let mi = state.messages.length - 1; mi >= 0; mi--) {
        const m = state.messages[mi];
        if (m.role !== "assistant" || !m.parts) continue;
        const pi = findSubagentBatchPartIndex(m.parts, batchId);
        if (pi < 0) continue;
        const parts = m.parts.slice();
        const cur = parts[pi];
        if (cur.kind !== "subagent_batch") break;
        parts[pi] = {
          ...cur,
          tasks: cur.tasks.map((task) => {
            if (task.id !== taskId) return task;
            return {
              ...task,
              title: ev.title ?? task.title,
              role:
                ev.role === "general" ||
                ev.role === "rag" ||
                ev.role === "research" ||
                ev.role === "code-review" ||
                ev.role === "implementation"
                  ? ev.role
                  : task.role,
              status:
                ev.status === "completed" ||
                ev.status === "failed" ||
                ev.status === "aborted" ||
                ev.status === "timeout"
                  ? ev.status
                  : ev.type === "subagent_task_start"
                  ? "running"
                  : task.status,
              agentId: ev.agentId ?? task.agentId,
              answer:
                ev.type === "subagent_task_start"
                  ? undefined
                  : ev.answer ?? task.answer,
              answerPreview:
                ev.type === "subagent_task_start"
                  ? undefined
                  : ev.answerPreview ?? task.answerPreview,
              error:
                ev.type === "subagent_task_start"
                  ? undefined
                  : ev.error ?? task.error,
              sessionFile:
                ev.type === "subagent_task_start"
                  ? undefined
                  : ev.sessionFile ?? task.sessionFile,
              startedAt: ev.startedAt ?? task.startedAt,
              endedAt:
                ev.type === "subagent_task_start"
                  ? undefined
                  : ev.endedAt ?? task.endedAt,
              usage:
                ev.type === "subagent_task_start"
                  ? undefined
                  : ev.usage ?? task.usage,
              verification:
                ev.type === "subagent_task_start"
                  ? undefined
                  : (ev.verification as SubagentTaskVerification | undefined) ??
                    task.verification,
              attempts: ev.attempts ?? task.attempts,
            };
          }),
        };
        state.messages[mi] = { ...m, parts };
        break;
      }
      return state;
    }

    case "subagent_batch_end": {
      const batchId = ev.batchId;
      if (!batchId) return state;
      for (let mi = state.messages.length - 1; mi >= 0; mi--) {
        const m = state.messages[mi];
        if (m.role !== "assistant" || !m.parts) continue;
        const pi = findSubagentBatchPartIndex(m.parts, batchId);
        if (pi < 0) continue;
        const parts = m.parts.slice();
        const cur = parts[pi];
        if (cur.kind !== "subagent_batch") break;
        const results = resultsByTaskId(ev.results);
        parts[pi] = {
          ...cur,
          status:
            ev.status === "completed" ||
            ev.status === "failed" ||
            ev.status === "aborted"
              ? ev.status
              : cur.status,
          verification:
            (ev.verification as SubagentBatchVerification | undefined) ??
            cur.verification,
          synthesis: ev.synthesis ?? cur.synthesis,
          auditEvents: ev.auditEvents ?? cur.auditEvents,
          tasks: cur.tasks.map((task) => {
            const result = results.get(task.id);
            if (!result) return task;
            return {
              ...task,
              status: isSubagentStatus(result.status) ? result.status : task.status,
              agentId: result.agentId || task.agentId,
              answer: result.answer ?? task.answer,
              answerPreview:
                previewSubagentAnswer(result.answer) ?? task.answerPreview,
              error: result.error ?? task.error,
              sessionFile: result.sessionFile ?? task.sessionFile,
              startedAt: result.startedAt ?? task.startedAt,
              endedAt: result.endedAt ?? task.endedAt,
              usage: result.usage ?? task.usage,
            };
          }),
          endedAt: ev.endedAt,
        };
        state.messages[mi] = { ...m, parts };
        break;
      }
      return state;
    }

    // ===== Dynamic workflow script harness 状态卡 =====
    case "workflow_start": {
      const run = ev.run;
      if (!run) return state;
      replaceActive((msg) => {
        const parts = (msg.parts ?? []).slice();
        if (findWorkflowRunPartIndex(parts, run.id) >= 0) return msg;
        sealLastThinkingIfOpen(parts);
        parts.push({
          kind: "workflow_run",
          id: run.id,
          objective: run.objective,
          rationale: run.rationale,
          status: run.status,
          manifest: run.manifest,
          resumedFromWorkflowId: run.resumedFromWorkflowId,
          checkpoints: run.checkpoints,
          artifacts: run.artifacts,
          logs: run.logs,
          traceEvents: run.traceEvents ?? [],
          createdAt: run.createdAt,
          endedAt: run.endedAt,
          returnValue: run.returnValue,
          error: run.error,
        });
        return { ...msg, parts };
      });
      return state;
    }

    case "workflow_log":
    case "workflow_checkpoint":
    case "workflow_artifact":
    case "workflow_trace": {
      const workflowId = ev.workflowId;
      if (!workflowId) return state;
      for (let mi = state.messages.length - 1; mi >= 0; mi--) {
        const m = state.messages[mi];
        if (m.role !== "assistant" || !m.parts) continue;
        const pi = findWorkflowRunPartIndex(m.parts, workflowId);
        if (pi < 0) continue;
        const parts = m.parts.slice();
        const cur = parts[pi];
        if (cur.kind !== "workflow_run") break;
        parts[pi] = {
          ...cur,
          logs: ev.log ? [...cur.logs, ev.log] : cur.logs,
          checkpoints: ev.checkpoint
            ? [...cur.checkpoints, ev.checkpoint]
            : cur.checkpoints,
          artifacts: ev.artifact
            ? [
                ...cur.artifacts.filter(
                  (artifact) => artifact.name !== ev.artifact?.name
                ),
                ev.artifact,
              ]
            : cur.artifacts,
          traceEvents: ev.trace
            ? [...(cur.traceEvents ?? []), ev.trace]
            : cur.traceEvents,
        };
        state.messages[mi] = { ...m, parts };
        break;
      }
      return state;
    }

    case "workflow_end": {
      const workflowId = ev.workflowId;
      if (!workflowId) return state;
      for (let mi = state.messages.length - 1; mi >= 0; mi--) {
        const m = state.messages[mi];
        if (m.role !== "assistant" || !m.parts) continue;
        const pi = findWorkflowRunPartIndex(m.parts, workflowId);
        if (pi < 0) continue;
        const parts = m.parts.slice();
        const cur = parts[pi];
        if (cur.kind !== "workflow_run") break;
        parts[pi] = {
          ...cur,
          status: workflowStatus(ev.status) ?? cur.status,
          endedAt: ev.endedAt,
          artifacts: ev.artifacts ?? cur.artifacts,
          checkpoints: ev.checkpoints ?? cur.checkpoints,
          logs: ev.logs ?? cur.logs,
          traceEvents: ev.traceEvents ?? cur.traceEvents,
          returnValue: ev.returnValue,
          error: ev.error,
        };
        state.messages[mi] = { ...m, parts };
        break;
      }
      return state;
    }

    case "tool_execution_end": {
      if (!ev.toolCallId) return state;
      replaceActive((msg) => {
        const parts = (msg.parts ?? []).slice();
        const idx = findToolPartIndex(parts, ev.toolCallId!);
        if (idx >= 0) {
          const tp = parts[idx] as Extract<MessagePart, { kind: "tool" }>;
          parts[idx] = {
            ...tp,
            result: ev.result,
            isError: ev.isError ?? false,
            status: ev.isError ? "error" : "done",
          };
        }
        return { ...msg, parts };
      });
      return state;
    }

    default:
      return state;
  }
}

/** 把 session context API 返回的 message 数组转成 ChatMessage[]（parts 模型） */
export function ctxToMessages(
  ctxMessages: Array<{
    role: string;
    timestamp?: number;
    responseId?: string;
    provider?: string;
    model?: string;
    api?: string;
    stopReason?: string;
    errorMessage?: string;
    usage?: NonNullable<AnyEvent["message"]>["usage"];
    toolCallId?: string;
    toolName?: string;
    details?: unknown;
    isError?: boolean;
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      // tool_use / tool_result 等
      id?: string;
      name?: string;
      input?: unknown;
      arguments?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
      details?: unknown;
      // image
      data?: string;
      mimeType?: string;
    }>;
  }>
): ChatMessage[] {
  const out: ChatMessage[] = [];
  // 把 tool_result 按 tool_use_id 索引，到 assistant 遇到 tool_use 时回填
  const toolResults = new Map<
    string,
    { result: unknown; isError: boolean; details?: unknown; toolName?: string }
  >();
  for (const m of ctxMessages) {
    if (m.role === "toolResult" && m.toolCallId) {
      toolResults.set(m.toolCallId, {
        result: m.content,
        isError: !!m.isError,
        details: m.details,
        toolName: m.toolName,
      });
    }
    if (m.role === "tool") {
      for (const c of m.content ?? []) {
        if (c.type === "tool_result" && c.tool_use_id) {
          toolResults.set(c.tool_use_id, {
            result: c.content,
            isError: !!c.is_error,
            details: c.details,
          });
        }
      }
    }
  }

  for (const m of ctxMessages) {
    if (m.role === "user") {
      const parts: MessagePart[] = [];
      let textJoined = "";
      for (const c of m.content ?? []) {
        if (c.type === "text" && c.text) {
          // 历史还原同样剥离「上下文 aside」标记，只显示用户原话。
          const visible = stripContextAside(c.text);
          if (visible) {
            parts.push({ kind: "text", text: visible });
            textJoined += visible;
          }
        } else if (c.type === "image" && c.data && c.mimeType) {
          parts.push({ kind: "image", data: c.data, mimeType: c.mimeType });
        }
      }
      out.push({
        role: "user",
        parts,
        text: textJoined,
        timestamp: m.timestamp,
      });
    } else if (m.role === "assistant") {
      const parts: MessagePart[] = [];
      for (const c of m.content ?? []) {
        if (c.type === "text" && c.text) {
          parts.push({ kind: "text", text: c.text });
        } else if (c.type === "thinking" && c.thinking) {
          parts.push({ kind: "thinking", text: c.thinking });
        } else if (c.type === "image" && c.data && c.mimeType) {
          parts.push({ kind: "image", data: c.data, mimeType: c.mimeType });
        } else if (
          (c.type === "tool_use" || c.type === "toolCall") &&
          c.id &&
          c.name
        ) {
          const tr = toolResults.get(c.id);
          const args = c.input ?? c.arguments;
          parts.push({
            kind: "tool",
            toolCallId: c.id,
            toolName: c.name,
            args,
            result: tr?.result,
            isError: tr?.isError ?? false,
            status: tr ? (tr.isError ? "error" : "done") : "running",
          });
          if (c.name === "delegate_subagents" && tr) {
            const subagentPart = subagentBatchPartFromToolResult({
              toolCallId: c.id,
              args,
              details: tr.details,
              result: tr.result,
            });
            if (subagentPart) parts.push(subagentPart);
          } else if (c.name === "run_workflow_script" && tr) {
            const workflowPart = workflowRunPartFromToolResult({
              toolCallId: c.id,
              args,
              details: tr.details,
              result: tr.result,
            });
            if (workflowPart) parts.push(workflowPart);
          }
        }
      }
      const finalParts = appendAssistantErrorFallback(parts, m);
      out.push({
        role: "assistant",
        parts: finalParts,
        timestamp: m.timestamp,
        meta: metaFromMessage({ ...m, role: "assistant" }),
      });
    }
    // 跳过 role=tool 的独立 message，它们已经被合并到 assistant 的 tool part 里
  }
  return out;
}

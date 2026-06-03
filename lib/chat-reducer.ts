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
        // 把 user message 拼成 parts（text + image 按顺序）
        const parts: MessagePart[] = [];
        let textJoined = "";
        for (const c of m.content ?? []) {
          if (c.type === "text" && c.text) {
            parts.push({ kind: "text", text: c.text });
            textJoined += c.text;
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
          const isSameResponse =
            !responseId || responseId === state.activeAssistantResponseId;
          if (state.activeAssistantReplayText && isSameResponse) {
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
          if (
            responseId &&
            responseId === state.activeAssistantResponseId &&
            textFromParts(parts) === sub.delta
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
    usage?: NonNullable<AnyEvent["message"]>["usage"];
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
      // tool_use / tool_result 等
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
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
    { result: unknown; isError: boolean }
  >();
  for (const m of ctxMessages) {
    if (m.role === "tool") {
      for (const c of m.content ?? []) {
        if (c.type === "tool_result" && c.tool_use_id) {
          toolResults.set(c.tool_use_id, {
            result: c.content,
            isError: !!c.is_error,
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
          parts.push({ kind: "text", text: c.text });
          textJoined += c.text;
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
        } else if (c.type === "tool_use" && c.id && c.name) {
          const tr = toolResults.get(c.id);
          parts.push({
            kind: "tool",
            toolCallId: c.id,
            toolName: c.name,
            args: c.input,
            result: tr?.result,
            isError: tr?.isError ?? false,
            status: tr ? (tr.isError ? "error" : "done") : "running",
          });
        }
      }
      out.push({
        role: "assistant",
        parts,
        timestamp: m.timestamp,
        meta: metaFromMessage({ ...m, role: "assistant" }),
      });
    }
    // 跳过 role=tool 的独立 message，它们已经被合并到 assistant 的 tool part 里
  }
  return out;
}

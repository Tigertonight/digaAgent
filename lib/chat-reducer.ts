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
import type { ChatMessage, MessagePart } from "./types";

/* SDK 事件的最小化类型（用 any-ish 但 narrow 到必要字段） */
interface AnyEvent {
  type: string;
  // message_*
  message?: {
    role: string;
    timestamp?: number;
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
  };
  // tool_execution_*
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface ReducerState {
  messages: ChatMessage[];
  /** 当前正在生成的 assistant message 在 messages 里的 index；-1 表示无 */
  activeAssistantIndex: number;
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

/**
 * 应用一个事件，返回**新的 state 引用**（messages 数组也是新引用，方便 React diff）。
 * 内部修改是 mutable 的，但出门前 clone 一层。
 */
export function applyEvent(prev: ReducerState, ev: AnyEvent): ReducerState {
  // 浅 clone：messages 是新引用，里面的 msg 对象在需要修改时也会替换
  const state: ReducerState = {
    messages: prev.messages.slice(),
    activeAssistantIndex: prev.activeAssistantIndex,
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
        // 起一个新的 active assistant 占位
        state.messages.push({
          role: "assistant",
          parts: [],
          timestamp: m.timestamp,
        });
        state.activeAssistantIndex = state.messages.length - 1;
      } else if (m.role === "tool") {
        // tool result 类的 message，一般已经在 tool_execution_end 里处理过，跳过
      }
      return state;
    }

    case "message_update": {
      const sub = ev.assistantMessageEvent;
      if (!sub) return state;
      replaceActive((msg) => {
        const parts = (msg.parts ?? []).slice();
        if (sub.type === "text_delta" && sub.delta) {
          sealLastThinkingIfOpen(parts);
          appendToLastTextPart(parts, sub.delta);
        } else if (sub.type === "thinking_delta" && sub.delta) {
          appendToLastThinkingPart(parts, sub.delta);
        }
        return { ...msg, parts };
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
          parts = [];
          for (const c of m.content ?? []) {
            if (c.type === "text" && c.text)
              parts.push({ kind: "text", text: c.text });
            else if (c.type === "thinking" && c.thinking)
              parts.push({ kind: "thinking", text: c.thinking });
            else if (c.type === "image" && c.data && c.mimeType)
              parts.push({ kind: "image", data: c.data, mimeType: c.mimeType });
          }
        } else {
          parts = cur.parts.slice();
        }
        // 不管哪种来源，最后一个未结束的 thinking 在结束时间打个 endedAt
        sealLastThinkingIfOpen(parts);
        state.messages[state.activeAssistantIndex] = {
          ...cur,
          parts,
          timestamp: finalTs,
        };
      }
      state.activeAssistantIndex = -1;
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
      out.push({ role: "assistant", parts, timestamp: m.timestamp });
    }
    // 跳过 role=tool 的独立 message，它们已经被合并到 assistant 的 tool part 里
  }
  return out;
}

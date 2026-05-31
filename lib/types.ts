/** 给 client 用的共享类型 */

export interface SessionInfoLite {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  /** SDK forkFrom 写入的 parent session 文件路径；用于左侧分组 */
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  /** 服务端检测到这个 session 当前有 active AgentSession 进程在跑 */
  isRunning?: boolean;
}

/** SDK 的 thinking level */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** thinking level 的中文 label（对齐 pi-web 文案） */
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "最少",
  low: "低",
  medium: "中等",
  high: "高",
  xhigh: "最高",
};

/**
 * 新的消息 parts 结构 —— 对齐 pi-web 的渲染模型。
 * 一个 assistant message 是 text/thinking/tool 块的有序序列。
 */
export type MessagePart =
  | { kind: "text"; text: string }
  | {
      kind: "thinking";
      text: string;
      /** 首次 thinking_delta 到来时记的墙钟时间（ms）；只对实时流式有效 */
      startedAt?: number;
      /** 离开 thinking（出现 text/tool）时记的墙钟时间（ms） */
      endedAt?: number;
    }
  | {
      kind: "image";
      /** base64（不含 data:...; 前缀） */
      data: string;
      mimeType: string;
    }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      /** 流式中间结果 */
      partialResult?: unknown;
      /** 终态 */
      result?: unknown;
      isError?: boolean;
      /** 进行中 / 完成 / 出错 */
      status: "running" | "done" | "error";
    };

/** SDK ImageContent 形态 —— 给 /api/agent/[id] 发图用 */
export interface ImageContentLite {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system";
  /** 新模型：有序 parts 块；老字段 thinking/text 仍为兼容保留 */
  parts?: MessagePart[];
  /** @deprecated 使用 parts */
  thinking?: string;
  /** @deprecated 使用 parts */
  text?: string;
  /** 暂未渲染的原始 payload */
  raw?: unknown;
  /**
   * 仅 user message 用：对应 SDK 里可作为 navigateTree target 的 entryId。
   * 由前端在渲染前根据 getUserMessagesForForking() 顺序回填。
   */
  entryId?: string;
  /** SDK AgentMessage.timestamp（ms epoch）；流式时由 message_start/end 写入，恢复时由 ctxToMessages 写入 */
  timestamp?: number;
}

/** SDK getUserMessagesForForking() 返回的条目 */
export interface ForkableUserMessage {
  entryId: string;
  text: string;
}

export interface ProviderModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

export interface ProviderInfo {
  provider: string;
  displayName: string;
  hasAuth: boolean;
  authSource?: string;
  authLabel?: string;
  models: ProviderModelInfo[];
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  total: number;
  authedCount: number;
  defaultProvider?: string;
  defaultModelId?: string;
  loadError?: string;
}

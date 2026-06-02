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
    }
  | {
      /**
       * 工具审批气泡（RFC-2 Phase B3）。
       *
       * 时序：先于同 toolCallId 的 tool part 出现——审批通过后 SDK 才真执行 tool，
       * tool_execution_start 才到达，那时再 push 一个 kind:"tool" part。
       * 因此一次危险命令在最终 parts 里是 [approval(resolved), tool(running→done)] 两段。
       */
      kind: "approval";
      /** ApprovalRequest.id —— `${agentId}:${toolCallId}` */
      id: string;
      /** 与未来 tool part 关联用 */
      toolCallId: string;
      toolName: string;
      /** input 快照（展示给用户判断要不要 allow） */
      input: Record<string, unknown>;
      /** 触发规则的 id（用户判断"为什么被拦截"） */
      ruleId?: string;
      /** "pending" 等用户；"allowed" / "denied" 已结算（可能 user 也可能 timeout） */
      status: "pending" | "allowed" | "denied";
      /** 由谁结算的（"user"/"timeout"），仅 status !== pending 时有意义 */
      resolvedBy?: "user" | "timeout" | "default";
      /** deny 时的人话原因（如果有） */
      denyReason?: string;
      /** 创建时间（ms epoch），UI 计倒计时用 */
      createdAt: number;
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

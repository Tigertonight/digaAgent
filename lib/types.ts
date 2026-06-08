/** 给 client 用的共享类型 */

import type { SessionMeta } from "./meta/types";
import type { ClarificationOption } from "./clarification/types";
import type {
  SubagentAuditEvent,
  SubagentBatchStatus,
  SubagentBatchSynthesis,
  SubagentBatchPlan,
  SubagentBatchVerification,
  SubagentRole,
  SubagentTaskStatus,
  SubagentTaskVerification,
} from "./subagents/types";
import type {
  WorkflowArtifact,
  WorkflowCheckpoint,
  WorkflowManifest,
  WorkflowRunStatus,
  WorkflowScriptLog,
  WorkflowTraceEvent,
} from "./workflows/types";

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
  /**
   * RFC-3 Phase A：mini-pi-web 自维护的元数据（title / pinned / ...）。
   * 没有 meta 文件时缺省 undefined；UI 自己做 fallback。
   */
  meta?: SessionMeta;
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
    }
  | {
      /**
       * Agent 主动追问 / 下一步建议卡片（RFC-5）。
       *
       * 与 approval 不同：这里不是授权某个工具，而是让用户在多个可行路径中
       * 选择一个，或输入自定义补充，agent 再按该选择继续。
       */
      kind: "clarification";
      id: string;
      requestId: string;
      title: string;
      question: string;
      context?: string;
      options: ClarificationOption[];
      recommendedOptionId?: string;
      status: "pending" | "resolved";
      selectedOptionId?: string;
      customText?: string;
      resolvedBy?: "user" | "abort";
      createdAt: number;
      /**
       * Cowork: when this clarification was raised by a child subagent and
       * surfaced on the parent channel, these tag which task it came from.
       */
      originAgentId?: string;
      taskTitle?: string;
    }
  | {
      /**
       * Multi-subagent 协作状态卡（RFC-6）。
       *
       * 只展示 parent agent 汇总过来的 batch/task 状态；child agent 的完整
       * message stream 不进入主聊天，避免多个流互相打架。
       */
      kind: "subagent_batch";
      id: string;
      reason: string;
      status: SubagentBatchStatus;
      restored?: boolean;
      planning?: SubagentBatchPlan;
      verification?: SubagentBatchVerification;
      synthesis?: SubagentBatchSynthesis;
      auditEvents?: SubagentAuditEvent[];
      tasks: Array<{
        id: string;
        title: string;
        role?: SubagentRole;
        status: SubagentTaskStatus;
        agentId?: string;
        answer?: string;
        answerPreview?: string;
        error?: string;
        sessionFile?: string;
        startedAt?: number;
        endedAt?: number;
        usage?: {
          turns?: number;
          costUsd?: number;
          inputTokens?: number;
          outputTokens?: number;
        };
        verification?: SubagentTaskVerification;
        attempts?: Array<{
          attempt: number;
          agentId?: string;
          status: "completed" | "failed" | "aborted" | "timeout";
          answer?: string;
          answerPreview?: string;
          error?: string;
          sessionFile?: string;
          startedAt?: number;
          endedAt?: number;
          usage?: {
            turns?: number;
            costUsd?: number;
            inputTokens?: number;
            outputTokens?: number;
          };
          retriedAt: number;
        }>;
      }>;
      createdAt: number;
      endedAt?: number;
    }
  | {
      /**
       * Dynamic workflow script harness 状态卡。
       *
       * 展示 workflow 级 lifecycle；实际子任务继续由 subagent_batch part 展示。
       */
      kind: "workflow_run";
      id: string;
      objective: string;
      rationale: string;
      status: WorkflowRunStatus;
      manifest?: WorkflowManifest;
      resumedFromWorkflowId?: string;
      checkpoints: WorkflowCheckpoint[];
      artifacts: WorkflowArtifact[];
      logs: WorkflowScriptLog[];
      traceEvents?: WorkflowTraceEvent[];
      createdAt: number;
      endedAt?: number;
      returnValue?: unknown;
      error?: string;
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
  /** SDK message 级别元信息；用于把模型名 / token 用量固定到具体 assistant 回复上 */
  meta?: ChatMessageMeta;
}

export interface ChatMessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface ChatMessageMeta {
  provider?: string;
  model?: string;
  api?: string;
  responseId?: string;
  usage?: ChatMessageUsage;
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

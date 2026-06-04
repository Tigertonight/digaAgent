/**
 * Per-runner 状态：一个 runner 对应一个会话的"完整工作面"。
 *
 * 多会话并发模型的终态：
 *   - runnersRef: Map<RunnerKey, RunnerState> 是唯一权威存储
 *   - 当前活跃 runner 的快照通过 useState 触发渲染（activeSnapshot）
 *   - 切换 = setActiveKey + setActiveSnapshot(map.get(newKey))
 *   - SSE 事件按 ownerKey 路由到对应 runner（即使不可见也能继续累积）
 *
 * RunnerKey 规则：
 *   - "draft"：没选任何 session 时的草稿槽，全局只有一个
 *   - <sessionPath>：选中已有 session（=session.id 即 .jsonl 绝对路径）
 *   - 草稿首次发送拿到 sessionFile 后，runner 在 Map 里被 rename：
 *     delete("draft") + set(sessionFile, runner)，然后新建空草稿
 */
import { EMPTY_BROWSER_SNAPSHOT, type BrowserSnapshot } from "./browser/types";
import type { AgentGoal } from "./goal/types";
import type { AgentProgress } from "./progress/types";
import type {
  ForkableUserMessage,
  ImageContentLite,
  ThinkingLevel,
} from "./types";
import { THINKING_LEVELS } from "./types";
import { createInitialState, type ReducerState } from "./chat-reducer";

export type RunnerKey = string;
export const DRAFT_KEY: RunnerKey = "draft";

/** 流式 phase（与 ChatApp 内 AgentPhase 同形，重复定义避免循环依赖） */
export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "thinking" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  errorMessage?: string;
}

export interface StatsSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  total: number;
  cost: number;
  ctxTokens: number | null;
  ctxPct: number | null;
  ctxWindow: number | null;
}

export interface ToolsCountSnapshot {
  active: number;
  total: number;
}

export interface PendingMessagesSnapshot {
  steering: string[];
  followUp: string[];
}

/** 拖入的非图片附件 chip（与 ChatApp 内 PendingAttachment 同形） */
export type PendingAttachmentKind =
  | "folder"
  | "doc"
  | "archive"
  | "code"
  | "table"
  | "pdf"
  | "other";

export interface PendingAttachment {
  path: string;
  name: string;
  size: number | null;
  kind: PendingAttachmentKind;
}

export type SseStatus = "idle" | "active" | "lost";

/**
 * 一个 runner 持有的全部 per-session 状态。
 *
 * 注意：不要把 sessions 列表、cwd、theme、providers 这些"全局"状态放进来。
 * 全局保留在 ChatApp 顶层 useState；runner 只装"一个会话独占的工作状态"。
 */
export interface RunnerState {
  // 身份
  agentId: string | null;
  agentSessionId: string | null;
  /** 后端 SDK 写的 .jsonl 文件路径；首次发送拿到 data.sessionFile 后填上 */
  sessionFile: string | null;

  // 对话内容
  chatState: ReducerState;
  forkableUserMessages: ForkableUserMessage[];
  forkingIndex: number | null;
  forkText: string;
  forkBusy: boolean;

  // 流式 / 阶段
  streaming: boolean;
  agentPhase: AgentPhase;
  compacting: boolean;
  compactError: string | null;
  retryInfo: RetryInfo | null;
  /**
   * 本轮 run 的开始时间戳（ms）；agent_start 时打、agent_end 时清。
   * 用于 Budget 计算 duration 维度（RFC-2 Phase A）。
   */
  runStartedAt: number | null;

  // HUD
  stats: StatsSnapshot | null;
  toolsCount: ToolsCountSnapshot | null;
  pendingMessages: PendingMessagesSnapshot;
  browser: BrowserSnapshot;
  goal: AgentGoal | null;
  progress: AgentProgress | null;

  // thinking 能力
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  supportsThinking: boolean;

  // 输入框（runner-local：切走后再切回，输入到一半的内容仍在）
  input: string;
  pendingImages: ImageContentLite[];
  pendingFiles: PendingAttachment[];

  // SSE
  sseStatus: SseStatus;
  /** since-seq 重连用：上一次收到事件的 envelope.seq */
  lastSeq: number;

  /** LRU 时间戳：切到 / 收到事件时更新；用于 8 上限淘汰 */
  lastTouched: number;
}

/**
 * 初始 runner（草稿态 / 历史会话冷启动 都用这个）。
 * 调用方再按需 mutate（例如冷启动会话时把 chatState 替换为 ctxToMessages 后的 state）。
 */
export function emptyRunner(): RunnerState {
  return {
    agentId: null,
    agentSessionId: null,
    sessionFile: null,

    chatState: createInitialState(),
    forkableUserMessages: [],
    forkingIndex: null,
    forkText: "",
    forkBusy: false,

    streaming: false,
    agentPhase: null,
    compacting: false,
    compactError: null,
    retryInfo: null,
    runStartedAt: null,

    stats: null,
    toolsCount: null,
    pendingMessages: { steering: [], followUp: [] },
    browser: { ...EMPTY_BROWSER_SNAPSHOT, logs: [] },
    goal: null,
    progress: null,

    thinkingLevel: "medium",
    availableThinkingLevels: [...THINKING_LEVELS],
    supportsThinking: true,

    input: "",
    pendingImages: [],
    pendingFiles: [],

    sseStatus: "idle",
    lastSeq: 0,

    lastTouched: Date.now(),
  };
}

/** 浅 patch helper：跟 React setState 函数式 setter 同义，但操作 RunnerState */
export type RunnerPatch =
  | Partial<RunnerState>
  | ((prev: RunnerState) => Partial<RunnerState>);

export function applyPatch(prev: RunnerState, patch: RunnerPatch): RunnerState {
  const delta = typeof patch === "function" ? patch(prev) : patch;
  return { ...prev, ...delta };
}

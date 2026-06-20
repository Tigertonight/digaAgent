/**
 * AgentSession 进程内注册表。
 *
 * 负责：
 * 1. 创建/复用 AgentSession（用 createAgentSession 工厂）
 * 2. 把每个 AgentSession 的事件流缓存到内存 ring buffer，让 SSE 路由能"回放 + 续传"
 *
 * 注意：Next dev 模式下 module 会被 hot-reload，用 globalThis 持久化避免每次代码改动就丢 state。
 */
import "server-only";
import {
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
  SessionManager,
  ModelRegistry,
  AuthStorage,
  SettingsManager,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import { createCollabExtension } from "./collab/extension";
import {
  CONTEXT_ASIDE_CLOSE,
  CONTEXT_ASIDE_OPEN,
} from "./context-aside";
import { withCommunicationInstructions } from "./communication/instructions";
import { getCommunicationSettings } from "./communication/settings";
import { createClarificationExtension } from "./clarification/extension";
import { createBrowserExtension } from "./browser/extension";
import { disposeBrowser } from "./browser/runtime";
import { agentBrowserId, standaloneBrowserId } from "./browser/browser-id";
import { createClipboardExtension } from "./clipboard/extension";
import { createGoalExtension } from "./goal/extension";
import { createProgressExtension } from "./progress/extension";
import { createDelegateSubagentsTool } from "./subagents/extension";
import { createSubagentWriteBoundaryExtension } from "./subagents/write-boundary-extension";
import {
  abortRunningSubagentBatches,
  runSubagentBatch,
} from "./subagents/orchestrator";
import {
  createDynamicWorkflowTool,
  createWorkflowScriptTool,
  createListWorkflowTemplatesTool,
  createListWorkflowSkillsTool,
  createReadWorkflowResourceTool,
  createSaveWorkflowSkillTool,
  createListWorkflowScriptDraftsTool,
  createReadWorkflowScriptDraftTool,
  createSaveWorkflowScriptDraftTool,
} from "./workflows/extension";
import { runDynamicWorkflow } from "./workflows/orchestrator";
import { runWorkflowScript } from "./workflows/script-runtime";
import { abortRunningWorkflows, getWorkflowRun } from "./workflows/server-store";
import { createGitWorktreeManager } from "./workflows/git-worktree";
import { getWorkflowNetworkPolicy } from "./workflows/network-policy";
import { resolveLocalCodingAssistantCli } from "./local-coding-assistant/cli";
import {
  createWriteTruncationRecoveryExtension,
  largeFileWriteProtocolLines,
} from "./tool-recovery/truncated-write";
import { DEFAULT_RULES } from "./collab/rules";
import {
  clearAllStaleApprovals,
  clearSessionRemember,
  hasSessionRemember,
  listPendingApprovals,
  registerPendingApproval,
} from "./collab/server-store";
import {
  clearAgentClarifications,
  clearAllStaleClarifications,
  listPendingClarifications,
  registerPendingClarification,
} from "./clarification/server-store";
import {
  bindGoalSession,
  buildGoalRecap,
  clearGoal,
  finishGoalTurn,
  getGoal,
  noteGoalContinuation,
  setGoalStatus,
  startGoalTurn,
} from "./goal/server-store";
import { applyGoalUpdate } from "./goal/update";
import { shouldStopRetrying } from "./goal/blocked-state";
import { bridgeProgressEvidence } from "./goal/evidence-bridge";
import { getDefinition } from "./subagents/registry";
import { loadMcpToolDefinitions } from "./mcp/loader";
import {
  listMcpTools as listMcpToolsRuntime,
  callMcpTool as callMcpToolRuntime,
} from "./mcp/runtime";
import { listEnabledMcpServers } from "./mcp/registry";
import { clearProgress, updateProgress } from "./progress/server-store";
import { writePersistedProgress } from "./progress/file-store";
import {
  appendEvidenceMany,
  disposeEvidenceForAgent,
} from "./evidence/server-store";
import {
  appendRuntimeEvent,
  disposeRuntimeEventsForAgent,
} from "./runtime/event-store";
import { bridgeAgentEventToRuntime } from "./runtime/agent-event-bridge";
import {
  DEFAULT_CLIENT_REQUEST_TTL_MS,
  claimRecentClientRequest,
} from "./client-request-dedupe";
import type {
  ApprovalRequestEvent,
  ApprovalResolvedEvent,
} from "./collab/types";
import type {
  ClarificationRequestEvent,
  ClarificationResolvedEvent,
} from "./clarification/types";
import type { BrowserStateEvent } from "./browser/types";
import type { SubagentEvent, SubagentRole } from "./subagents/types";
import type { WorkflowEvent } from "./workflows/types";
import type { AgentGoal, GoalUpdatedEvent } from "./goal/types";
import type {
  AgentProgress,
  ProgressUpdatedEvent,
} from "./progress/types";
import type { SessionRuntimePhase, SessionRuntimeState } from "./types";

function workflowFetchUrlRuleId(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (!host) return "workflow-fetch-url";
    const port = parsed.port ? `:${parsed.port}` : "";
    return `workflow-fetch-url:${parsed.protocol}//${host}${port}`;
  } catch {
    return "workflow-fetch-url";
  }
}

/**
 * Ring buffer 里允许的事件类型。
 *
 * 除了 SDK 的 AgentSessionEvent，还包含 collab 自己的两个事件——它们走相同的 SSE 通道
 * 被推到前端，前端 useAgentEvents 按 type 字段分发。
 *
 * 注：把 union 包给 events 字段使用，对 SSE encode 路径透明（JSON.stringify 即可），
 * 对 SDK subscribe 路径也不影响（subscribe handler 仍然只塞 AgentSessionEvent）。
 */
/**
 * F-A5：optimistic user message 确认事件。后端调 SDK prompt 之前 push，
 * 带上服务端最终发给模型的 displayText（stripAgentMentions 后的文本）。
 * 前端 reducer 收到后按 clientRequestId 找到 pending user 气泡，把其 text 衰变
 * 为 displayText 并去 pending；SDK 后续发的 user message_start 还是同一文本，
 * reducer 可以以一致文本重间同一条、不会产生双气泡。
 */
export interface OptimisticUserAckEvent {
  type: "optimistic_user_ack";
  clientRequestId: string;
  displayText: string;
}

export type RingBufferEvent =
  | AgentSessionEvent
  | ApprovalRequestEvent
  | ApprovalResolvedEvent
  | ClarificationRequestEvent
  | ClarificationResolvedEvent
  | BrowserStateEvent
  | SubagentEvent
  | WorkflowEvent
  | GoalUpdatedEvent
  | ProgressUpdatedEvent
  | OptimisticUserAckEvent;

export const LOCAL_CODING_ASSISTANT_PROVIDER_ID = "local-coding-assistant";
export const LOCAL_CODING_ASSISTANT_MODEL_ID = "local-coding-assistant";
export const LOCAL_CODING_ASSISTANT_MODELS = [
  {
    id: LOCAL_CODING_ASSISTANT_MODEL_ID,
    name: "自研 Coding 助手 默认模型",
    cliModel: undefined,
  },
  {
    id: "opus",
    name: "Claude Opus (自研助手)",
    cliModel: "opus",
  },
  {
    id: "sonnet",
    name: "Claude Sonnet (自研助手)",
    cliModel: "sonnet",
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8 (自研助手)",
    cliModel: "claude-opus-4-8",
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5 (自研助手)",
    cliModel: "claude-sonnet-4-5",
  },
] as const;

export interface AgentRecord {
  id: string;
  session: AgentSession;
  cwd: string;
  parentAgentId?: string;
  childRole?: SubagentRole;
  hidden?: boolean;
  /**
   * 事件 ring buffer:固定容量环形数组,避免每次满了 splice(O(n))。
   * - 写:events[head++ % MAX],覆盖最旧
   * - 读:遍历 [head - count, head),根据 seq 过滤
   * - count = min(nextSeq, MAX),buffer 满之前 count == nextSeq
   */
  events: Array<{ seq: number; event: RingBufferEvent } | undefined>;
  nextSeq: number;
  /** notify all SSE listeners */
  listeners: Set<() => void>;
  /**
   * M5：是否已 dispose。dispose 时置 true 并唤醒 listeners，让仍挂着的 SSE 流
   * 能主动结束（否则要等浏览器 close 才触发 req.signal.abort）。
   */
  disposed?: boolean;
  /** 用来在 dispose 时取消订阅 */
  unsubscribe: () => void;
  /** 当前是否在跑(agent_start/end 之间为 true);给 sidebar 标"运行中"用 */
  isStreaming: boolean;
  /** 最近一次 runtime 相关更新，用于 PC/移动端 reconcile。 */
  updatedAt: number;
  /**
   * 上一轮 agent_end 的时间戳。sidebar “未读”蒙点看这个而不是
   * “jsonl mtime”，避免多 turn 错误拍上蒙点。
   */
  lastAgentEndAt: number | null;
  /** 短时间内的客户端请求去重，避免弱网/双击重复 prompt。 */
  recentClientRequests: Map<string, number>;
  /** local shim 可能给完整 assistant 内容但漏掉 done/end，用 watchdog 兜底收尾 */
  finishWatchdog: ReturnType<typeof setTimeout> | null;
  pendingFinishMessage: unknown | null;
  /** Tool start 后若 SDK/transport 断流且没有后续事件，用 watchdog 兜底收尾 */
  toolWatchdog: ReturnType<typeof setTimeout> | null;
  pendingToolCall:
    | {
        toolCallId: string;
        toolName?: string;
        startedAt: number;
      }
    | null;
  external?: {
    kind: "local-coding-assistant";
    child: ChildProcessWithoutNullStreams | null;
    emittedText: string;
  };
}

const MAX_EVENTS_PER_AGENT = 5000;
const FINISH_WATCHDOG_MS = 1500;
const DEFAULT_TOOL_WATCHDOG_MS = 30 * 60 * 1000;

function toolWatchdogMs(): number {
  const raw = process.env.DIGA_AGENT_TOOL_WATCHDOG_MS;
  if (!raw) return DEFAULT_TOOL_WATCHDOG_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TOOL_WATCHDOG_MS;
}
const DEFAULT_BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_screenshot",
  "browser_click",
  "browser_click_text",
  "browser_fill",
  "browser_type",
  "browser_search",
  "browser_wait",
  "browser_wait_for",
  "browser_extract",
  "browser_verify",
  "browser_annotations",
  "browser_resolve_annotation",
  "browser_close",
];

interface GlobalRegistry {
  agents: Map<string, AgentRecord>;
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
  /** SettingsManager 以 cwd 缓存，全局/项目 settings 不同 */
  settingsManagers?: Map<string, SettingsManager>;
  packageManagers?: Map<string, DefaultPackageManager>;
}

const g = globalThis as unknown as {
  __digaAgent?: GlobalRegistry;
  __digaAgentClarStaleSwept?: boolean;
  __digaAgentApprStaleSwept?: boolean;
};
if (!g.__digaAgent) {
  g.__digaAgent = { agents: new Map() };
}
const reg = g.__digaAgent!;

// C1：进程启动后一次性清掉从磁盘 hydrate 出来的所有 stale clarification。
if (!g.__digaAgentClarStaleSwept) {
  g.__digaAgentClarStaleSwept = true;
  try {
    clearAllStaleClarifications();
  } catch (e) {
    console.error("[clarification] startup stale sweep failed:", e);
  }
}

// F-A6：同样一次性清掉 stale approval。重启后 UI 还能列出来的 approval
// promise 已丢，点只会 409。
if (!g.__digaAgentApprStaleSwept) {
  g.__digaAgentApprStaleSwept = true;
  try {
    clearAllStaleApprovals();
  } catch (e) {
    console.error("[approval] startup stale sweep failed:", e);
  }
}

export function getAuth(): AuthStorage {
  if (!reg.authStorage) {
    reg.authStorage = AuthStorage.create();
  }
  return reg.authStorage;
}

export function getModelRegistry(): ModelRegistry {
  if (!reg.modelRegistry) {
    reg.modelRegistry = ModelRegistry.create(getAuth());
  }
  return reg.modelRegistry;
}

export function listAgentSummaries(): SessionRuntimeState[] {
  return Array.from(reg.agents.values()).map((rec) => {
    const waitingApprovalCount = listPendingApprovals(rec.id).length;
    const waitingClarificationCount = listPendingClarifications(rec.id).length;
    const runtimeState: SessionRuntimePhase =
      waitingApprovalCount + waitingClarificationCount > 0
        ? "waiting_user"
        : rec.isStreaming
          ? "streaming"
          : rec.nextSeq > 0
            ? "completed"
            : "idle";
    return {
      id: rec.id,
      agentId: rec.id,
      sessionId: rec.session.sessionId,
      sessionFile: rec.session.sessionFile ?? null,
      cwd: rec.cwd,
      isStreaming: rec.isStreaming,
      hidden: rec.hidden === true,
      waitingApprovalCount,
      waitingClarificationCount,
      lastEventSeq: rec.nextSeq - 1,
      lastAgentEndAt: rec.lastAgentEndAt,
      updatedAt: rec.updatedAt ?? Date.now(),
      runtimeState,
    };
  });
}

export function claimClientRequest(
  agentId: string,
  clientRequestId: string | null | undefined
): boolean {
  const requestId = clientRequestId?.trim();
  if (!requestId) return true;
  const rec = getAgent(agentId);
  if (!rec) return true;
  if (!rec.recentClientRequests) {
    rec.recentClientRequests = new Map();
  }
  const now = Date.now();
  const claimed = claimRecentClientRequest(
    rec.recentClientRequests,
    requestId,
    now,
    DEFAULT_CLIENT_REQUEST_TTL_MS
  );
  if (!claimed) return false;
  rec.updatedAt = now;
  return true;
}

export function clearClientRequest(
  agentId: string,
  clientRequestId: string | null | undefined
): void {
  const requestId = clientRequestId?.trim();
  if (!requestId) return;
  getAgent(agentId)?.recentClientRequests?.delete(requestId);
}

/** 拿（或创建）对应 cwd 的 SettingsManager */
export function getSettingsManager(cwd?: string): SettingsManager {
  const useCwd = cwd && cwd.length > 0 ? cwd : os.homedir();
  if (!reg.settingsManagers) reg.settingsManagers = new Map();
  let sm = reg.settingsManagers.get(useCwd);
  if (!sm) {
    sm = SettingsManager.create(useCwd);
    reg.settingsManagers.set(useCwd, sm);
  }
  return sm;
}

/** 拿（或创建）对应 cwd 的 PackageManager */
export function getPackageManager(cwd?: string): DefaultPackageManager {
  const useCwd = cwd && cwd.length > 0 ? cwd : os.homedir();
  if (!reg.packageManagers) reg.packageManagers = new Map();
  let pm = reg.packageManagers.get(useCwd);
  if (!pm) {
    pm = new DefaultPackageManager({
      cwd: useCwd,
      agentDir: getAgentDir(),
      settingsManager: getSettingsManager(useCwd),
    });
    reg.packageManagers.set(useCwd, pm);
  }
  return pm;
}

function releaseManagersForCwdIfUnused(cwd: string): void {
  for (const rec of reg.agents.values()) {
    if (rec.cwd === cwd) return;
  }
  reg.settingsManagers?.delete(cwd);
  reg.packageManagers?.delete(cwd);
}

/**
 * 把一条「非 SDK 来源」的事件塞进 ring buffer 并通知 SSE listeners。
 *
 * 用途：collab 自定义事件（approval_request / approval_resolved）走相同 SSE 通道
 * 推到前端，前端按 type 字段分发。
 *
 * 设计要点：
 *   - 与 session.subscribe 内的写入路径**完全对称**（同步 seq++、同 ring buffer 写法、
 *     同 listeners 通知）；这样 SSE 路由按 seq 顺序读出后 since 重连语义保持一致
 *   - 不更新 isStreaming flag（approval 事件不算 agent_start/end）
 */
export function pushExternalEvent(
  rec: AgentRecord,
  event:
    | ApprovalRequestEvent
    | ApprovalResolvedEvent
    | ClarificationRequestEvent
    | ClarificationResolvedEvent
    | BrowserStateEvent
    | SubagentEvent
    | WorkflowEvent
    | GoalUpdatedEvent
    | ProgressUpdatedEvent
    | OptimisticUserAckEvent
): void {
  pushAgentEvent(rec, event);
}

export function pushGoalEvent(rec: AgentRecord, goal: AgentGoal | null): void {
  pushExternalEvent(rec, { type: "goal_updated", goal });
}

export function pushProgressEvent(
  rec: AgentRecord,
  progress: AgentProgress
): void {
  pushExternalEvent(rec, { type: "progress_updated", progress });
}

/**
 * Goal 后台续跑时发给模型的 prompt。
 *
 * 这是“系统推进”表 —— 不是用户说的话，不该以 user 气泡形式进入会话历史。
 * 设计：**整个 prompt 都裹在 CONTEXT_ASIDE 里**，可见文本为空。前端
 * chat-reducer 在 user message_start 看到 parts.length===0 时跳过添加，
 * 避免出现空气泡或重复出现同样的 goal.objective。
 */
function buildGoalContinuationPrompt(goal: AgentGoal, recap?: string): string {
  const aside = [
    `Continue working toward the active goal: ${goal.objective}`,
    ...(recap && recap.trim()
      ? ["", "Context from previous turns (do not repeat finished work):", recap]
      : []),
    "",
    "Do the next useful step. If the full goal is achieved, call goal_update with status=complete.",
    "Keep the user-visible progress current with update_progress when steps start, finish, block, or produce evidence artifacts.",
    "If you are truly blocked and cannot make meaningful progress without user input or an external change, call goal_update with status=blocked and include a short blockedReason.",
    "Otherwise continue implementation, verification, or investigation. Keep the user informed with concise progress.",
  ].join("\n");
  return [CONTEXT_ASIDE_OPEN, aside, CONTEXT_ASIDE_CLOSE].join("\n");
}

function maybeContinueGoal(rec: AgentRecord): void {
  const goal = getGoal(rec.id);
  if (!goal || goal.status !== "active") return;

  // Dead-loop guard: if the goal keeps hitting the same blocker, stop
  // auto-retrying and surface the concrete unblock action to the user instead of
  // burning tokens on a wall we cannot pass.
  if (shouldStopRetrying(goal.blockedState)) {
    const state = goal.blockedState!;
    const paused = setGoalStatus(rec.id, "paused", {
      pauseReason: `Stuck on a repeated blocker (${state.repeatedCount}x): ${state.unblockAction}`,
    });
    pushGoalEvent(rec, paused);
    return;
  }

  if (
    listPendingApprovals(rec.id).length > 0 ||
    listPendingClarifications(rec.id).length > 0
  ) {
    const paused = setGoalStatus(rec.id, "paused", {
      pauseReason: GOAL_PAUSE_WAITING_USER,
    });
    pushGoalEvent(rec, paused);
    return;
  }

  const now = Date.now();
  if (goal.lastRunAt && now - goal.lastRunAt < 1200) return;
  const next = noteGoalContinuation(rec.id);
  if (!next || next.status !== "active") return;
  pushGoalEvent(rec, next);

  setTimeout(() => {
    const latest = getGoal(rec.id);
    if (!latest || latest.status !== "active" || rec.isStreaming) return;
    const recap = buildGoalRecap(rec.id);
    void (async () => {
      const prompt = withCommunicationInstructions(
        buildGoalContinuationPrompt(latest, recap),
        await getCommunicationSettings()
      );
      await rec.session.prompt(prompt);
    })().catch((e) => {
      finishStreamingAfterPromptError(rec.id);
      const paused = setGoalStatus(rec.id, "paused", {
        pauseReason:
          e instanceof Error ? e.message : "Goal continuation failed.",
      });
      pushGoalEvent(rec, paused);
    });
  }, 200);
}

/**
 * G5：当追问/审批 resolve 后调一次。如果 goal 是“等用户输入”被暂停的，
 * 且现在再也没有未处理的 approval / clarification 了，就自动恢复到 active 并
 * 推进下一轮。这个函数幂等，反复调只在含义匹配时才跳进。
 */
export const GOAL_PAUSE_WAITING_USER = "Waiting for user input.";

export function maybeResumeGoalAfterUserInput(agentId: string): void {
  const rec = reg.agents.get(agentId);
  if (!rec) return;
  const goal = getGoal(agentId);
  if (!goal) return;
  if (goal.status !== "paused") return;
  if (goal.pauseReason !== GOAL_PAUSE_WAITING_USER) return;
  if (
    listPendingApprovals(agentId).length > 0 ||
    listPendingClarifications(agentId).length > 0
  ) {
    return;
  }
  const resumed = setGoalStatus(agentId, "active");
  pushGoalEvent(rec, resumed);
  // 调一下推进，由 maybeContinueGoal 决定是否起 prompt。
  maybeContinueGoal(rec);
}

function pushAgentEvent(rec: AgentRecord, event: RingBufferEvent): void {
  const seq = rec.nextSeq++;
  rec.updatedAt = Date.now();
  rec.events[seq % MAX_EVENTS_PER_AGENT] = { seq, event };
  mirrorRuntimeEvent(rec, seq, event);
  // fix-S3.d：任一 listener 抛错不能影响后面的。多 tab / pet 窗口 / 移动端
  // 同时订阅同一 agent 时，其中一个跳出 controller 会报错，不应该宜后面的 SSE。
  for (const l of rec.listeners) {
    try {
      l();
    } catch (err) {
      console.error("[agent-registry] listener threw:", err);
    }
  }
}

function mirrorRuntimeEvent(
  rec: AgentRecord,
  seq: number,
  event: RingBufferEvent
): void {
  try {
    const bridged = bridgeAgentEventToRuntime(
      {
        agentId: rec.id,
        sessionId: rec.session.sessionId,
        sessionPath: rec.session.sessionFile ?? null,
        cwd: rec.cwd,
        seq,
      },
      event
    );
    if (!bridged) return;
    const evidence = appendEvidenceMany(bridged.evidence);
    appendRuntimeEvent(
      evidence.length > 0 ? { ...bridged.event, evidence } : bridged.event
    );
  } catch (err) {
    console.error("[runtime-event-bridge] mirror failed:", err);
  }
}

// fix-S5.b：原本有个 messageHasStopReason 拽起的空 if-branch，存在原因是为了
// 记录“不要根据 partial assistant message 推断轮次结束”的决策。现在提取
// 成上面这句注释并删除未使用的 helper，保持代码干净。

function clearFinishWatchdog(rec: AgentRecord) {
  if (rec.finishWatchdog) {
    clearTimeout(rec.finishWatchdog);
    rec.finishWatchdog = null;
  }
  rec.pendingFinishMessage = null;
}

function clearToolWatchdog(rec: AgentRecord) {
  if (rec.toolWatchdog) {
    clearTimeout(rec.toolWatchdog);
    rec.toolWatchdog = null;
  }
  rec.pendingToolCall = null;
}

/**
 * T1.2：abort 路径为什么需要这个单点：
 *
 * 模型 `message_end → agent_end` 之间有个 1.5s 的 finish watchdog，如果用户
 * 在此期间点中止，原送送路径只改 `isStreaming = false`，但 watchdog 仍
 * 会在 1.5s 后调 `finishStreamingRun(rec)` → `maybeContinueGoal(rec)` →
 * 在 goal 还 active 时起新一轮 prompt。表现为“点击中止后过 1.5s 却又跑了一轮”。
 *
 * 本函数把「清 watchdog」改在 `isStreaming = false` 之前顺序执行，保证
 * abort 后不会再造成 ghost run；同时也会被 dispose 复用以避免重复书写。
 *
 * 调用顺序：clearFinishWatchdog → clearToolWatchdog → isStreaming=false。
 */
export function finalizeAfterAbort(rec: AgentRecord): void {
  clearFinishWatchdog(rec);
  clearToolWatchdog(rec);
  rec.isStreaming = false;
  rec.updatedAt = Date.now();
}

function finishStreamingRun(rec: AgentRecord): void {
  if (!rec.isStreaming) return;
  clearToolWatchdog(rec);
  rec.isStreaming = false;
  rec.lastAgentEndAt = Date.now();
  // Close the open goal turn before deciding whether to auto-continue. The
  // goal's terminal status (complete/blocked) maps onto the turn status.
  const goal = getGoal(rec.id);
  if (goal) {
    const turnStatus =
      goal.status === "complete"
        ? "completed"
        : goal.status === "blocked"
          ? "blocked"
          : "completed";
    finishGoalTurn(rec.id, {
      status: turnStatus,
      ...(goal.status === "blocked" && goal.blockedReason
        ? { blockedReason: goal.blockedReason }
        : {}),
    });
  }
  maybeContinueGoal(rec);
}

function forceFinishStream(
  rec: AgentRecord,
  params: {
    reason:
      | "prompt_error"
      | "tool_timeout"
      | "local_abort"
      | "local_exit"
      | "user_abort";
    goalStatus?: "failed" | "completed";
    blockedReason?: string;
    pushAgentEnd?: boolean;
    continueGoal?: boolean;
  }
): void {
  clearFinishWatchdog(rec);
  clearToolWatchdog(rec);
  const wasStreaming = rec.isStreaming;
  rec.isStreaming = false;
  const now = Date.now();
  rec.updatedAt = now;
  rec.lastAgentEndAt = now;
  const goal = getGoal(rec.id);
  if (goal && params.goalStatus) {
    finishGoalTurn(rec.id, {
      status: params.goalStatus,
      ...(params.blockedReason ? { blockedReason: params.blockedReason } : {}),
    });
  }
  if (params.continueGoal) {
    maybeContinueGoal(rec);
  }
  if (params.pushAgentEnd && wasStreaming) {
    pushAgentEvent(rec, { type: "agent_end" } as RingBufferEvent);
  }
}

function scheduleFinishWatchdog(rec: AgentRecord, message: unknown): void {
  clearFinishWatchdog(rec);
  rec.pendingFinishMessage = message;
  rec.finishWatchdog = setTimeout(() => {
    rec.finishWatchdog = null;
    rec.pendingFinishMessage = null;
    finishStreamingRun(rec);
  }, FINISH_WATCHDOG_MS);
}

function scheduleToolWatchdog(
  rec: AgentRecord,
  event: AgentSessionEvent
): void {
  if (event.type !== "tool_execution_start" && event.type !== "tool_execution_update") {
    return;
  }
  const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId !== "string" || !toolCallId) return;
  const existing = rec.pendingToolCall;
  rec.pendingToolCall = {
    toolCallId,
    toolName:
      typeof (event as { toolName?: unknown }).toolName === "string"
        ? (event as { toolName: string }).toolName
        : existing?.toolCallId === toolCallId
          ? existing.toolName
          : undefined,
    startedAt:
      existing?.toolCallId === toolCallId ? existing.startedAt : Date.now(),
  };
  if (rec.toolWatchdog) clearTimeout(rec.toolWatchdog);
  rec.toolWatchdog = setTimeout(() => {
    rec.toolWatchdog = null;
    const pending = rec.pendingToolCall;
    rec.pendingToolCall = null;
    if (!pending || pending.toolCallId !== toolCallId) return;
    if (!rec.isStreaming || rec.disposed) return;
    const elapsedSeconds = Math.max(
      1,
      Math.round((Date.now() - pending.startedAt) / 1000)
    );
    pushAgentEvent(rec, {
      type: "tool_execution_end",
      toolCallId,
      result: `Tool execution timed out after ${elapsedSeconds}s without a terminal event.`,
      isError: true,
    } as RingBufferEvent);
    forceFinishStream(rec, {
      reason: "tool_timeout",
      goalStatus: "failed",
      blockedReason: "Tool execution timed out before the agent produced a terminal event.",
      pushAgentEnd: true,
    });
  }, toolWatchdogMs());
}

export interface CreateOptions {
  provider: string;
  modelId: string;
  cwd: string;
  /** 复用已有 session 文件（resume） */
  sessionPath?: string;
  /** thinking level，默认 medium */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Optional active tool allowlist. Used by read-only child subagents. */
  tools?: string[];
  /** Optional active tool denylist. */
  excludeTools?: string[];
  /** For hidden child subagents: file or directory paths this agent may write. */
  writePaths?: string[];
  /** Metadata for hidden child subagents. */
  parentAgentId?: string;
  parentSessionPath?: string;
  childRole?: SubagentRole;
  hidden?: boolean;
  /**
   * Multi-agent clarification attribution (cowork). When set on a child
   * subagent, the child's ask_user requests are surfaced on the parent's
   * channel tagged with this task id/title so the user sees who is asking.
   */
  taskId?: string;
  taskTitle?: string;
  /** Main agents enable delegate_subagents; child subagents disable it to avoid recursion. */
  enableSubagents?: boolean;
  /**
   * MCP server scope (Sprint 5). undefined = main agent (all enabled servers);
   * a list = specialist scope (only those servers); [] = no MCP tools.
   */
  mcpServers?: string[];
}

export function islocalCodingAssistantModelId(modelId: string): boolean {
  return LOCAL_CODING_ASSISTANT_MODELS.some((model) => model.id === modelId);
}

function localCodingAssistantModel(modelId = LOCAL_CODING_ASSISTANT_MODEL_ID) {
  const option =
    LOCAL_CODING_ASSISTANT_MODELS.find((model) => model.id === modelId) ??
    LOCAL_CODING_ASSISTANT_MODELS[0];
  return {
    provider: LOCAL_CODING_ASSISTANT_PROVIDER_ID,
    id: option.id,
    name: option.name,
    api: "local-cli",
    baseUrl: "local-cli",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
}

function localCodingAssistantCliModelArg(modelId: string): string | undefined {
  return LOCAL_CODING_ASSISTANT_MODELS.find((model) => model.id === modelId)?.cliModel;
}

function createLocalCodingAssistantSession(sessionId: string, modelId: string) {
  const session = {
    sessionId,
    sessionFile: undefined,
    model: localCodingAssistantModel(modelId),
    thinkingLevel: "medium",
    pendingMessageCount: 0,
    systemPrompt: "",
    prompt: async () => undefined,
    followUp: async () => undefined,
    steer: async () => undefined,
    abort: async () => undefined,
    abortCompaction: () => undefined,
    compact: async () => undefined,
    dispose: () => undefined,
    subscribe: () => () => undefined,
    supportsThinking: () => false,
    getAvailableThinkingLevels: () => [],
    getAllTools: () => [],
    getActiveToolNames: () => [],
    setActiveToolsByName: () => undefined,
    setModel: (nextModel: ReturnType<typeof localCodingAssistantModel>) => {
      session.model = nextModel;
    },
    getSessionStats: () => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    }),
    getContextUsage: () => null,
    getUserMessagesForForking: () => [],
    sessionManager: {
      getTree: () => [],
      getLeafId: () => null,
    },
  };
  return session as unknown as AgentSession;
}

function localCodingAssistantMessage(
  role: "user" | "assistant",
  text: string,
  responseId?: string,
  modelId = LOCAL_CODING_ASSISTANT_MODEL_ID
) {
  return {
    role,
    responseId,
    provider: LOCAL_CODING_ASSISTANT_PROVIDER_ID,
    model: modelId,
    api: "local-cli",
    timestamp: Date.now(),
    content: text
      ? [
          {
            type: "text",
            text,
          },
        ]
      : [],
  };
}

function emitLocalCodingAssistantText(rec: AgentRecord, responseId: string, text: string) {
  if (!text) return;
  const modelId = rec.session.model?.id ?? LOCAL_CODING_ASSISTANT_MODEL_ID;
  pushAgentEvent(rec, {
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: text,
      partial: {
        responseId,
      },
    },
    message: localCodingAssistantMessage("assistant", "", responseId, modelId),
  } as RingBufferEvent);
}

function extractLocalCodingAssistantText(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const item = obj as {
    type?: unknown;
    delta?: unknown;
    text?: unknown;
    result?: unknown;
    message?: { content?: Array<{ type?: string; text?: string }> };
    content?: Array<{ type?: string; text?: string }>;
  };
  if (typeof item.delta === "string") return item.delta;
  if (typeof item.text === "string") return item.text;
  const blocks = item.message?.content ?? item.content;
  if (Array.isArray(blocks)) {
    return blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  }
  if (item.type === "result" && typeof item.result === "string") {
    return item.result;
  }
  return "";
}

function emitLocalCodingAssistantJsonLine(
  rec: AgentRecord,
  responseId: string,
  line: string
) {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const obj = JSON.parse(trimmed);
    const text = extractLocalCodingAssistantText(obj);
    if (!text) return;
    const emitted = rec.external?.emittedText ?? "";
    const delta = text.startsWith(emitted) ? text.slice(emitted.length) : text;
    if (rec.external) rec.external.emittedText = emitted + delta;
    emitLocalCodingAssistantText(rec, responseId, delta);
  } catch {
    emitLocalCodingAssistantText(rec, responseId, line.endsWith("\n") ? line : `${line}\n`);
  }
}

export function isLocalCodingAssistantAgent(rec: AgentRecord): boolean {
  return rec.external?.kind === "local-coding-assistant";
}

export async function promptLocalCodingAssistantAgent(
  rec: AgentRecord,
  text: string
): Promise<void> {
  if (rec.external?.child) {
    throw new Error("自研 Coding 助手正在运行，请等待完成或先中止当前任务。");
  }
  const responseId = randomUUID();
  const modelId = rec.session.model?.id ?? LOCAL_CODING_ASSISTANT_MODEL_ID;
  rec.external = {
    kind: "local-coding-assistant",
    child: null,
    emittedText: "",
  };
  rec.isStreaming = true;
  rec.updatedAt = Date.now();
  pushAgentEvent(rec, { type: "agent_start" } as RingBufferEvent);
  pushAgentEvent(rec, {
    type: "message_start",
    message: localCodingAssistantMessage("user", text, undefined, modelId),
  } as RingBufferEvent);
  pushAgentEvent(rec, {
    type: "message_start",
    message: localCodingAssistantMessage("assistant", "", responseId, modelId),
  } as RingBufferEvent);

  const modelArg = localCodingAssistantCliModelArg(modelId);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "default",
    ...(modelArg ? ["--model", modelArg] : []),
    text,
  ];
  let cliResolution: Awaited<ReturnType<typeof resolveLocalCodingAssistantCli>>;
  try {
    cliResolution = await resolveLocalCodingAssistantCli();
  } catch (err) {
    emitLocalCodingAssistantText(
      rec,
      responseId,
      `自研 Coding 助手启动失败：${err instanceof Error ? err.message : String(err)}`
    );
    forceFinishStream(rec, {
      reason: "prompt_error",
      goalStatus: "failed",
      blockedReason: "Local coding assistant failed to start.",
      pushAgentEnd: true,
    });
    return;
  }

  const child = spawn(cliResolution.command, args, {
    cwd: rec.cwd,
    env: {
      ...cliResolution.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
  });
  rec.external.child = child;
  child.stdin.end();

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    let idx = stdoutBuffer.indexOf("\n");
    while (idx >= 0) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      emitLocalCodingAssistantJsonLine(rec, responseId, line);
      idx = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const textChunk = chunk.toString("utf8");
    if (textChunk.trim()) emitLocalCodingAssistantText(rec, responseId, textChunk);
  });

  child.on("close", (code, signal) => {
    if (stdoutBuffer.trim()) emitLocalCodingAssistantJsonLine(rec, responseId, stdoutBuffer);
    stdoutBuffer = "";
    if (code && code !== 0 && signal !== "SIGTERM") {
      emitLocalCodingAssistantText(
        rec,
        responseId,
        `\n\n[自研 Coding 助手退出，代码 ${code}]`
      );
    }
    pushAgentEvent(rec, {
      type: "message_end",
      message: {
        ...localCodingAssistantMessage("assistant", "", responseId, modelId),
        stopReason: code === 0 ? "stop" : "error",
      },
    } as RingBufferEvent);
    if (rec.external) rec.external.child = null;
    forceFinishStream(rec, {
      reason: "local_exit",
      goalStatus: code === 0 ? "completed" : "failed",
      ...(code === 0
        ? {}
        : { blockedReason: "Local coding assistant exited with an error." }),
      pushAgentEnd: true,
      continueGoal: code === 0,
    });
  });
  child.on("error", (err) => {
    emitLocalCodingAssistantText(rec, responseId, `自研 Coding 助手启动失败：${err.message}`);
  });
}

export async function abortLocalCodingAssistantAgent(rec: AgentRecord): Promise<void> {
  clearToolWatchdog(rec);
  if (rec.external?.child) {
    rec.external.child.kill("SIGTERM");
    rec.external.child = null;
  }
  if (rec.isStreaming) {
    forceFinishStream(rec, {
      reason: "local_abort",
      goalStatus: "failed",
      blockedReason: "Local coding assistant run was aborted.",
      pushAgentEnd: true,
    });
  }
}

async function createLocalCodingAssistantAgent(opts: CreateOptions): Promise<{
  id: string;
  sessionId: string;
  sessionFile: string | undefined;
}> {
  const id = randomUUID();
  const sessionId = randomUUID();
  const session = createLocalCodingAssistantSession(sessionId, opts.modelId);
  const record: AgentRecord = {
    id,
    session,
    cwd: opts.cwd,
    parentAgentId: opts.parentAgentId,
    childRole: opts.childRole,
    hidden: opts.hidden,
    events: new Array(MAX_EVENTS_PER_AGENT),
    nextSeq: 0,
    listeners: new Set(),
    unsubscribe: () => {},
    isStreaming: false,
    updatedAt: Date.now(),
    lastAgentEndAt: null,
    recentClientRequests: new Map(),
    finishWatchdog: null,
    pendingFinishMessage: null,
    toolWatchdog: null,
    pendingToolCall: null,
    external: {
      kind: "local-coding-assistant",
      child: null,
      emittedText: "",
    },
  };
  reg.agents.set(id, record);
  return { id, sessionId, sessionFile: undefined };
}

/**
 * T3.1: 同 sessionPath 的 in-flight 去重。
 *
 * 原问题：`POST /api/agent/new` 两次几乎同时到达（双击 / SPA 双 useEffect /
 * 网络重发）都会先走 `Array.from(reg.agents.values()).find(...)` 未命中，
 * 随后 await `resourceLoader.reload()` / `loadMcpToolDefinitions` /
 * `createAgentSession`，最后才 `reg.agents.set(id, record)`。在这段 await 窗口内
 * 另一个 caller 也看不到已创建的 record，于是为同一 sessionFile 创建出两条
 * AgentRecord，导致 SSE 双发事件、jsonl 并发写入。
 *
 * 修复思路：在入口维护 `Map<sessionPath, Promise<CreateResult>>`，后来者
 * 直接 await 已存在的 promise。`finally` 里中手从 map 删除该 key，避免抣出
 * 在缓存中被复用（下一个 caller 还能重试）。
 */
const createAgentInFlight = new Map<
  string,
  Promise<{ id: string; sessionId: string; sessionFile: string | undefined }>
>();

export async function createAgent(opts: CreateOptions): Promise<{
  id: string;
  sessionId: string;
  sessionFile: string | undefined;
}> {
  if (opts.sessionPath) {
    const existing = Array.from(reg.agents.values()).find(
      (rec) => !rec.hidden && rec.session.sessionFile === opts.sessionPath
    );
    if (existing) {
      return {
        id: existing.id,
        sessionId: existing.session.sessionId,
        sessionFile: existing.session.sessionFile,
      };
    }
    const inflight = createAgentInFlight.get(opts.sessionPath);
    if (inflight) return inflight;
  }

  if (
    opts.provider === LOCAL_CODING_ASSISTANT_PROVIDER_ID &&
    islocalCodingAssistantModelId(opts.modelId)
  ) {
    return createLocalCodingAssistantAgent(opts);
  }

  // 包装为可被中间复用的 promise。仅在 sessionPath 存在时才走 dedup（新建会话
  // sessionPath 为空、总是应该独立创建）。
  if (opts.sessionPath) {
    const key = opts.sessionPath;
    const promise = createAgentImpl(opts).finally(() => {
      if (createAgentInFlight.get(key) === promise) {
        createAgentInFlight.delete(key);
      }
    });
    createAgentInFlight.set(key, promise);
    return promise;
  }

  return createAgentImpl(opts);
}

async function createAgentImpl(opts: CreateOptions): Promise<{
  id: string;
  sessionId: string;
  sessionFile: string | undefined;
}> {

  const mr = getModelRegistry();
  const model = mr.find(opts.provider, opts.modelId);
  if (!model) {
    throw new Error(
      `model not found: ${opts.provider}/${opts.modelId}. Hint: 确认 provider 名 + env API key 已设置。`
    );
  }

  // 准备 SessionManager（要么 resume 已有文件，要么基于 cwd 新建）
  let sessionManager: SessionManager;
  if (opts.sessionPath) {
    sessionManager = SessionManager.open(opts.sessionPath);
  } else {
    sessionManager = SessionManager.create(
      opts.cwd,
      undefined,
      opts.parentSessionPath ? { parentSession: opts.parentSessionPath } : undefined
    );
  }

  // 提前生成 agentId —— B2 的 CollabExtension 需要 id 闭包来标记审批归属。
  // 这里提前到 createAgentSession 之前不影响 B1 行为（id 仍然唯一）。
  const id = randomUUID();

  // record 在 createAgentSession 之后才能建（要拿 session 实例）。
  // 但 CollabExtension 的 onApprovalNeeded 闭包需要访问 record 来 push 自定义事件——
  // 用 mutable holder 解决前向引用：handler 触发时 holder.current 一定已被赋值
  // （tool_call 发生时 createAgentSession 已完成，record 已建好）。
  const recordHolder: { current: AgentRecord | null } = { current: null };

  // 构造 ResourceLoader 并注入真 CollabExtension（Phase B3 接真通道）。
  // - getRules: 内置 1 条 dangerous-bash-destructive；未来 Settings 可注入用户规则
  // - getAgentId: 闭包到当前 id，approval id 用 `${agentId}:${toolCallId}` 复合 key
  // - onApprovalNeeded:
  //     1. push approval_request 进 ring buffer → SSE 通知前端弹气泡
  //     2. registerPendingApproval await 用户决策（或 5min 超时按 defaultDecision）
  //     3. push approval_resolved 进 ring buffer → SSE 通知前端更新气泡状态
  //     4. return 给 CollabExtension，由它决定 allow/block tool
  const collabExtension = createCollabExtension({
    getRules: () => DEFAULT_RULES,
    getAgentId: () => id,
    // B4：让 extension 在命中 ask 规则前先查"本 session 不再问"集合，
    // 命中即静默放行——比 onApprovalNeeded 后再返回 allow 更彻底（不弹气泡也不推事件）。
    hasRemember: (ruleId: string) => hasSessionRemember(id, ruleId),
    onApprovalNeeded: async (req) => {
      const rec = recordHolder.current;
      // 安全网：理论上 rec 一定有；若没有则降级 auto-allow（避免卡死 agent）。
      if (!rec) {
        console.error(
          "[collab] onApprovalNeeded called but record not ready; defaulting allow",
          req.id
        );
        return { decision: "allow" };
      }
      pushExternalEvent(rec, { type: "approval_request", request: req });
      const resp = await registerPendingApproval(req);
      // resolvedBy：本函数 await 时无法区分是 user 主动还是 timeout 触发了 resolver。
      // 由 server-store 内 setTimeout 触发的 resolve 不带 denyReason → 我们近似认为
      // 没 denyReason 且 decision === defaultDecision 时是超时；其余视为 user。
      // （Phase C 可在 ApprovalResponse 加 source 字段消除歧义，B3 先够用。）
      const resolvedBy: ApprovalResolvedEvent["resolvedBy"] =
        resp.denyReason === undefined && resp.decision === req.defaultDecision
          ? "timeout"
          : "user";
      pushExternalEvent(rec, {
        type: "approval_resolved",
        id: req.id,
        toolCallId: req.toolCallId,
        decision: resp.decision,
        resolvedBy,
        denyReason: resp.denyReason,
      });
      return resp;
    },
  });

  async function requestWorkflowCapabilityApproval(params: {
    workflowId: string;
    capability: string;
    objective: string;
    rationale: string;
    manifest: unknown;
  }) {
    const rec = recordHolder.current;
    if (!rec) {
      console.error(
        "[workflow] capability approval called but record not ready; defaulting deny",
        params.workflowId,
        params.capability
      );
      return {
        decision: "deny" as const,
        denyReason: "No UI approval channel was available.",
      };
    }
    const toolCallId = `workflow-capability:${params.workflowId}:${params.capability}`;
    const req = {
      id: `${id}:${toolCallId}`,
      agentId: id,
      toolCallId,
      toolName: `workflow:${params.capability}`,
      input: {
        workflowId: params.workflowId,
        capability: params.capability,
        objective: params.objective,
        rationale: params.rationale,
        manifest: params.manifest,
      },
      reason: "manual" as const,
      ruleId: `workflow-capability:${params.capability}`,
      defaultDecision: "deny" as const,
      createdAt: Date.now(),
    };
    pushExternalEvent(rec, { type: "approval_request", request: req });
    const resp = await registerPendingApproval(req);
    const resolvedBy: ApprovalResolvedEvent["resolvedBy"] =
      resp.denyReason === undefined && resp.decision === req.defaultDecision
        ? "timeout"
        : "user";
    const resolvedResp =
      resolvedBy === "timeout" && resp.decision === "deny"
        ? {
            ...resp,
            denyReason: `Workflow capability approval timed out: ${params.capability}`,
          }
        : resp;
    pushExternalEvent(rec, {
      type: "approval_resolved",
      id: req.id,
      toolCallId: req.toolCallId,
      decision: resolvedResp.decision,
      resolvedBy,
      denyReason: resolvedResp.denyReason,
    });
    return resolvedResp;
  }

  async function requestWorkflowWorktreeMergeApproval(params: {
    workflowId: string;
    objective: string;
    rationale: string;
    manifest: unknown;
    worktree: {
      id: string;
      path: string;
      branchName: string;
      baseRef: string;
    };
    diff: {
      stat: string;
      diff: string;
      path: string;
      branchName: string;
      baseRef: string;
    };
  }) {
    const rec = recordHolder.current;
    if (!rec) {
      console.error(
        "[workflow] worktree merge approval called but record not ready; defaulting deny",
        params.workflowId,
        params.worktree.id
      );
      return {
        decision: "deny" as const,
        denyReason: "No UI approval channel was available.",
      };
    }
    const toolCallId = `workflow-merge:${params.workflowId}:${params.worktree.id}`;
    const req = {
      id: `${id}:${toolCallId}`,
      agentId: id,
      toolCallId,
      toolName: "workflow:merge_worktree",
      input: {
        workflowId: params.workflowId,
        objective: params.objective,
        rationale: params.rationale,
        manifest: params.manifest,
        worktree: params.worktree,
        stat: params.diff.stat,
        diffPreview: params.diff.diff.slice(0, 12000),
        truncated: params.diff.diff.length > 12000,
      },
      reason: "manual" as const,
      ruleId: "workflow-merge-worktree",
      defaultDecision: "deny" as const,
      createdAt: Date.now(),
    };
    pushExternalEvent(rec, { type: "approval_request", request: req });
    const resp = await registerPendingApproval(req);
    const resolvedBy: ApprovalResolvedEvent["resolvedBy"] =
      resp.denyReason === undefined && resp.decision === req.defaultDecision
        ? "timeout"
        : "user";
    pushExternalEvent(rec, {
      type: "approval_resolved",
      id: req.id,
      toolCallId: req.toolCallId,
      decision: resp.decision,
      resolvedBy,
      denyReason: resp.denyReason,
    });
    return resp;
  }

  // 闭包内 requestSubagentWorktreeMergeApproval 已被 buildSubagentDepsForAgent 取代。

  async function requestMcpToolApproval(params: {
    serverId: string;
    tool: string;
    input: Record<string, unknown>;
  }) {
    const rec = recordHolder.current;
    if (!rec) {
      return {
        decision: "deny" as const,
        denyReason: "No UI approval channel was available.",
      };
    }
    const ruleId = `mcp:${params.serverId}:${params.tool}`;
    if (hasSessionRemember(id, ruleId)) {
      return { decision: "allow" as const };
    }
    const toolCallId = `mcp:${params.serverId}:${params.tool}:${Date.now()}`;
    const req = {
      id: `${id}:${toolCallId}`,
      agentId: id,
      toolCallId,
      toolName: `mcp:${params.serverId}/${params.tool}`,
      input: {
        serverId: params.serverId,
        tool: params.tool,
        argsPreview: JSON.stringify(params.input).slice(0, 800),
      },
      reason: "manual" as const,
      ruleId,
      defaultDecision: "deny" as const,
      createdAt: Date.now(),
    };
    pushExternalEvent(rec, { type: "approval_request", request: req });
    const resp = await registerPendingApproval(req);
    const resolvedBy: ApprovalResolvedEvent["resolvedBy"] =
      resp.denyReason === undefined && resp.decision === req.defaultDecision
        ? "timeout"
        : "user";
    pushExternalEvent(rec, {
      type: "approval_resolved",
      id: req.id,
      toolCallId: req.toolCallId,
      decision: resp.decision,
      resolvedBy,
      denyReason: resp.denyReason,
    });
    return resp;
  }

  async function requestBrowserSiteApproval(params: {
    origin: string;
    url: string;
  }): Promise<boolean> {
    const rec = recordHolder.current;
    if (!rec) return false;
    const ruleId = `browser-site:${params.origin}`;
    if (hasSessionRemember(id, ruleId)) return true;
    const toolCallId = `browser-site:${params.origin}:${Date.now()}`;
    const req = {
      id: `${id}:${toolCallId}`,
      agentId: id,
      toolCallId,
      toolName: "browser:open_external_site",
      input: {
        origin: params.origin,
        url: params.url.slice(0, 500),
      },
      reason: "manual" as const,
      ruleId,
      defaultDecision: "deny" as const,
      createdAt: Date.now(),
    };
    pushExternalEvent(rec, { type: "approval_request", request: req });
    const resp = await registerPendingApproval(req);
    const resolvedBy: ApprovalResolvedEvent["resolvedBy"] =
      resp.denyReason === undefined && resp.decision === req.defaultDecision
        ? "timeout"
        : "user";
    pushExternalEvent(rec, {
      type: "approval_resolved",
      id: req.id,
      toolCallId: req.toolCallId,
      decision: resp.decision,
      resolvedBy,
      denyReason: resp.denyReason,
    });
    return resp.decision === "allow";
  }

  async function requestBrowserActionApproval(params: {
    action: string;
    detail: string;
    url: string | null;
  }): Promise<boolean> {
    const rec = recordHolder.current;
    if (!rec) return false;
    const toolCallId = `browser-action:${params.action}:${Date.now()}`;
    const req = {
      id: `${id}:${toolCallId}`,
      agentId: id,
      toolCallId,
      toolName: `browser:sensitive_action`,
      input: {
        action: params.action,
        detail: params.detail,
        url: params.url ?? "(none)",
      },
      reason: "manual" as const,
      ruleId: `browser-action:${params.action}`,
      defaultDecision: "deny" as const,
      createdAt: Date.now(),
    };
    pushExternalEvent(rec, { type: "approval_request", request: req });
    const resp = await registerPendingApproval(req);
    const resolvedBy: ApprovalResolvedEvent["resolvedBy"] =
      resp.denyReason === undefined && resp.decision === req.defaultDecision
        ? "timeout"
        : "user";
    pushExternalEvent(rec, {
      type: "approval_resolved",
      id: req.id,
      toolCallId: req.toolCallId,
      decision: resp.decision,
      resolvedBy,
      denyReason: resp.denyReason,
    });
    return resp.decision === "allow";
  }

  async function requestWorkflowMcpToolApproval(params: {
    workflowId: string;
    objective: string;
    rationale: string;
    manifest: unknown;
    input: { server: string; tool: string; input?: Record<string, unknown> };
  }) {
    const rec = recordHolder.current;
    if (!rec) {
      return {
        decision: "deny" as const,
        denyReason: "No UI approval channel was available.",
      };
    }
    const ruleId = `mcp:${params.input.server}:${params.input.tool}`;
    if (hasSessionRemember(id, ruleId)) {
      return { decision: "allow" as const };
    }
    const toolCallId = `workflow-mcp:${params.workflowId}:${params.input.server}:${params.input.tool}:${Date.now()}`;
    const req = {
      id: `${id}:${toolCallId}`,
      agentId: id,
      toolCallId,
      toolName: `workflow:mcp:${params.input.server}/${params.input.tool}`,
      input: {
        workflowId: params.workflowId,
        objective: params.objective,
        rationale: params.rationale,
        manifest: params.manifest,
        server: params.input.server,
        tool: params.input.tool,
        argsPreview: JSON.stringify(params.input.input ?? {}).slice(0, 800),
      },
      reason: "manual" as const,
      ruleId,
      defaultDecision: "deny" as const,
      createdAt: Date.now(),
    };
    pushExternalEvent(rec, { type: "approval_request", request: req });
    const resp = await registerPendingApproval(req);
    const resolvedBy: ApprovalResolvedEvent["resolvedBy"] =
      resp.denyReason === undefined && resp.decision === req.defaultDecision
        ? "timeout"
        : "user";
    pushExternalEvent(rec, {
      type: "approval_resolved",
      id: req.id,
      toolCallId: req.toolCallId,
      decision: resp.decision,
      resolvedBy,
      denyReason: resp.denyReason,
    });
    return resp;
  }

  async function requestWorkflowNetworkApproval(params: {
    workflowId: string;
    objective: string;
    rationale: string;
    manifest: unknown;
    input: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      maxBytes?: number;
    };
  }) {
    const rec = recordHolder.current;
    if (!rec) {
      console.error(
        "[workflow] network approval called but record not ready; defaulting deny",
        params.workflowId,
        params.input.url
      );
      return {
        decision: "deny" as const,
        denyReason: "No UI approval channel was available.",
      };
    }
    const safeUrl = params.input.url.slice(0, 500);
    const ruleId = workflowFetchUrlRuleId(params.input.url);
    if (hasSessionRemember(id, ruleId)) {
      return { decision: "allow" as const };
    }
    const toolCallId = `workflow-fetch:${params.workflowId}:${Date.now()}`;
    const req = {
      id: `${id}:${toolCallId}`,
      agentId: id,
      toolCallId,
      toolName: "workflow:fetch_url",
      input: {
        workflowId: params.workflowId,
        objective: params.objective,
        rationale: params.rationale,
        manifest: params.manifest,
        url: safeUrl,
        method: params.input.method ?? "GET",
        headerNames: Object.keys(params.input.headers ?? {}),
        bodyPreview: params.input.body?.slice(0, 500),
        bodyTruncated: Boolean(params.input.body && params.input.body.length > 500),
        maxBytes: params.input.maxBytes,
      },
      reason: "manual" as const,
      ruleId,
      defaultDecision: "deny" as const,
      createdAt: Date.now(),
    };
    pushExternalEvent(rec, { type: "approval_request", request: req });
    const resp = await registerPendingApproval(req);
    const resolvedBy: ApprovalResolvedEvent["resolvedBy"] =
      resp.denyReason === undefined && resp.decision === req.defaultDecision
        ? "timeout"
        : "user";
    pushExternalEvent(rec, {
      type: "approval_resolved",
      id: req.id,
      toolCallId: req.toolCallId,
      decision: resp.decision,
      resolvedBy,
      denyReason: resp.denyReason,
    });
    return resp;
  }

  async function requestWorkflowUserClarification(params: {
    workflowId: string;
    input: {
      title?: string;
      question: string;
      context?: string;
      options: Array<{
        id?: string;
        label: string;
        description?: string;
        value?: string;
      }>;
      recommendedOptionId?: string;
    };
  }) {
    const rec = recordHolder.current;
    if (!rec) {
      console.error(
        "[workflow] askUser called but record not ready; returning empty response",
        params.workflowId
      );
      return {
        requestId: `workflow-ask-user:${params.workflowId}`,
        customText: "No UI channel was available.",
        answer: "No UI channel was available.",
      };
    }
    const requestId = `workflow-ask-user:${params.workflowId}:${Date.now()}`;
    const options = params.input.options.map((option, index) => ({
      id: option.id || `option-${index + 1}`,
      label: option.label.slice(0, 48),
      description: option.description?.slice(0, 160),
      value: (option.value?.trim() || option.label).slice(0, 500),
    }));
    const req = {
      id: `${id}:${requestId}`,
      agentId: id,
      requestId,
      title: params.input.title?.slice(0, 80) || "需要你确认下一步",
      question: params.input.question.slice(0, 500),
      context: params.input.context?.slice(0, 500),
      options,
      recommendedOptionId:
        params.input.recommendedOptionId &&
        options.some((option) => option.id === params.input.recommendedOptionId)
          ? params.input.recommendedOptionId
          : options[0]?.id,
      createdAt: Date.now(),
    };
    pushExternalEvent(rec, { type: "clarification_request", request: req });
    const resp = await registerPendingClarification(req);
    pushExternalEvent(rec, {
      type: "clarification_resolved",
      id: req.id,
      requestId: req.requestId,
      selectedOptionId: resp.selectedOptionId,
      customText: resp.customText,
      resolvedBy: "user",
    });
    const selected = resp.selectedOptionId
      ? options.find((option) => option.id === resp.selectedOptionId)
      : null;
    const answer = resp.customText?.trim() || selected?.value || "";
    return {
      requestId,
      selectedOptionId: resp.selectedOptionId,
      customText: resp.customText,
      answer,
    };
  }

  const clarificationExtension = createClarificationExtension({
    getAgentId: () => id,
    onClarificationNeeded: async (req) => {
      // Cowork: a child subagent has no visible SSE channel of its own
      // (hidden:true). Surface its clarification on the PARENT's channel so the
      // user actually sees and answers it, tagged with the originating task.
      const parentRec = opts.parentAgentId
        ? getAgent(opts.parentAgentId)
        : undefined;
      if (parentRec) {
        // Re-key the request onto the parent: pending + resolve must live under
        // the parent agent id so the parent's /clarification endpoint resolves it.
        const parentReq = {
          ...req,
          id: `${parentRec.id}:child:${id}:${req.requestId}`,
          agentId: parentRec.id,
          originAgentId: id,
          taskId: opts.taskId,
          taskTitle: opts.taskTitle,
        };
        pushExternalEvent(parentRec, {
          type: "clarification_request",
          request: parentReq,
        });
        const resp = await registerPendingClarification(parentReq);
        pushExternalEvent(parentRec, {
          type: "clarification_resolved",
          id: parentReq.id,
          requestId: parentReq.requestId,
          selectedOptionId: resp.selectedOptionId,
          customText: resp.customText,
          resolvedBy: "user",
        });
        return resp;
      }

      const rec = recordHolder.current;
      if (!rec) {
        console.error(
          "[clarification] ask_user called but record not ready; returning empty response",
          req.id
        );
        return { customText: "No UI channel was available." };
      }
      pushExternalEvent(rec, {
        type: "clarification_request",
        request: req,
      });
      const resp = await registerPendingClarification(req);
      pushExternalEvent(rec, {
        type: "clarification_resolved",
        id: req.id,
        requestId: req.requestId,
        selectedOptionId: resp.selectedOptionId,
        customText: resp.customText,
        resolvedBy: "user",
      });
      return resp;
    },
  });
  const goalExtension = createGoalExtension({
    getAgentId: () => id,
    getGoal,
    onGoalUpdate: (_agentId, input) => {
      // Route through the stop-time verifier. A rejected `complete` keeps the
      // goal active and returns a rejection note for the model.
      const result = applyGoalUpdate(id, input);
      const rec = recordHolder.current;
      if (rec && result.accepted) pushGoalEvent(rec, result.goal);
      return result;
    },
  });
  const progressExtension = createProgressExtension({
    getAgentId: () => id,
    onProgressUpdate: async (_agentId, input) => {
      const progress = updateProgress(id, input);
      // Bridge progress artifacts into goal evidence (only when a goal is
      // active). De-dupes by id, so repeated updates are safe.
      bridgeProgressEvidence(id, progress);
      const rec = recordHolder.current;
      if (rec) {
        try {
          await writePersistedProgress(rec.session.sessionId, progress);
        } catch {
          // Best-effort runtime cache; do not fail the tool call if persistence
          // is temporarily unavailable.
        }
        pushProgressEvent(rec, progress);
      }
      return progress;
    },
  });

  const browserExtension = createBrowserExtension({
    getAgentId: () => id,
    getAnnotationBrowserIds: () => {
      const rec = recordHolder.current;
      const sessionId = rec?.session.sessionId;
      return sessionId ? [standaloneBrowserId(`session:${sessionId}`)] : [];
    },
    onBrowserState: (snapshot) => {
      const rec = recordHolder.current;
      if (!rec) return;
      pushExternalEvent(rec, { type: "browser_state", snapshot });
    },
    // 阶段 E：外部站点首次访问 / 敏感动作走现有审批通道。
    // 子 agent（hidden、无可见 SSE 通道）不注入审批 → guardSite 默认拒绝外部站点，
    // 与"子 agent 不能随意访问外部站点"的安全语义一致。
    ...(opts.parentAgentId
      ? {}
      : {
          requestSiteApproval: (input) => requestBrowserSiteApproval(input),
          requestActionApproval: (input) =>
            requestBrowserActionApproval(input),
        }),
  });
  const clipboardExtension = createClipboardExtension();

  // S6：三个入口共用一套 deps（包括 worktrees + approval + resolveDefinition + mcp 范围）。
  const buildSubagentDeps = () => {
    const rec = recordHolder.current;
    if (!rec) throw new Error("agent record not ready");
    if (!rec.session.model) throw new Error("model not ready");
    return buildSubagentDepsForAgent(rec);
  };

  const delegateSubagentsTool = createDelegateSubagentsTool({
    onDelegate: async (input, signal) =>
      runSubagentBatch(buildSubagentDeps(), input, signal),
  });
  const dynamicWorkflowTool = createDynamicWorkflowTool({
    onRunWorkflow: async (input, signal) => {
      return runDynamicWorkflow(
        {
          runSubagents: (subagentInput, subagentSignal) =>
            runSubagentBatch(buildSubagentDeps(), subagentInput, subagentSignal),
        },
        input,
        signal
      );
    },
  });
  const workflowScriptTool = createWorkflowScriptTool({
    parentAgentId: () => recordHolder.current?.id,
    onRunWorkflow: async (input, signal) => {
      return runDynamicWorkflow(
        {
          runSubagents: (subagentInput, subagentSignal) =>
            runSubagentBatch(buildSubagentDeps(), subagentInput, subagentSignal),
        },
        input,
        signal
      );
    },
    onRunWorkflowScript: async (input, signal) => {
      const rec = recordHolder.current;
      if (!rec) throw new Error("agent record not ready");
      const model = rec.session.model;
      if (!model) throw new Error("model not ready");
      return runWorkflowScript(
        {
          parentAgentId: id,
          onEvent: (event) => pushExternalEvent(rec, event),
          approveCapability: (request) =>
            requestWorkflowCapabilityApproval(request),
          approveWorktreeMerge: (request) =>
            requestWorkflowWorktreeMergeApproval(request),
          approveNetworkRequest: (request) =>
            requestWorkflowNetworkApproval(request),
          approveMcpTool: (request) =>
            requestWorkflowMcpToolApproval(request),
          askUser: (request) => requestWorkflowUserClarification(request),
          worktrees: createGitWorktreeManager(opts.cwd),
          networkPolicy: getWorkflowNetworkPolicy(),
          // MCP for workflow scripts (workflow.listTools / callTool). The
          // workflow tool belongs to the main agent, so it may use all enabled
          // servers; the worker still goes through per-call approval above.
          allowedMcpServers: undefined,
          listMcpTools: async (serverId) => {
            const ids = serverId
              ? [serverId]
              : listEnabledMcpServers().map((s) => s.id);
            const out: Array<{
              serverId: string;
              name: string;
              description?: string;
              inputSchema?: Record<string, unknown>;
            }> = [];
            for (const sid of ids) {
              try {
                const tools = await listMcpToolsRuntime(sid);
                for (const t of tools) {
                  out.push({
                    serverId: t.serverId,
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema,
                  });
                }
              } catch {
                // skip a broken server (best-effort, never throw into worker)
              }
            }
            return out;
          },
          callMcpTool: async (callInput) => {
            const result = await callMcpToolRuntime(
              callInput.server,
              callInput.tool,
              callInput.input ?? {}
            );
            return {
              server: callInput.server,
              tool: callInput.tool,
              text: result.text,
              isError: result.isError,
            };
          },
          runSubagents: (subagentInput, subagentSignal) =>
            runSubagentBatch(buildSubagentDeps(), subagentInput, subagentSignal),
        },
        input,
        signal
      );
    },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: getAgentDir(),
    settingsManager: getSettingsManager(opts.cwd),
    appendSystemPromptOverride: (base) => [
      ...base,
      [
        "Response depth guideline:",
        "Be concise, but do not be terse. When a task involves analysis, tool results, implementation details, or user-facing decisions, provide enough substance for the user to understand the result without asking a follow-up. Prefer a short complete answer over a one-line answer.",
      ].join("\n"),
      [
        ...largeFileWriteProtocolLines(),
      ].join("\n"),
    ],
    extensionFactories: [
      createWriteTruncationRecoveryExtension(),
      ...(opts.parentAgentId
        ? [
            createSubagentWriteBoundaryExtension({
              cwd: opts.cwd,
              writePaths: opts.writePaths,
            }),
          ]
        : []),
      collabExtension,
      clarificationExtension,
      goalExtension,
      progressExtension,
      browserExtension,
      clipboardExtension,
    ],
  });
  await resourceLoader.reload();

  // Load MCP tools (Sprint 5). Best-effort: failures never block agent creation.
  // Main agent (mcpServers undefined) sees all enabled servers; child subagents
  // are scoped to their declared servers (or none).
  let mcpTools: ToolDefinition[] = [];
  try {
    mcpTools = await loadMcpToolDefinitions({
      allowedMcpServers: opts.mcpServers,
      rules: [],
      requestApproval: (params) => requestMcpToolApproval(params),
      onAudit: () => {},
    });
  } catch {
    mcpTools = [];
  }

  const baseCustomTools: ToolDefinition[] =
    opts.enableSubagents === false
      ? []
      : [
          delegateSubagentsTool as unknown as ToolDefinition,
          dynamicWorkflowTool as unknown as ToolDefinition,
          workflowScriptTool as unknown as ToolDefinition,
          // Progressive disclosure + reuse (Claude Code style): discover and
          // reuse saved templates/skills instead of regenerating large scripts.
          createListWorkflowTemplatesTool() as unknown as ToolDefinition,
          createListWorkflowSkillsTool() as unknown as ToolDefinition,
          createReadWorkflowResourceTool() as unknown as ToolDefinition,
          createSaveWorkflowSkillTool() as unknown as ToolDefinition,
          createListWorkflowScriptDraftsTool({
            parentAgentId: () => recordHolder.current?.id,
          }) as unknown as ToolDefinition,
          createReadWorkflowScriptDraftTool({
            parentAgentId: () => recordHolder.current?.id,
          }) as unknown as ToolDefinition,
          createSaveWorkflowScriptDraftTool({
            parentAgentId: () => recordHolder.current?.id,
          }) as unknown as ToolDefinition,
        ];
  const allCustomTools = [...baseCustomTools, ...mcpTools];

  // C-2: profile 的 reasoning 轴作为主 agent thinkingLevel 的「初始值」。
  // 优先级：调用方显式传入（用户在 Composer 选的）> profile.reasoning > "medium"。
  // 用户手动选择经 per-runner 更新生效，不走创建路径，因此不会被 profile 覆盖。
  // 子 agent（有 parentAgentId）保持各自 role 默认，不套用主 profile。
  let profileReasoning: import("./types").ThinkingLevel | undefined;
  if (!opts.thinkingLevel && !opts.parentAgentId) {
    try {
      const [{ getAgentProfilesSettings }, { resolveProfile }] =
        await Promise.all([
          import("./agent-profiles/settings"),
          import("./agent-profiles/resolve"),
        ]);
      const settings = await getAgentProfilesSettings();
      profileReasoning = resolveProfile(
        settings.defaultProfileId,
        settings
      ).defaults.reasoning;
    } catch {
      profileReasoning = undefined;
    }
  }

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    model,
    thinkingLevel: opts.thinkingLevel ?? profileReasoning ?? "medium",
    tools: opts.tools,
    excludeTools: opts.excludeTools,
    sessionManager,
    authStorage: getAuth(),
    modelRegistry: mr,
    resourceLoader,
    customTools: allCustomTools.length > 0 ? allCustomTools : undefined,
  });

  if (!opts.tools) {
    const available = new Set(session.getAllTools().map((tool) => tool.name));
    const active = new Set(session.getActiveToolNames());
    let changed = false;
    for (const name of DEFAULT_BROWSER_TOOL_NAMES) {
      if (available.has(name) && !active.has(name)) {
        active.add(name);
        changed = true;
      }
    }
    if (changed) session.setActiveToolsByName(Array.from(active));
  }

  const record: AgentRecord = {
    id,
    session,
    cwd: opts.cwd,
    parentAgentId: opts.parentAgentId,
    childRole: opts.childRole,
    hidden: opts.hidden,
    events: new Array(MAX_EVENTS_PER_AGENT),
    nextSeq: 0,
    listeners: new Set(),
    unsubscribe: () => {},
    isStreaming: false,
    updatedAt: Date.now(),
    lastAgentEndAt: null,
    recentClientRequests: new Map(),
    finishWatchdog: null,
    pendingFinishMessage: null,
    toolWatchdog: null,
    pendingToolCall: null,
  };
  // 让 CollabExtension 的闭包能 push 自定义事件（approval_request/resolved）
  recordHolder.current = record;

  // 把 AgentSession 的事件流接到 ring buffer + 通知 listeners
  record.unsubscribe = session.subscribe((event) => {
    // 维护"是否正在跑"flag —— sidebar 状态点直接读它
    if (event.type === "agent_start") {
      clearFinishWatchdog(record);
      clearToolWatchdog(record);
      record.isStreaming = true;
      record.updatedAt = Date.now();
      // Open a goal turn when this run is driving an active goal. Records turn
      // history so a long goal's progress survives restart (M2).
      const goal = getGoal(record.id);
      if (goal && goal.status === "active") {
        startGoalTurn(record.id);
      }
    } else if (event.type === "tool_execution_start") {
      clearFinishWatchdog(record);
      scheduleToolWatchdog(record, event);
    } else if (event.type === "tool_execution_update") {
      scheduleToolWatchdog(record, event);
    } else if (event.type === "tool_execution_end") {
      clearToolWatchdog(record);
    } else if (event.type === "message_end") {
      clearToolWatchdog(record);
      scheduleFinishWatchdog(record, event.message);
    } else if (event.type === "agent_end") {
      clearFinishWatchdog(record);
      clearToolWatchdog(record);
      finishStreamingRun(record);
      record.updatedAt = Date.now();
    }
    pushAgentEvent(record, event);
  });

  reg.agents.set(id, record);

  // G2：让 goal store 能按 sessionId 反查。重启后 UI 拿到新 agentId，
  // 服务端仍能从老 envelope 里调出 goal。
  try {
    bindGoalSession(id, session.sessionId, session.sessionFile);
  } catch {
    // best-effort
  }

  return {
    id,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
  };
}

export function getAgent(id: string): AgentRecord | undefined {
  return reg.agents.get(id);
}

/**
 * S1：独立于 createAgent 闭包的子 agent worktree merge 审批。
 * retry/resume 路由复用，以便重试/恢复时 specialist 要求的 isolation 与首走一致。
 */
export async function requestSubagentWorktreeMergeApprovalFor(
  rec: AgentRecord,
  params: {
    taskId: string;
    title: string;
    worktree: { id: string; path: string; branchName: string; baseRef: string };
    diff: { stat: string; diff: string };
  }
): Promise<{ decision: "allow" | "deny"; denyReason?: string }> {
  const toolCallId = `subagent-merge:${params.taskId}:${params.worktree.id}`;
  const req = {
    id: `${rec.id}:${toolCallId}`,
    agentId: rec.id,
    toolCallId,
    toolName: "subagent:merge_worktree",
    input: {
      taskId: params.taskId,
      title: params.title,
      worktree: params.worktree,
      stat: params.diff.stat,
      diffPreview: params.diff.diff.slice(0, 12000),
      truncated: params.diff.diff.length > 12000,
    },
    reason: "manual" as const,
    ruleId: "subagent-merge-worktree",
    defaultDecision: "deny" as const,
    createdAt: Date.now(),
  };
  pushExternalEvent(rec, { type: "approval_request", request: req });
  const resp = await registerPendingApproval(req);
  const resolvedBy: ApprovalResolvedEvent["resolvedBy"] =
    resp.denyReason === undefined && resp.decision === req.defaultDecision
      ? "timeout"
      : "user";
  pushExternalEvent(rec, {
    type: "approval_resolved",
    id: req.id,
    toolCallId: req.toolCallId,
    decision: resp.decision,
    resolvedBy,
    denyReason: resp.denyReason,
  });
  return resp;
}

export async function requestWorkflowWorktreeMergeApprovalFor(
  rec: AgentRecord,
  params: {
    workflowId: string;
    objective: string;
    rationale: string;
    manifest: unknown;
    worktree: { id: string; path: string; branchName: string; baseRef: string };
    diff: {
      stat: string;
      diff: string;
      path?: string;
      branchName?: string;
      baseRef?: string;
    };
  }
): Promise<{ decision: "allow" | "deny"; denyReason?: string }> {
  const toolCallId = `workflow-merge:${params.workflowId}:${params.worktree.id}`;
  const req = {
    id: `${rec.id}:${toolCallId}`,
    agentId: rec.id,
    toolCallId,
    toolName: "workflow:merge_worktree",
    input: {
      workflowId: params.workflowId,
      objective: params.objective,
      rationale: params.rationale,
      manifest: params.manifest,
      worktree: params.worktree,
      stat: params.diff.stat,
      diffPreview: params.diff.diff.slice(0, 12000),
      truncated: params.diff.diff.length > 12000,
    },
    reason: "manual" as const,
    ruleId: "workflow-merge-worktree",
    defaultDecision: "deny" as const,
    createdAt: Date.now(),
  };
  pushExternalEvent(rec, { type: "approval_request", request: req });
  const resp = await registerPendingApproval(req);
  const resolvedBy: ApprovalResolvedEvent["resolvedBy"] =
    resp.denyReason === undefined && resp.decision === req.defaultDecision
      ? "timeout"
      : "user";
  pushExternalEvent(rec, {
    type: "approval_resolved",
    id: req.id,
    toolCallId: req.toolCallId,
    decision: resp.decision,
    resolvedBy,
    denyReason: resp.denyReason,
  });
  return resp;
}

/**
 * S1 / S6：构造 retry/resume 与 workflow 内部 runSubagents 都能复用的 deps，
 * 包括 resolveDefinition + worktrees + merge approval，保证“二次入口”的能力与首走一致。
 */
export function buildSubagentDepsForAgent(
  rec: AgentRecord
): {
  parentAgentId: string;
  parentSessionPath?: string;
  provider: string;
  modelId: string;
  cwd: string;
  thinkingLevel?: import("./types").ThinkingLevel;
  createChild: typeof createAgent;
  getChild: typeof getAgent;
  disposeChild: typeof disposeAgent;
  pushParentEvent: (event: SubagentEvent) => void;
  resolveDefinition: (sid: string) => ReturnType<typeof getDefinition>;
  worktrees: ReturnType<typeof createGitWorktreeManager>;
  approveSubagentMerge: (params: {
    taskId: string;
    title: string;
    worktree: { id: string; path: string; branchName: string; baseRef: string };
    diff: { stat: string; diff: string };
  }) => Promise<{ decision: "allow" | "deny"; denyReason?: string }>;
} {
  const model = rec.session.model;
  if (!model) throw new Error("agent model not ready");
  return {
    parentAgentId: rec.id,
    parentSessionPath: rec.session.sessionFile,
    provider: model.provider,
    modelId: model.id,
    cwd: rec.cwd,
    thinkingLevel: rec.session.thinkingLevel,
    createChild: createAgent,
    getChild: getAgent,
    disposeChild: disposeAgent,
    pushParentEvent: (event) => pushExternalEvent(rec, event),
    resolveDefinition: (sid) => getDefinition(rec.cwd, sid),
    worktrees: createGitWorktreeManager(rec.cwd),
    approveSubagentMerge: (params) =>
      requestSubagentWorktreeMergeApprovalFor(rec, params),
  };
}

/**
 * 返回当前所有 active AgentSession 的 sessionFile 路径集合。
 * 给前端 sidebar 标"运行中"用 —— sessionFile 与 SessionInfo.path 一致。
 */
export function getRunningSessionFiles(): Set<string> {
  const out = new Set<string>();
  for (const rec of reg.agents.values()) {
    if (rec.hidden) continue;
    if (!rec.isStreaming) continue;
    const f = rec.session.sessionFile;
    if (f) out.add(f);
  }
  return out;
}

export async function abortSubagentsForParent(parentAgentId: string): Promise<void> {
  // S8：传 pushParentEvent，让 abort 后能同步 push subagent_task_end / subagent_batch_end，
  // 前端卡片不会除 batch.status 之外还反复转圈。
  const rec = reg.agents.get(parentAgentId);
  await abortRunningSubagentBatches(
    parentAgentId,
    getAgent,
    rec ? (event) => pushExternalEvent(rec, event) : undefined
  );
}

export async function abortWorkflowsForParent(parentAgentId: string): Promise<void> {
  await abortRunningWorkflows(parentAgentId);
}

export function finishStreamingAfterPromptError(agentId: string): void {
  const rec = reg.agents.get(agentId);
  if (!rec) return;
  forceFinishStream(rec, {
    reason: "prompt_error",
    goalStatus: "failed",
    blockedReason: "Prompt failed before the agent produced a terminal event.",
    pushAgentEnd: true,
  });
}

export function finishStreamingAfterAbort(agentId: string): void {
  const rec = reg.agents.get(agentId);
  if (!rec) return;
  forceFinishStream(rec, {
    reason: "user_abort",
    goalStatus: "failed",
    blockedReason: "Run was aborted by the user.",
    pushAgentEnd: true,
  });
}

export async function retryWorkflowScriptForParent(
  parentAgentId: string,
  workflowId: string
) {
  const rec = reg.agents.get(parentAgentId);
  if (!rec) throw new Error("agent not found");
  const workflow = getWorkflowRun(workflowId);
  if (!workflow || workflow.parentAgentId !== parentAgentId) {
    throw new Error("workflow not found");
  }
  if (workflow.status === "running") {
    throw new Error("workflow is still running");
  }
  return runWorkflowScript(
    {
      parentAgentId,
      onEvent: (event) => pushExternalEvent(rec, event),
      approveCapability: async () => ({ decision: "allow" }),
      approveWorktreeMerge: (request) =>
        requestWorkflowWorktreeMergeApprovalFor(rec, request),
      approveNetworkRequest: async () => ({ decision: "allow" }),
      approveMcpTool: async () => ({ decision: "allow" }),
      askUser: async (request) => ({
        requestId: `${request.workflowId}:manual-retry-ask-user`,
        customText:
          "Workflow retry cannot ask follow-up questions from this direct retry path.",
        answer:
          "Workflow retry cannot ask follow-up questions from this direct retry path.",
      }),
      worktrees: createGitWorktreeManager(rec.cwd),
      networkPolicy: getWorkflowNetworkPolicy(),
      allowedMcpServers: undefined,
      listMcpTools: async (serverId) => {
        const ids = serverId
          ? [serverId]
          : listEnabledMcpServers().map((s) => s.id);
        const out: Array<{
          serverId: string;
          name: string;
          description?: string;
          inputSchema?: Record<string, unknown>;
        }> = [];
        for (const sid of ids) {
          try {
            const tools = await listMcpToolsRuntime(sid);
            for (const t of tools) {
              out.push({
                serverId: t.serverId,
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              });
            }
          } catch {
            // best effort
          }
        }
        return out;
      },
      callMcpTool: async (callInput) => {
        const result = await callMcpToolRuntime(
          callInput.server,
          callInput.tool,
          callInput.input ?? {}
        );
        return {
          server: callInput.server,
          tool: callInput.tool,
          text: result.text,
          isError: result.isError,
        };
      },
      runSubagents: (subagentInput, subagentSignal) =>
        runSubagentBatch(buildSubagentDepsForAgent(rec), subagentInput, subagentSignal),
    },
    {
      objective: workflow.objective,
      rationale: `Manual retry of workflow ${workflow.id}: ${workflow.rationale}`,
      script: workflow.script,
      capabilities: workflow.manifest.capabilities,
      maxAgents: workflow.manifest.maxAgents,
      maxConcurrency: workflow.manifest.maxConcurrency,
      successCriteria: workflow.manifest.successCriteria,
    }
  );
}

export async function disposeAgent(id: string): Promise<void> {
  const rec = reg.agents.get(id);
  if (!rec) return;
  if (!rec.hidden) {
    await Promise.allSettled([
      abortSubagentsForParent(id),
      abortWorkflowsForParent(id),
    ]);
  }
  clearFinishWatchdog(rec);
  clearToolWatchdog(rec);
  // M5：标记已 dispose 并唤醒仍挂着的 SSE listeners，让它们立即结束流，而不是
  // 等浏览器 close 才触发 abort。listener 回调里会看到 rec.disposed 为 true。
  rec.disposed = true;
  for (const l of rec.listeners) {
    try {
      l();
    } catch {
      // 单个 listener 抛错不影响其余
    }
  }
  rec.unsubscribe();
  rec.session.dispose();
  reg.agents.delete(id);
  releaseManagersForCwdIfUnused(rec.cwd);
  // 清理 per-agent 的全局 store，避免长期运行进程内存越爷越大。
  clearSessionRemember(id);
  clearAgentClarifications(id);
  clearGoal(id);
  clearProgress(id);
  // runtime/event-store + evidence/server-store 是跨 agent 共享 Map，
  // 按 agentId 扫一遍释放。dispose 是低频操作，O(N) 扫可接受。
  disposeRuntimeEventsForAgent(id);
  disposeEvidenceForAgent(id);
  void disposeBrowser(agentBrowserId(id));
}

/**
 * M5：给 SSE 路由用——agent 是否已被 dispose（或根本不存在）。
 * 已 dispose 的流应主动结束，避免连接泄漏到浏览器 close 才回收。
 */
export function isAgentDisposed(agentId: string): boolean {
  const rec = reg.agents.get(agentId);
  return !rec || rec.disposed === true;
}

/** 给 SSE 用：拿从某个 seq 之后的所有事件（按 seq 升序） */
export function getEventsSince(
  agentId: string,
  sinceSeq: number
): Array<{ seq: number; event: RingBufferEvent }> {
  const rec = reg.agents.get(agentId);
  if (!rec) return [];
  // ring buffer 物理顺序≠seq 顺序（环到头会从下标 0 重新覆盖）。
  // 遍历整个 buffer，跳过 undefined 与 seq<=since 的项；最后按 seq 升序排。
  // 一次回放最多 MAX_EVENTS_PER_AGENT 条，sort 成本可接受。
  const out: Array<{ seq: number; event: RingBufferEvent }> = [];
  for (const e of rec.events) {
    if (e && e.seq > sinceSeq) out.push(e);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export function getLatestEventSeq(agentId: string): number {
  const rec = reg.agents.get(agentId);
  return rec ? rec.nextSeq - 1 : -1;
}

/**
 * 返回 ring buffer 中当前仍可访问的最早 seq。这个值决定 SSE 重连时
 * since 是否过期；since < earliestSeq 意味着这些事件已被覆盖，需要让
 * client 丢掉本地状态、重新拉全量。
 */
export function getEarliestEventSeq(agentId: string): number {
  const rec = reg.agents.get(agentId);
  if (!rec) return -1;
  // ring buffer 未满：物理 0..nextSeq-1 全部可访问。
  if (rec.nextSeq <= MAX_EVENTS_PER_AGENT) return 0;
  // 已满 → 最早可访问的 seq = nextSeq - MAX_EVENTS_PER_AGENT。
  return rec.nextSeq - MAX_EVENTS_PER_AGENT;
}

/** 注册一个事件监听器（用于 SSE 长连接），返回取消函数 */
export function onNewEvent(agentId: string, cb: () => void): () => void {
  const rec = reg.agents.get(agentId);
  if (!rec) return () => {};
  rec.listeners.add(cb);
  return () => {
    rec.listeners.delete(cb);
  };
}

export { getAgentDir };

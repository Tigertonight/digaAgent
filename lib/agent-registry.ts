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
import os from "node:os";
import { createCollabExtension } from "./collab/extension";
import { createClarificationExtension } from "./clarification/extension";
import { createBrowserExtension } from "./browser/extension";
import { disposeBrowser } from "./browser/runtime";
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
} from "./workflows/extension";
import { runDynamicWorkflow } from "./workflows/orchestrator";
import { runWorkflowScript } from "./workflows/script-runtime";
import { abortRunningWorkflows } from "./workflows/server-store";
import { createGitWorktreeManager } from "./workflows/git-worktree";
import { getWorkflowNetworkPolicy } from "./workflows/network-policy";
import { DEFAULT_RULES } from "./collab/rules";
import {
  clearSessionRemember,
  hasSessionRemember,
  listPendingApprovals,
  registerPendingApproval,
} from "./collab/server-store";
import {
  clearAgentClarifications,
  listPendingClarifications,
  registerPendingClarification,
} from "./clarification/server-store";
import {
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
import { updateProgress } from "./progress/server-store";
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
  | ProgressUpdatedEvent;

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
  /** 用来在 dispose 时取消订阅 */
  unsubscribe: () => void;
  /** 当前是否在跑(agent_start/end 之间为 true);给 sidebar 标"运行中"用 */
  isStreaming: boolean;
  /** local shim 可能给完整 assistant 内容但漏掉 done/end，用 watchdog 兜底收尾 */
  finishWatchdog: ReturnType<typeof setTimeout> | null;
  pendingFinishMessage: unknown | null;
}

const MAX_EVENTS_PER_AGENT = 5000;
const FINISH_WATCHDOG_MS = 1800;
const DEFAULT_BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_screenshot",
  "browser_click",
  "browser_click_text",
  "browser_fill",
  "browser_type",
  "browser_search",
  "browser_wait",
  "browser_extract",
  "browser_verify",
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

const g = globalThis as unknown as { __miniPi?: GlobalRegistry };
if (!g.__miniPi) {
  g.__miniPi = { agents: new Map() };
}
const reg = g.__miniPi!;

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

function buildGoalContinuationPrompt(goal: AgentGoal, recap?: string): string {
  return [
    "Continue working toward the active goal:",
    "",
    goal.objective,
    ...(recap && recap.trim()
      ? ["", "Context from previous turns (do not repeat finished work):", recap]
      : []),
    "",
    "Do the next useful step. If the full goal is achieved, call goal_update with status=complete.",
    "Keep the user-visible progress current with update_progress when steps start, finish, block, or produce evidence artifacts.",
    "If you are truly blocked and cannot make meaningful progress without user input or an external change, call goal_update with status=blocked and include a short blockedReason.",
    "Otherwise continue implementation, verification, or investigation. Keep the user informed with concise progress.",
  ].join("\n");
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
      pauseReason: "Waiting for user input.",
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
    void rec.session.prompt(buildGoalContinuationPrompt(latest, recap)).catch((e) => {
      const paused = setGoalStatus(rec.id, "paused", {
        pauseReason: e instanceof Error ? e.message : "Goal continuation failed.",
      });
      pushGoalEvent(rec, paused);
    });
  }, 200);
}

function pushAgentEvent(rec: AgentRecord, event: RingBufferEvent): void {
  const seq = rec.nextSeq++;
  rec.events[seq % MAX_EVENTS_PER_AGENT] = { seq, event };
  for (const l of rec.listeners) l();
}

function messageHasStopReason(event: unknown): event is { message: unknown } {
  if (!event || typeof event !== "object") return false;
  const e = event as {
    message?: { role?: string; stopReason?: unknown };
    assistantMessageEvent?: { partial?: { role?: string; stopReason?: unknown } };
  };
  const msg = e.message ?? e.assistantMessageEvent?.partial;
  return msg?.role === "assistant" && typeof msg.stopReason === "string";
}

function messageContainsToolCall(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "toolCall"
  );
}

function clearFinishWatchdog(rec: AgentRecord) {
  if (rec.finishWatchdog) {
    clearTimeout(rec.finishWatchdog);
    rec.finishWatchdog = null;
  }
  rec.pendingFinishMessage = null;
}

function scheduleFinishWatchdog(rec: AgentRecord, message: unknown) {
  if (messageContainsToolCall(message)) {
    // Tool-call turns are not complete at the first assistant message: the SDK
    // still needs to execute the tool, append a tool result, and continue the
    // conversation. Aborting here cuts off custom tools such as
    // delegate_subagents before they can run.
    return;
  }
  rec.pendingFinishMessage = message;
  if (rec.finishWatchdog) clearTimeout(rec.finishWatchdog);
  rec.finishWatchdog = setTimeout(() => {
    rec.finishWatchdog = null;
    const finalMessage = rec.pendingFinishMessage;
    rec.pendingFinishMessage = null;
    if (!rec.isStreaming || !finalMessage) return;

    // Some OpenAI-compatible local shims return a full assistant message with
    // stopReason but never emit the provider's final done event. The SDK then
    // stays streaming forever. Close the UI turn and abort the dangling run.
    void rec.session.abort().catch(() => {});
    pushAgentEvent(rec, {
      type: "message_end",
      message: finalMessage,
    } as AgentSessionEvent);
    pushAgentEvent(rec, {
      type: "queue_update",
      steering: [],
      followUp: [],
    } as AgentSessionEvent);
    rec.isStreaming = false;
    pushAgentEvent(rec, { type: "agent_end" } as AgentSessionEvent);
  }, FINISH_WATCHDOG_MS);
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
  /** Main agents enable delegate_subagents; child subagents disable it to avoid recursion. */
  enableSubagents?: boolean;
  /**
   * MCP server scope (Sprint 5). undefined = main agent (all enabled servers);
   * a list = specialist scope (only those servers); [] = no MCP tools.
   */
  mcpServers?: string[];
}

export async function createAgent(opts: CreateOptions): Promise<{
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

  async function requestSubagentWorktreeMergeApproval(params: {
    taskId: string;
    title: string;
    worktree: { id: string; path: string; branchName: string; baseRef: string };
    diff: { stat: string; diff: string };
  }) {
    const rec = recordHolder.current;
    if (!rec) {
      return {
        decision: "deny" as const,
        denyReason: "No UI approval channel was available.",
      };
    }
    const toolCallId = `subagent-merge:${params.taskId}:${params.worktree.id}`;
    const req = {
      id: `${id}:${toolCallId}`,
      agentId: id,
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
    onProgressUpdate: (_agentId, input) => {
      const progress = updateProgress(id, input);
      // Bridge progress artifacts into goal evidence (only when a goal is
      // active). De-dupes by id, so repeated updates are safe.
      bridgeProgressEvidence(id, progress);
      const rec = recordHolder.current;
      if (rec) pushProgressEvent(rec, progress);
      return progress;
    },
  });

  const browserExtension = createBrowserExtension({
    getAgentId: () => id,
    onBrowserState: (snapshot) => {
      const rec = recordHolder.current;
      if (!rec) return;
      pushExternalEvent(rec, { type: "browser_state", snapshot });
    },
  });
  const clipboardExtension = createClipboardExtension();
  const delegateSubagentsTool = createDelegateSubagentsTool({
    onDelegate: async (input, signal) => {
      const rec = recordHolder.current;
      if (!rec) throw new Error("agent record not ready");
      const model = rec.session.model;
      if (!model) throw new Error("model not ready");
      return runSubagentBatch(
        {
          parentAgentId: id,
          parentSessionPath: rec.session.sessionFile,
          provider: model.provider,
          modelId: model.id,
          cwd: opts.cwd,
          thinkingLevel: rec.session.thinkingLevel,
          createChild: createAgent,
          getChild: getAgent,
          disposeChild: disposeAgent,
          pushParentEvent: (event) => pushExternalEvent(rec, event),
          resolveDefinition: (sid) => getDefinition(opts.cwd, sid),
          worktrees: createGitWorktreeManager(opts.cwd),
          approveSubagentMerge: (params) =>
            requestSubagentWorktreeMergeApproval({
              taskId: params.taskId,
              title: params.title,
              worktree: params.worktree,
              diff: params.diff,
            }),
        },
        input,
        signal
      );
    },
  });
  const dynamicWorkflowTool = createDynamicWorkflowTool({
    onRunWorkflow: async (input, signal) => {
      const rec = recordHolder.current;
      if (!rec) throw new Error("agent record not ready");
      const model = rec.session.model;
      if (!model) throw new Error("model not ready");
      return runDynamicWorkflow(
        {
          runSubagents: (subagentInput, subagentSignal) =>
            runSubagentBatch(
              {
                parentAgentId: id,
                parentSessionPath: rec.session.sessionFile,
                provider: model.provider,
                modelId: model.id,
                cwd: opts.cwd,
                thinkingLevel: rec.session.thinkingLevel,
                createChild: createAgent,
                getChild: getAgent,
                disposeChild: disposeAgent,
                pushParentEvent: (event) => pushExternalEvent(rec, event),
                resolveDefinition: (sid) => getDefinition(opts.cwd, sid),
              },
              subagentInput,
              subagentSignal
            ),
        },
        input,
        signal
      );
    },
  });
  const workflowScriptTool = createWorkflowScriptTool({
    onRunWorkflow: async (input, signal) => {
      const rec = recordHolder.current;
      if (!rec) throw new Error("agent record not ready");
      const model = rec.session.model;
      if (!model) throw new Error("model not ready");
      return runDynamicWorkflow(
        {
          runSubagents: (subagentInput, subagentSignal) =>
            runSubagentBatch(
              {
                parentAgentId: id,
                parentSessionPath: rec.session.sessionFile,
                provider: model.provider,
                modelId: model.id,
                cwd: opts.cwd,
                thinkingLevel: rec.session.thinkingLevel,
                createChild: createAgent,
                getChild: getAgent,
                disposeChild: disposeAgent,
                pushParentEvent: (event) => pushExternalEvent(rec, event),
                resolveDefinition: (sid) => getDefinition(opts.cwd, sid),
              },
              subagentInput,
              subagentSignal
            ),
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
            runSubagentBatch(
              {
                parentAgentId: id,
                parentSessionPath: rec.session.sessionFile,
                provider: model.provider,
                modelId: model.id,
                cwd: opts.cwd,
                thinkingLevel: rec.session.thinkingLevel,
                createChild: createAgent,
                getChild: getAgent,
                disposeChild: disposeAgent,
                pushParentEvent: (event) => pushExternalEvent(rec, event),
                resolveDefinition: (sid) => getDefinition(opts.cwd, sid),
              },
              subagentInput,
              subagentSignal
            ),
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
    ],
    extensionFactories: [
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
        ];
  const allCustomTools = [...baseCustomTools, ...mcpTools];

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    model,
    thinkingLevel: opts.thinkingLevel ?? "medium",
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
    finishWatchdog: null,
    pendingFinishMessage: null,
  };
  // 让 CollabExtension 的闭包能 push 自定义事件（approval_request/resolved）
  recordHolder.current = record;

  // 把 AgentSession 的事件流接到 ring buffer + 通知 listeners
  record.unsubscribe = session.subscribe((event) => {
    // 维护"是否正在跑"flag —— sidebar 状态点直接读它
    if (event.type === "agent_start") {
      clearFinishWatchdog(record);
      record.isStreaming = true;
      // Open a goal turn when this run is driving an active goal. Records turn
      // history so a long goal's progress survives restart (M2).
      const goal = getGoal(record.id);
      if (goal && goal.status === "active") {
        startGoalTurn(record.id);
      }
    } else if (event.type === "message_end" || event.type === "agent_end") {
      clearFinishWatchdog(record);
      if (event.type === "agent_end") {
        record.isStreaming = false;
        // Close the open goal turn before deciding whether to auto-continue. The
        // goal's terminal status (complete/blocked) maps onto the turn status.
        const goal = getGoal(record.id);
        if (goal) {
          const turnStatus =
            goal.status === "complete"
              ? "completed"
              : goal.status === "blocked"
                ? "blocked"
                : "completed";
          finishGoalTurn(record.id, {
            status: turnStatus,
            ...(goal.status === "blocked" && goal.blockedReason
              ? { blockedReason: goal.blockedReason }
              : {}),
          });
        }
        maybeContinueGoal(record);
      }
    } else if (messageHasStopReason(event)) {
      // Do not synthesize completion from partial assistant messages. For
      // OpenAI-compatible tool-call turns the SDK emits stopReason-bearing
      // partials before tool execution; closing the turn here prevents custom
      // tools from ever running. Providers that correctly send a final DONE
      // event are handled by the normal message_end/agent_end path.
    }
    pushAgentEvent(record, event);
  });

  reg.agents.set(id, record);

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
  await abortRunningSubagentBatches(parentAgentId, getAgent);
}

export async function abortWorkflowsForParent(parentAgentId: string): Promise<void> {
  await abortRunningWorkflows(parentAgentId);
}

export function disposeAgent(id: string) {
  const rec = reg.agents.get(id);
  if (!rec) return;
  if (!rec.hidden) {
    void abortSubagentsForParent(id).catch(() => undefined);
    void abortWorkflowsForParent(id).catch(() => undefined);
  }
  clearFinishWatchdog(rec);
  rec.unsubscribe();
  rec.session.dispose();
  reg.agents.delete(id);
  // B4：清理"本 session 不再问"记忆，避免悬挂（其他 agentId 复用同 globalThis store 不受影响）
  clearSessionRemember(id);
  clearAgentClarifications(id);
  clearGoal(id);
  void disposeBrowser(id);
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

import "server-only";
import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  getBatch,
  getTaskStatus,
  listRunningBatches,
  putBatch,
  updateBatch,
  updateBatchStatus,
  updateTask,
} from "./server-store";
import type {
  CreatedChildAgent,
  CreateChildAgentOptions,
  DelegateSubagentsInput,
  SubagentBatch,
  SubagentBatchPlan,
  SubagentBatchSynthesis,
  SubagentBatchStatus,
  SubagentBatchVerification,
  SubagentAuditEvent,
  SubagentEvent,
  SubagentResult,
  SubagentRole,
  SubagentTask,
  SubagentTaskAttempt,
  SubagentTaskVerification,
  SubagentTaskRuntime,
} from "./types";
import type { ThinkingLevel } from "@/lib/types";
import type { SubagentDefinition } from "./definition";
import { resolveSubagentModel, resolveSubagentPermission } from "./policy";
import {
  getSubagentMemory,
  renderMemoryForPrompt,
} from "./memory";
import { resolveIsolationBaseRef, resolveIsolationMode } from "./isolation";
import { runSubagentStartHook, runSubagentStopHook } from "./hooks";
import type { WorkflowWorktree, WorkflowWorktreeManager } from "@/lib/workflows/types";
import type { ApprovalResponse } from "@/lib/collab/types";
import { readMeta, writeMeta } from "@/lib/meta/store";
import { largeFileWriteProtocolLines } from "@/lib/tool-recovery/truncated-write";
import { RUNTIME_LIMITS } from "@/lib/shared/runtime-limits";

const DEFAULT_MAX_TASKS = 8;
const EXPLICIT_MAX_TASKS = 32;
const DEFAULT_CONCURRENCY = RUNTIME_LIMITS.subagentMaxConcurrency;
const DEFAULT_MAX_TURNS = RUNTIME_LIMITS.subagentDefaultMaxTurns;
/** 单任务超时上限（也是默认值）。集中到 RUNTIME_LIMITS，支持 env 覆盖。 */
const taskTimeoutMs = (): number => RUNTIME_LIMITS.subagentTaskTimeoutMs();
const WRITE_TOOL_PATTERN = /write|edit|patch|apply|delete|move|rename|mkdir|touch/i;
const MAX_AUDIT_EVENTS = 200;

interface ChildAgentRecord {
  id: string;
  session: {
    sessionFile: string | undefined;
    prompt(text: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
    subscribe(listener: (event: AgentSessionEvent) => void): () => void;
    getSessionStats?: () => {
      userMessages?: number;
      assistantMessages?: number;
      cost?: number;
      tokens?: {
        input?: number;
        output?: number;
      };
    };
  };
}

export interface RunSubagentBatchDeps {
  parentAgentId: string;
  parentSessionPath?: string;
  provider: string;
  modelId: string;
  cwd: string;
  thinkingLevel?: ThinkingLevel;
  createChild: (opts: CreateChildAgentOptions) => Promise<CreatedChildAgent>;
  getChild: (agentId: string) => ChildAgentRecord | undefined;
  disposeChild?: (agentId: string) => void;
  pushParentEvent: (event: SubagentEvent) => void;
  /**
   * Resolve a registered specialist definition by id (Sprint 2). Optional: when
   * absent or returning null, tasks run with the legacy role-based behavior so
   * existing delegations are unaffected (修正 5).
   */
  resolveDefinition?: (id: string) => SubagentDefinition | null;
  /**
   * Git worktree manager for isolated implementation subagents (Sprint 3).
   * Optional: without it, isolation requests fall back to non-isolated runs.
   */
  worktrees?: WorkflowWorktreeManager;
  /**
   * Request user approval before merging an isolated worktree's diff (Sprint 3).
   * Without it, isolated diffs are NOT merged (discarded) for safety.
   */
  approveSubagentMerge?: (params: {
    taskId: string;
    title: string;
    worktree: WorkflowWorktree;
    diff: { stat: string; diff: string };
  }) => Promise<ApprovalResponse>;
}

interface RunningBatchController {
  childAgentIds: Set<string>;
  abortController: AbortController;
  /**
   * A2-1：batch_end 仅 push 一次。abort 路径在收尾后置 true；worker fn finally
   * 走到 push 之前看到 true 则跳过，避免 UI 卡片接连看到两次 batch_end。
   */
  endedPushed?: boolean;
}

const runningControllers = new Map<string, RunningBatchController>();
const runningByParent = new Map<string, Set<string>>();

function normalizeRole(role: SubagentTask["role"]): SubagentRole {
  return role ?? "general";
}

function defaultToolsForRole(role: SubagentRole): string[] {
  switch (role) {
    case "code-review":
    case "rag":
    case "research":
    case "general":
      return ["read", "grep", "find", "ls"];
    case "implementation":
      // MVP keeps implementation subagents read-only unless caller explicitly
      // supplies allowedTools. This avoids parallel write conflicts.
      return ["read", "grep", "find", "ls"];
  }
}

function isWriteCapableTool(tool: string): boolean {
  return WRITE_TOOL_PATTERN.test(tool);
}

function sanitizeAllowedTools(tools: string[] | undefined): string[] | undefined {
  const normalized = tools
    ?.map((tool) => tool.trim())
    .filter(Boolean)
    .slice(0, 24);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function sanitizeWritePaths(paths: string[] | undefined): string[] | undefined {
  const normalized = paths
    ?.map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !item.includes("\0"))
    .slice(0, 16)
    .map((item) => item.slice(0, 500));
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function sanitizeTaskTimeoutMs(raw: number | undefined): number {
  const max = taskTimeoutMs();
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return max;
  }
  // 支持调小：caller 可以指定一个更短的超时；超过上限则 clamp 到上限。
  return Math.min(Math.floor(raw), max);
}

function sanitizeTask(raw: SubagentTask, index: number): SubagentTaskRuntime {
  const id = raw.id?.trim() || `task-${index + 1}`;
  const requestedTools = sanitizeAllowedTools(raw.allowedTools);
  const writePaths = sanitizeWritePaths(raw.writePaths);
  // S2 + S3：worktree 隔离下不剖写工具。是否 worktree 以 task / 后面的 specialist
  // 为准；sanitize 阶段只能看到 task。后续 orchestrator 会以 isolationMode 作为权威。
  const isolatedFromTask = raw.isolation === "worktree";
  const allowedTools = isolatedFromTask
    ? requestedTools
    : requestedTools && writePaths?.length
      ? requestedTools
      : requestedTools?.filter((tool) => !isWriteCapableTool(tool));
  const specialistId = raw.specialistId?.trim().slice(0, 80) || undefined;
  return {
    id: id.slice(0, 80),
    title: (raw.title?.trim() || id || `Task ${index + 1}`).slice(0, 120),
    prompt: raw.prompt.trim().slice(0, 12000),
    role: normalizeRole(raw.role),
    specialistId,
    isolation:
      raw.isolation === "none" || raw.isolation === "worktree"
        ? raw.isolation
        : undefined,
    cwd: raw.cwd,
    allowedTools,
    writePaths,
    maxTurns: raw.maxTurns ?? DEFAULT_MAX_TURNS,
    timeoutMs: sanitizeTaskTimeoutMs(raw.timeoutMs),
    status: "pending",
  };
}

export function validateDelegateInput(input: DelegateSubagentsInput): {
  reason: string;
  tasks: SubagentTaskRuntime[];
  concurrency: number;
  synthesisInstructions?: string;
  planning: SubagentBatchPlan;
} {
  const reason = input.reason?.trim().slice(0, 1000);
  if (!reason) throw new Error("delegate_subagents requires a reason");
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new Error("delegate_subagents requires at least one task");
  }
  const maxTasks = input.tasks.length > DEFAULT_MAX_TASKS ? EXPLICIT_MAX_TASKS : DEFAULT_MAX_TASKS;
  const tasks = input.tasks
    .slice(0, maxTasks)
    .map(sanitizeTask)
    .filter((task) => task.prompt.length > 0);
  if (tasks.length === 0) {
    throw new Error("delegate_subagents tasks must include non-empty prompts");
  }
  // S7：duplicate task id 提前拒绝。模型偶尔会为两个任务写同个 id（例如
  // 都叫 "q1"）， reducer 以 taskId 合并会串乱结果。这里在进入运行期之前
  // 自动改名为 id-2 / id-3 并补一条 warning，模型下一轮调用能看到提示。
  const dedupedTaskIds: string[] = [];
  {
    const seen = new Map<string, number>();
    for (const task of tasks) {
      const original = task.id;
      const count = seen.get(original) ?? 0;
      if (count > 0) {
        // 挥在最多 4 位，仍以 task title 为主要识别。最高 80 字符限制避免
        // 超过 type sanitize 边界。
        let candidate = `${original}-${count + 1}`;
        let dupGuard = 0;
        while (seen.has(candidate) && dupGuard++ < 16) {
          candidate = `${original}-${count + 1 + dupGuard}`;
        }
        task.id = candidate.slice(0, 80);
        dedupedTaskIds.push(`${original} -> ${task.id}`);
      }
      seen.set(task.id, (seen.get(task.id) ?? 0) + 1);
      // 记住最后一次使用该 original id 的计数。
      seen.set(original, count + 1);
    }
  }
  // dedupedTaskIds 的 warning 在下方与其它 warning 一起 push 进 planning.warnings。
  const requestedConcurrency =
    typeof input.concurrency === "number" && Number.isFinite(input.concurrency)
      ? Math.floor(input.concurrency)
      : undefined;
  const maxConcurrency = Math.min(DEFAULT_CONCURRENCY, tasks.length);
  const concurrency = clamp(
    Math.floor(requestedConcurrency ?? DEFAULT_CONCURRENCY),
    1,
    maxConcurrency
  );
  const warnings: string[] = [];
  if (tasks.length < 2) {
    warnings.push("Only one task was delegated; direct execution may be simpler.");
  }
  if (input.tasks.length > tasks.length) {
    warnings.push(`Input was trimmed from ${input.tasks.length} to ${tasks.length} task(s).`);
  }
  if (requestedConcurrency !== undefined && requestedConcurrency !== concurrency) {
    warnings.push(
      `Requested concurrency ${requestedConcurrency} was clamped to ${concurrency}.`
    );
  }
  const maxTaskTimeoutMs = taskTimeoutMs();
  const timeoutClamped = input.tasks.filter(
    (task) =>
      typeof task.timeoutMs === "number" &&
      Number.isFinite(task.timeoutMs) &&
      Math.floor(task.timeoutMs) > maxTaskTimeoutMs
  );
  if (timeoutClamped.length > 0) {
    warnings.push(
      `${timeoutClamped.length} task timeout(s) exceeded the ${maxTaskTimeoutMs} ms limit and were clamped.`
    );
  }
  const unsafeWriteRequests = input.tasks.filter(
    (task) =>
      task.allowedTools?.some(isWriteCapableTool) &&
      !sanitizeWritePaths(task.writePaths)?.length
  );
  if (unsafeWriteRequests.length > 0) {
    warnings.push(
      `${unsafeWriteRequests.length} task(s) requested write-capable tools without writePaths; write tools were removed.`
    );
  }
  if (dedupedTaskIds.length > 0) {
    warnings.push(
      `Renamed ${dedupedTaskIds.length} duplicate task id(s): ${dedupedTaskIds.join(", ")}.`
    );
  }
  const boundedWriteTasks = tasks.filter((task) =>
    task.allowedTools?.some(isWriteCapableTool)
  );
  if (boundedWriteTasks.length > 0) {
    warnings.push(
      `${boundedWriteTasks.length} task(s) include write-capable tools constrained to declared writePaths.`
    );
  }
  return {
    reason,
    tasks,
    concurrency,
    synthesisInstructions: input.synthesisInstructions?.trim().slice(0, 2000),
    planning: {
      status: warnings.length > 0 ? "caution" : "accepted",
      plannedAt: Date.now(),
      rationale: reason,
      taskCount: tasks.length,
      requestedConcurrency,
      concurrency,
      maxConcurrency,
      warnings,
    },
  };
}

/**
 * Subagent 首条 user prompt。
 *
 * 设计原则（问题定位后调整）：“子任务是什么”优先于“你是一个 subagent”。
 * 原因：
 *  - SDK 以首条 user message 开头几句作为 session title。以前主动把“你是一个
 *    subagent、只负责…”放在最前面，导致 sidebar / list 里所有 subagent 标题全一样。
 *  - 用户主诉：并行 subagent 难以辨认。
 *
 * 新布局：
 *  1. 任务头（标题 / 角色 / 内容）
 *  2. 写入边界（如有）
 *  3. 角色设定 / 长期记忆（如有）
 *  4. 分隔线 `---`
 *  5. 通用规则（只回答当前 / 不追问 / 输出格式）
 */
/**
 * 为 child session 补写 sidebar 可识别的 meta.title。
 *
 * 底层原因：SDK 默认 title 提取首条 user message 开头几句，即使
 * makeSubagentPrompt 已调为“任务明细前置”，在某些路径上（多行裁剪、表情”
 * 文本 title 生成“仍可能取到“子任务：...”这种模板头。写 meta.title 是二道
 * 保险——diga-agent 自己的 meta 会被 listAllSessions 优先用于列表显示。
 *
 * 调用点：createChild 后、runOneTask 开始跳事件之前。写入失败不阈任务 — sidebar
 * title 仅是体验项，不能拖垮并行 batch。
 */
export async function applyChildSessionTitle(
  sessionId: string,
  taskTitle: string
): Promise<void> {
  if (!sessionId) return;
  const trimmedTitle = (taskTitle || "").trim();
  if (!trimmedTitle) return;
  // 8个字段全使用可能太长，限 60 字符（中文估不超过 sidebar 2 行）。
  const titleBase = trimmedTitle.length > 60
    ? trimmedTitle.slice(0, 60).trimEnd() + "…"
    : trimmedTitle;
  const finalTitle = `Subagent: ${titleBase}`;
  try {
    const existing = await readMeta(sessionId);
    // 如果用户后期手动改过 title，尊重它不覆盖（existing.title 不以 "Subagent: "
    // 开头表示被人改过）。首次写入与“调度期刷新”都受这个保护。
    const isCustomTitle =
      existing?.title &&
      existing.title.length > 0 &&
      !existing.title.startsWith("Subagent: ");
    if (isCustomTitle) return;
    if (existing?.title === finalTitle) return;
    await writeMeta({
      ...(existing ?? {}),
      id: sessionId,
      title: finalTitle,
    });
  } catch {
    // 忽略：meta 写失败不该冲到主任务路径。
  }
}

export function makeSubagentPrompt(
  task: SubagentTaskRuntime,
  specialistPrompt?: string,
  memoryBlock?: string
): string {
  const writeScope =
    task.writePaths && task.writePaths.length > 0
      ? [
          "",
          "写入边界：",
          ...task.writePaths.map((item) => `- ${item}`),
          "",
          "如果需要修改文件，只能修改上述路径；不要修改边界外的文件。",
        ]
      : [];
  const specialistScope =
    specialistPrompt && specialistPrompt.trim()
      ? ["", "你的角色设定：", specialistPrompt.trim()]
      : [];
  const memoryScope =
    memoryBlock && memoryBlock.trim()
      ? ["", "你的长期记忆（供参考，不要照搬）：", memoryBlock.trim()]
      : [];
  return [
    `子任务：${task.title}`,
    `角色：${task.role ?? "general"}`,
    "",
    "任务内容：",
    task.prompt,
    ...writeScope,
    ...specialistScope,
    ...memoryScope,
    "",
    "---",
    "",
    "你是一个 subagent，只负责当前被委派的一个子任务。",
    "",
    "规则：",
    "- 只回答当前子任务，不要扩展到其他兄弟任务。",
    "- 优先给出可核验依据；如果依据不足，明确说明缺口。",
    "- 不要向用户追问；信息不足时直接写明无法确认的部分。",
    "- 最终输出包含：结论、依据、注意事项。",
    "",
    ...largeFileWriteProtocolLines(),
  ].join("\n");
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: string; text?: unknown };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .filter(Boolean)
    .join("");
}

function assistantTextFromEvent(event: AgentSessionEvent): string {
  const e = event as {
    message?: { role?: string; content?: unknown };
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  if (event.type === "message_end" && e.message?.role === "assistant") {
    return contentText(e.message.content);
  }
  if (event.type === "agent_end" && Array.isArray(e.messages)) {
    for (let i = e.messages.length - 1; i >= 0; i--) {
      const msg = e.messages[i];
      if (msg?.role === "assistant") return contentText(msg.content);
    }
  }
  return "";
}

function assistantErrorFromEvent(event: AgentSessionEvent): string | null {
  const e = event as {
    message?: {
      role?: string;
      stopReason?: string;
      errorMessage?: unknown;
    };
  };
  if (event.type !== "message_end" || e.message?.role !== "assistant") {
    return null;
  }
  if (e.message.stopReason !== "error" && e.message.stopReason !== "aborted") {
    return null;
  }
  return typeof e.message.errorMessage === "string" &&
    e.message.errorMessage.length > 0
    ? e.message.errorMessage
    : `Subagent ended with stopReason=${e.message.stopReason}`;
}

function preview(answer: string): string {
  return answer.replace(/\s+/g, " ").trim().slice(0, 240);
}

function auditEvent(
  type: SubagentAuditEvent["type"],
  message: string,
  opts: {
    at?: number;
    taskId?: string;
    data?: Record<string, unknown>;
  } = {}
): SubagentAuditEvent {
  return {
    type,
    at: opts.at ?? Date.now(),
    taskId: opts.taskId,
    message,
    data: opts.data,
  };
}

function appendAuditEvent(batchId: string, event: SubagentAuditEvent): void {
  const batch = getBatch(batchId);
  if (!batch) return;
  updateBatch(batchId, {
    auditEvents: [...(batch.auditEvents ?? []), event].slice(-MAX_AUDIT_EVENTS),
  });
}

function isTerminalTaskStatus(
  status: SubagentTaskRuntime["status"]
): status is SubagentResult["status"] {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "aborted" ||
    status === "timeout"
  );
}

function attemptFromTask(
  task: SubagentTaskRuntime,
  retriedAt: number
): SubagentTaskAttempt | null {
  if (!isTerminalTaskStatus(task.status)) return null;
  return {
    attempt: (task.attempts?.length ?? 0) + 1,
    agentId: task.agentId,
    status: task.status,
    answer: task.answer,
    answerPreview: task.answerPreview,
    error: task.error,
    sessionFile: task.sessionFile,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    usage: task.usage,
    retriedAt,
  };
}

function interruptedAttemptFromTask(
  task: SubagentTaskRuntime,
  retriedAt: number
): SubagentTaskAttempt | null {
  if (isTerminalTaskStatus(task.status)) return attemptFromTask(task, retriedAt);
  if (task.status !== "running") return null;
  return {
    attempt: (task.attempts?.length ?? 0) + 1,
    agentId: task.agentId,
    status: "aborted",
    answer: task.answer,
    answerPreview: task.answerPreview,
    error: "Interrupted before this subagent task could finish; resumed by parent agent.",
    sessionFile: task.sessionFile,
    startedAt: task.startedAt,
    endedAt: retriedAt,
    usage: task.usage,
    retriedAt,
  };
}

function assertCanControlBatch(
  deps: RunSubagentBatchDeps,
  batch: SubagentBatch
): void {
  if (batch.parentAgentId === deps.parentAgentId) return;
  if (deps.parentSessionPath && batch.parentSessionPath === deps.parentSessionPath) {
    return;
  }
  throw new Error("subagent batch does not belong to this parent agent/session");
}

function resetTaskForRerun(
  batchId: string,
  task: SubagentTaskRuntime,
  attempts: SubagentTaskAttempt[] | undefined
): void {
  updateTask(batchId, task.id, {
    status: "pending",
    agentId: undefined,
    answer: undefined,
    answerPreview: undefined,
    error: undefined,
    sessionFile: undefined,
    startedAt: undefined,
    endedAt: undefined,
    usage: undefined,
    attempts,
  });
}

function computeFinalBatchStatus(batch: SubagentBatch | undefined): SubagentBatchStatus {
  if (!batch) return "failed";
  const terminalTasks = batch.tasks.filter((item) =>
    isTerminalTaskStatus(item.status)
  );
  if (terminalTasks.length !== batch.tasks.length) return "running";
  return batch.tasks.some((item) => item.status === "completed")
    ? "completed"
    : "failed";
}

function worstVerificationStatus(
  statuses: Array<SubagentTaskVerification["status"]>
): SubagentTaskVerification["status"] {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("warning")) return "warning";
  return "passed";
}

function verifyTaskResult(
  task: SubagentTaskRuntime,
  result: SubagentResult,
  verifiedAt = Date.now()
): SubagentTaskVerification {
  const answer = result.answer?.trim() ?? "";
  const checks: SubagentTaskVerification["checks"] = [
    {
      id: "terminal-status",
      status: result.status === "completed" ? "passed" : "failed",
      message:
        result.status === "completed"
          ? "Task completed."
          : `Task ended with status=${result.status}.`,
    },
    {
      id: "answer-present",
      status: answer.length > 0 ? "passed" : "failed",
      message:
        answer.length > 0
          ? "Task produced an answer."
          : "Task did not produce an answer.",
    },
    {
      id: "answer-length",
      status:
        answer.length === 0 ? "failed" : answer.length >= 20 ? "passed" : "warning",
      message:
        answer.length >= 20
          ? "Answer has enough detail for synthesis."
          : "Answer is very short; synthesis may need caution.",
    },
    {
      id: "error-free",
      status: result.error ? "failed" : "passed",
      message: result.error ? `Task error: ${result.error}` : "No task error recorded.",
    },
    {
      id: "session-linked",
      status: result.sessionFile ? "passed" : "warning",
      message: result.sessionFile
        ? "Child session file is linked for audit."
        : "No child session file was recorded.",
    },
  ];
  if (task.role === "rag") {
    checks.push({
      id: "rag-source-hint",
      status:
        /来源|source|依据|引用|reference|wiki|文档/i.test(answer)
          ? "passed"
          : "warning",
      message:
        "RAG task answer should include a visible source/evidence hint when possible.",
    });
  }
  return {
    status: worstVerificationStatus(checks.map((check) => check.status)),
    checks,
    verifiedAt,
  };
}

function verifyBatch(batch: SubagentBatch, verifiedAt = Date.now()): SubagentBatchVerification {
  const verifications = batch.tasks.map((task) => task.verification).filter(Boolean);
  const passed = verifications.filter((item) => item?.status === "passed").length;
  const warnings = verifications.filter((item) => item?.status === "warning").length;
  const failed = verifications.filter((item) => item?.status === "failed").length;
  const missing = batch.tasks.length - verifications.length;
  const checks: SubagentBatchVerification["checks"] = [];
  checks.push({
    id: "verification-coverage",
    status: missing === 0 ? "passed" : "failed",
    message:
      missing === 0
        ? "Every task has verification metadata."
        : `${missing} task(s) are missing verification metadata.`,
  });
  const nonTerminal = batch.tasks.filter((task) => !isTerminalTaskStatus(task.status));
  checks.push({
    id: "terminal-coverage",
    status: nonTerminal.length === 0 ? "passed" : "failed",
    message:
      nonTerminal.length === 0
        ? "Every task reached a terminal status."
        : `${nonTerminal.length} task(s) are still non-terminal.`,
  });
  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const task of batch.tasks) {
    if (seenIds.has(task.id)) duplicateIds.add(task.id);
    seenIds.add(task.id);
  }
  checks.push({
    id: "unique-task-ids",
    status: duplicateIds.size === 0 ? "passed" : "failed",
    message:
      duplicateIds.size === 0
        ? "Task ids are unique."
        : `Duplicate task id(s): ${Array.from(duplicateIds).join(", ")}.`,
  });
  const conflictMessages = detectCrossTaskConflicts(batch);
  checks.push({
    id: "cross-task-conflicts",
    status: conflictMessages.length === 0 ? "passed" : "warning",
    message:
      conflictMessages.length === 0
        ? "No obvious cross-task answer conflicts detected (heuristic hint, not a reliable consistency check)."
        : `${conflictMessages.join(" | ")} (heuristic hint, not a reliable consistency check; verify manually).`,
  });
  const checkStatus = worstVerificationStatus(checks.map((check) => check.status));
  const status =
    failed > 0 || missing > 0 || checkStatus === "failed"
      ? "failed"
      : warnings > 0 || checkStatus === "warning"
      ? "warning"
      : "passed";
  return {
    status,
    verifiedAt,
    summary:
      missing > 0
        ? `${passed} passed, ${warnings} warnings, ${failed} failed, ${missing} unverified.`
        : `${passed} passed, ${warnings} warnings, ${failed} failed.`,
    passed,
    warnings,
    failed: failed + missing,
    checks,
  };
}

function normalizeConflictScope(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(q|task|question)[-\s_]*\d+\b/g, "")
    .replace(/\d+/g, "")
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, "")
    .trim();
}

function answerPolarity(answer: string | undefined): "yes" | "no" | "unknown" {
  const text = (answer ?? "").slice(0, 300).toLowerCase();
  if (/\b(no|not|cannot|can't|false)\b|否|不可以|不能|不允许|无需|不需要/i.test(text)) {
    return "no";
  }
  if (/\b(yes|true|can|allowed)\b|可以|允许|需要|必须/i.test(text)) {
    return "yes";
  }
  return "unknown";
}

function detectCrossTaskConflicts(batch: SubagentBatch): string[] {
  const byScope = new Map<string, Array<{ id: string; polarity: "yes" | "no" | "unknown" }>>();
  for (const task of batch.tasks) {
    if (task.status !== "completed") continue;
    const scope = normalizeConflictScope(`${task.title} ${task.prompt}`);
    if (!scope || scope.length < 4) continue;
    const polarity = answerPolarity(task.answer);
    if (polarity === "unknown") continue;
    const cur = byScope.get(scope) ?? [];
    cur.push({ id: task.id, polarity });
    byScope.set(scope, cur);
  }
  const conflicts: string[] = [];
  for (const tasks of byScope.values()) {
    const yes = tasks.filter((task) => task.polarity === "yes").map((task) => task.id);
    const no = tasks.filter((task) => task.polarity === "no").map((task) => task.id);
    if (yes.length > 0 && no.length > 0) {
      conflicts.push(`Conflicting yes/no answers across ${[...yes, ...no].join(", ")}.`);
    }
  }
  return conflicts;
}

function synthesizeBatch(
  batch: SubagentBatch,
  generatedAt = Date.now()
): SubagentBatchSynthesis {
  const usableTaskIds: string[] = [];
  const cautionTaskIds: string[] = [];
  const rejectedTaskIds: string[] = [];
  for (const task of batch.tasks) {
    if (task.verification?.status === "passed") {
      usableTaskIds.push(task.id);
    } else if (task.verification?.status === "warning") {
      cautionTaskIds.push(task.id);
    } else {
      rejectedTaskIds.push(task.id);
    }
  }
  const status =
    usableTaskIds.length > 0 && cautionTaskIds.length === 0 && rejectedTaskIds.length === 0
      ? "ready"
      : usableTaskIds.length > 0 || cautionTaskIds.length > 0
      ? "partial"
      : "blocked";
  const parts = [
    `${usableTaskIds.length} usable`,
    `${cautionTaskIds.length} caution`,
    `${rejectedTaskIds.length} rejected`,
  ];
  return {
    status,
    generatedAt,
    summary: `Synthesis ${status}: ${parts.join(", ")}.`,
    usableTaskIds,
    cautionTaskIds,
    rejectedTaskIds,
    instructions: batch.synthesisInstructions,
  };
}

function finalizeBatchArtifacts(
  batchId: string,
  generatedAt = Date.now()
): {
  verification?: SubagentBatchVerification;
  synthesis?: SubagentBatchSynthesis;
} {
  const batch = getBatch(batchId);
  if (!batch) return {};
  const verification = verifyBatch(batch, generatedAt);
  const synthesis = synthesizeBatch({ ...batch, verification }, generatedAt);
  updateBatch(batchId, { verification, synthesis });
  appendAuditEvent(
    batchId,
    auditEvent("batch_verified", verification.summary, {
      at: generatedAt,
      data: {
        status: verification.status,
        passed: verification.passed,
        warnings: verification.warnings,
        failed: verification.failed,
      },
    })
  );
  appendAuditEvent(
    batchId,
    auditEvent("batch_synthesized", synthesis.summary, {
      at: generatedAt,
      data: {
        status: synthesis.status,
        usableTaskIds: synthesis.usableTaskIds,
        cautionTaskIds: synthesis.cautionTaskIds,
        rejectedTaskIds: synthesis.rejectedTaskIds,
      },
    })
  );
  return { verification, synthesis };
}

function registerRunningBatch(parentAgentId: string, batchId: string) {
  const controller: RunningBatchController = {
    childAgentIds: new Set(),
    abortController: new AbortController(),
  };
  runningControllers.set(batchId, controller);
  let ids = runningByParent.get(parentAgentId);
  if (!ids) {
    ids = new Set();
    runningByParent.set(parentAgentId, ids);
  }
  ids.add(batchId);
  return controller;
}

function unregisterRunningBatch(parentAgentId: string, batchId: string) {
  runningControllers.delete(batchId);
  const ids = runningByParent.get(parentAgentId);
  if (!ids) return;
  ids.delete(batchId);
  if (ids.size === 0) runningByParent.delete(parentAgentId);
}

export async function abortRunningSubagentBatches(
  parentAgentId: string,
  getChild: (agentId: string) => ChildAgentRecord | undefined,
  pushParentEvent?: (event: SubagentEvent) => void
): Promise<void> {
  const batchIds = runningByParent.get(parentAgentId);
  if (!batchIds) return;
  await Promise.all(
    Array.from(batchIds).map(async (batchId) => {
      const controller = runningControllers.get(batchId);
      if (!controller) return;
      controller.abortController.abort();
      // A2-1：锁住 end push 隔离。worker fn finally 跳过。
      controller.endedPushed = true;
      const endedAt = Date.now();
      // S8：同步把未终态的 task 改为 aborted + 写 verification + push end。
      // 以前只动 batch.status，task 代码还在 “running” 挂着、卡片一直转圈。
      const batchSnapshot = getBatch(batchId);
      if (batchSnapshot) {
        for (const task of batchSnapshot.tasks) {
          if (isTerminalTaskStatus(task.status)) continue;
          const result: SubagentResult = {
            taskId: task.id,
            agentId: task.agentId ?? "",
            status: "aborted",
            error: "Batch aborted by parent.",
            startedAt: task.startedAt ?? endedAt,
            endedAt,
          };
          const verification = verifyTaskResult(task, result, endedAt);
          updateTask(batchId, task.id, {
            status: "aborted",
            endedAt,
            error: result.error,
            verification,
          });
          pushParentEvent?.({
            type: "subagent_task_end",
            batchId,
            taskId: task.id,
            status: "aborted",
            error: result.error,
            endedAt,
            verification,
          });
        }
      }
      updateBatchStatus(batchId, "aborted", endedAt);
      // 子 agent abort
      await Promise.all(
        Array.from(controller.childAgentIds).map((agentId) =>
          getChild(agentId)?.session.abort().catch(() => undefined)
        )
      );
      // 取一下最新 audit 还太早；batch_completed 托给运行中的 worker finally 口口 push。
      // 为了保证前端卡片能及时跳出 running，主动 push 一条 batch_end。
      const finalBatch = getBatch(batchId);
      pushParentEvent?.({
        type: "subagent_batch_end",
        batchId,
        status: "aborted",
        results:
          finalBatch?.tasks.map((task) => ({
            taskId: task.id,
            agentId: task.agentId ?? "",
            sessionFile: task.sessionFile,
            status: isTerminalTaskStatus(task.status)
              ? task.status
              : ("aborted" as const),
            answer: task.answer,
            error: task.error,
            startedAt: task.startedAt ?? endedAt,
            endedAt: task.endedAt ?? endedAt,
            usage: task.usage,
          })) ?? [],
        endedAt,
        verification: finalBatch?.verification,
        synthesis: finalBatch?.synthesis,
        auditEvents: finalBatch?.auditEvents,
      });
    })
  );
}

export function listRunningSubagentBatches(parentAgentId: string): SubagentBatch[] {
  return listRunningBatches(parentAgentId);
}

async function runOneTask(
  deps: RunSubagentBatchDeps,
  batchId: string,
  task: SubagentTaskRuntime,
  controller: RunningBatchController
): Promise<SubagentResult> {
  // Resolve a registered specialist (Sprint 2). When none, behavior is the
  // legacy role-based path (修正 5).
  const definition: SubagentDefinition | null = task.specialistId
    ? deps.resolveDefinition?.(task.specialistId) ?? null
    : null;
  const role = normalizeRole(definition?.role ?? task.role);
  const startedAt = Date.now();
  updateTask(batchId, task.id, { status: "running", startedAt });

  // S2：先算 isolation，再算 permission。worktree 隔离下 permission 不该被剖成
  // read-only —— 干奥会让需要写的 implementation specialist 干不了活。
  const isolationMode = resolveIsolationMode(definition, task);

  // Merge permission: definition is the ceiling; runtime cannot escalate (修正 4).
  const permission = resolveSubagentPermission(
    definition,
    {
      requestedTools: task.allowedTools,
      writePaths: task.writePaths,
      isolatedWorktree: isolationMode === "worktree",
    },
    defaultToolsForRole(role)
  );
  // Per-agent model policy: a specialist may pin its own model (safe fallback to
  // the parent model when the definition's model spec is incomplete).
  const model = resolveSubagentModel(definition, {
    provider: deps.provider,
    modelId: deps.modelId,
  });
  let worktree: WorkflowWorktree | null = null;
  let childCwd = task.cwd || deps.cwd;
  let childWritePaths = permission.writePaths;

  let child: CreatedChildAgent | null = null;
  const subscription: { unsubscribe?: () => void } = {};
  let latestAnswer = "";
  let childError: string | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    if (isolationMode === "worktree" && deps.worktrees) {
      worktree = await deps.worktrees.create({
        workflowId: `subagent-${batchId.slice(0, 8)}`,
        name: task.id,
        baseRef: resolveIsolationBaseRef(definition),
      });
      childCwd = worktree.path;
      // Inside the worktree the child may write freely (the worktree IS the
      // boundary); merge back to the parent requires approval.
      childWritePaths = [worktree.path];
      updateTask(batchId, task.id, {
        worktree: {
          id: worktree.id,
          path: worktree.path,
          branchName: worktree.branchName,
        },
      });
      appendAuditEvent(
        batchId,
        auditEvent(
          "worktree_created",
          `Created isolated worktree for task ${task.title}.`,
          {
            at: startedAt,
            taskId: task.id,
            data: { worktreeId: worktree.id, path: worktree.path },
          }
        )
      );
    }

    child = await deps.createChild({
      provider: model.provider,
      modelId: model.modelId,
      cwd: childCwd,
      parentSessionPath: deps.parentSessionPath,
      thinkingLevel: deps.thinkingLevel,
      tools: permission.allowedTools,
      writePaths: childWritePaths,
      parentAgentId: deps.parentAgentId,
      childRole: role,
      hidden: true,
      enableSubagents: false,
      // MCP scope (Sprint 5): a child only sees its specialist's declared MCP
      // servers; non-specialist children get none.
      mcpServers: definition?.allowedMcpServers ?? [],
      // Cowork: tag this child's ask_user clarifications so they surface on the
      // parent channel attributed to this task.
      taskId: task.id,
      taskTitle: task.title,
    });
    controller.childAgentIds.add(child.id);
    updateTask(batchId, task.id, { agentId: child.id });
    // 补写 sidebar title（meta.title）。在 createChild 返回后、启动 prompt 之前调，
    // 避免使用者“一闪看到默认 title”。写失败不阈任务。
    if (child.sessionId) {
      void applyChildSessionTitle(child.sessionId, task.title);
    }
    if (definition) {
      appendAuditEvent(
        batchId,
        auditEvent(
          "agent_selected",
          `Task ${task.title} resolved to specialist "${definition.id}".`,
          {
            at: startedAt,
            taskId: task.id,
            data: {
              specialistId: definition.id,
              source: definition.source,
              appliedMode: permission.appliedMode,
              notes: permission.notes,
              model: model.overridden
                ? `${model.provider}/${model.modelId}`
                : undefined,
            },
          }
        )
      );
    }
    appendAuditEvent(
      batchId,
      auditEvent("task_started", `Started subagent task ${task.title}.`, {
        at: startedAt,
        taskId: task.id,
        data: { agentId: child.id, role, specialistId: definition?.id },
      })
    );
    // SubagentStart hook (Sprint 4): informational, recorded for audit.
    const startHook = runSubagentStartHook(definition, {
      taskId: task.id,
      agentId: child.id,
      role,
    });
    if (startHook.fired) {
      appendAuditEvent(
        batchId,
        auditEvent(
          "subagent_started_hook",
          startHook.notes.join(" ") || `SubagentStart hooks fired.`,
          {
            at: startedAt,
            taskId: task.id,
            data: { hooks: startHook.hooks },
          }
        )
      );
    }
    if (permission.writePaths?.length) {
      appendAuditEvent(
        batchId,
        auditEvent(
          "write_boundary_applied",
          `Applied write boundary for subagent task ${task.title}.`,
          {
            at: startedAt,
            taskId: task.id,
            data: { writePaths: permission.writePaths },
          }
        )
      );
    }
    const startedRuntimeTask = getBatch(batchId)?.tasks.find(
      (item) => item.id === task.id
    );
    deps.pushParentEvent({
      type: "subagent_task_start",
      batchId,
      taskId: task.id,
      agentId: child.id,
      title: task.title,
      role,
      startedAt,
      attempts: startedRuntimeTask?.attempts,
    });

    const rec = deps.getChild(child.id);
    if (!rec) throw new Error(`child agent not found: ${child.id}`);

    const taskDone = new Promise<void>((resolve) => {
      subscription.unsubscribe = rec.session.subscribe((event) => {
        const text = assistantTextFromEvent(event);
        if (text) {
          latestAnswer = text;
          updateTask(batchId, task.id, { answerPreview: preview(text) });
          deps.pushParentEvent({
            type: "subagent_task_update",
            batchId,
            taskId: task.id,
            answerPreview: preview(text),
          });
        }
        const error = assistantErrorFromEvent(event);
        if (error) {
          childError = error;
          resolve();
          return;
        }
        if (event.type === "agent_end") resolve();
      });
    });

    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error("timeout"));
      }, task.timeoutMs ?? taskTimeoutMs());
    });

    const abortListener = () => {
      void rec.session.abort().catch(() => undefined);
    };
    controller.abortController.signal.addEventListener("abort", abortListener, {
      once: true,
    });

    try {
      await Promise.race([
        (async () => {
          const memoryBlock = definition
            ? renderMemoryForPrompt(
                getSubagentMemory(definition.id, "project")
              )
            : "";
          await rec.session.prompt(
            makeSubagentPrompt(task, definition?.prompt, memoryBlock)
          );
          await taskDone;
        })(),
        timedOut,
      ]);
    } finally {
      controller.abortController.signal.removeEventListener("abort", abortListener);
    }

    if (childError) {
      throw new Error(childError);
    }

    const endedAt = Date.now();
    const stats = rec.session.getSessionStats?.();
    const result: SubagentResult = {
      taskId: task.id,
      agentId: child.id,
      sessionFile: rec.session.sessionFile,
      status: controller.abortController.signal.aborted ? "aborted" : "completed",
      answer: latestAnswer.trim(),
      startedAt,
      endedAt,
      usage: stats
        ? {
            turns: stats.userMessages,
            costUsd: stats.cost,
            inputTokens: stats.tokens?.input,
            outputTokens: stats.tokens?.output,
          }
        : undefined,
    };
    const verification = verifyTaskResult(task, result);

    // Isolated worktree: diff -> approval -> merge or discard (修正 2/3/6).
    if (worktree && deps.worktrees && result.status === "completed") {
      await mergeIsolatedWorktree(deps, batchId, task, worktree);
    }

    // SubagentStop hook (Sprint 3): update specialist memory from the result.
    const stop = runSubagentStopHook(definition, task, result, verification);
    if (stop.updatedMemory) {
      appendAuditEvent(
        batchId,
        auditEvent("memory_updated", `Updated memory for ${definition?.id}.`, {
          at: endedAt,
          taskId: task.id,
          data: { addedRisks: stop.addedRisks },
        })
      );
    }

    updateTask(batchId, task.id, {
      status: result.status,
      endedAt,
      answer: result.answer,
      answerPreview: preview(result.answer ?? ""),
      sessionFile: result.sessionFile,
      usage: result.usage,
      verification,
    });
    const endedRuntimeTask = getBatch(batchId)?.tasks.find(
      (item) => item.id === task.id
    );
    deps.pushParentEvent({
      type: "subagent_task_end",
      batchId,
      taskId: task.id,
      status: result.status,
      answer: result.answer,
      answerPreview: preview(result.answer ?? ""),
      sessionFile: result.sessionFile,
      usage: result.usage,
      endedAt,
      attempts: endedRuntimeTask?.attempts,
      verification,
    });
    appendAuditEvent(
      batchId,
      auditEvent("task_completed", `Completed subagent task ${task.title}.`, {
        at: endedAt,
        taskId: task.id,
        data: {
          agentId: child.id,
          status: result.status,
          verification: verification.status,
          sessionFile: result.sessionFile,
        },
      })
    );
    return result;
  } catch (err) {
    const endedAt = Date.now();
    const wasAborted = controller.abortController.signal.aborted;
    const status =
      (err as Error).message === "timeout" ? "timeout" : wasAborted ? "aborted" : "failed";
    if (status === "timeout" && child) {
      await deps.getChild(child.id)?.session.abort().catch(() => undefined);
    }
    const result: SubagentResult = {
      taskId: task.id,
      agentId: child?.id ?? "",
      sessionFile: child ? deps.getChild(child.id)?.session.sessionFile : undefined,
      status,
      answer: latestAnswer.trim() || undefined,
      error:
        status === "timeout"
          ? `Subagent task timed out after ${task.timeoutMs ?? taskTimeoutMs()} ms`
          : (err as Error).message,
      startedAt,
      endedAt,
    };
    const verification = verifyTaskResult(task, result);
    updateTask(batchId, task.id, {
      status,
      endedAt,
      answer: result.answer,
      answerPreview: preview(result.answer ?? ""),
      error: result.error,
      sessionFile: result.sessionFile,
      verification,
    });
    const endedRuntimeTask = getBatch(batchId)?.tasks.find(
      (item) => item.id === task.id
    );
    deps.pushParentEvent({
      type: "subagent_task_end",
      batchId,
      taskId: task.id,
      status,
      answer: result.answer,
      answerPreview: preview(result.answer ?? ""),
      error: result.error,
      sessionFile: result.sessionFile,
      endedAt,
      attempts: endedRuntimeTask?.attempts,
      verification,
    });
    appendAuditEvent(
      batchId,
      auditEvent("task_failed", `Subagent task ${task.title} ended as ${status}.`, {
        at: endedAt,
        taskId: task.id,
        data: {
          agentId: child?.id,
          status,
          error: result.error,
          verification: verification.status,
        },
      })
    );
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (subscription.unsubscribe) subscription.unsubscribe();
    if (child) {
      controller.childAgentIds.delete(child.id);
      deps.disposeChild?.(child.id);
    }
    // Always clean up the isolated worktree (修正 6): merged changes are already
    // applied to the parent; unmerged/discarded changes are dropped here.
    if (worktree && deps.worktrees?.remove) {
      await deps.worktrees.remove(worktree).catch(() => undefined);
    }
  }
}

/**
 * Diff an isolated worktree, request merge approval, and merge or discard
 * accordingly (Sprint 3). Failures are caught and recorded as discarded so a
 * half-applied change never leaks into the parent working tree.
 */
async function mergeIsolatedWorktree(
  deps: RunSubagentBatchDeps,
  batchId: string,
  task: SubagentTaskRuntime,
  worktree: WorkflowWorktree
): Promise<void> {
  if (!deps.worktrees?.diff || !deps.worktrees?.merge) return;
  try {
    const diff = await deps.worktrees.diff(worktree);
    if (!diff.diff.trim()) {
      appendAuditEvent(
        batchId,
        auditEvent("worktree_discarded", `No changes in worktree for ${task.title}.`, {
          taskId: task.id,
          data: { worktreeId: worktree.id, reason: "empty-diff" },
        })
      );
      return;
    }
    // Without an approval channel, never auto-merge.
    if (!deps.approveSubagentMerge) {
      appendAuditEvent(
        batchId,
        auditEvent(
          "worktree_discarded",
          `Worktree changes for ${task.title} discarded (no approval channel).`,
          {
            taskId: task.id,
            data: { worktreeId: worktree.id, reason: "no-approval-channel" },
          }
        )
      );
      return;
    }
    const approval = await deps.approveSubagentMerge({
      taskId: task.id,
      title: task.title,
      worktree,
      diff: { stat: diff.stat, diff: diff.diff },
    });
    if (approval.decision !== "allow") {
      appendAuditEvent(
        batchId,
        auditEvent(
          "worktree_discarded",
          `Merge denied for ${task.title}; changes discarded.`,
          {
            taskId: task.id,
            data: { worktreeId: worktree.id, denyReason: approval.denyReason },
          }
        )
      );
      return;
    }
    const merged = await deps.worktrees.merge(worktree);
    updateTask(batchId, task.id, {
      worktree: {
        id: worktree.id,
        path: worktree.path,
        branchName: worktree.branchName,
        merged: merged.applied,
      },
    });
    appendAuditEvent(
      batchId,
      auditEvent("worktree_merged", `Merged worktree for ${task.title}.`, {
        taskId: task.id,
        data: { worktreeId: worktree.id, applied: merged.applied, summary: merged.summary },
      })
    );
  } catch (e) {
    appendAuditEvent(
      batchId,
      auditEvent(
        "worktree_discarded",
        `Worktree merge failed for ${task.title}; changes discarded.`,
        {
          taskId: task.id,
          data: {
            worktreeId: worktree.id,
            error: e instanceof Error ? e.message : String(e),
          },
        }
      )
    );
  }
}

export async function runSubagentBatch(
  deps: RunSubagentBatchDeps,
  input: DelegateSubagentsInput,
  signal?: AbortSignal
): Promise<{
  batchId: string;
  results: SubagentResult[];
  planning?: SubagentBatchPlan;
  synthesis?: SubagentBatchSynthesis;
  auditEvents?: SubagentAuditEvent[];
}> {
  const normalized = validateDelegateInput(input);
  const batchId = randomUUID();
  const batch: SubagentBatch = {
    id: batchId,
    parentAgentId: deps.parentAgentId,
    parentSessionPath: deps.parentSessionPath,
    status: "running",
    reason: normalized.reason,
    synthesisInstructions: normalized.synthesisInstructions,
    planning: normalized.planning,
    tasks: normalized.tasks,
    auditEvents: [
      auditEvent("batch_created", `Created subagent batch with ${normalized.tasks.length} task(s).`, {
        data: {
          taskCount: normalized.tasks.length,
          concurrency: normalized.concurrency,
          planningStatus: normalized.planning.status,
        },
      }),
    ],
    createdAt: Date.now(),
  };
  putBatch(batch);
  deps.pushParentEvent({ type: "subagent_batch_start", batch });

  const controller = registerRunningBatch(deps.parentAgentId, batchId);

  // Core execution: worker loop -> finalize -> push batch_end. Shared by
  // foreground (awaited) and background (detached) modes.
  const executeBatch = async (): Promise<SubagentResult[]> => {
    const externalAbort = () => controller.abortController.abort();
    signal?.addEventListener("abort", externalAbort, { once: true });

    const queue = normalized.tasks.slice();
    const results: SubagentResult[] = [];
    let nextIndex = 0;

    const worker = async () => {
      while (!controller.abortController.signal.aborted) {
        const task = queue[nextIndex++];
        if (!task) return;
        const result = await runOneTask(deps, batchId, task, controller);
        results.push(result);
      }
    };

    try {
      await Promise.all(
        Array.from({ length: normalized.concurrency }, () => worker())
      );
    } finally {
      signal?.removeEventListener("abort", externalAbort);
    }

    const endedAt = Date.now();
    const hasCompleted = results.some((result) => result.status === "completed");
    const finalStatus = controller.abortController.signal.aborted
      ? "aborted"
      : hasCompleted
        ? "completed"
        : "failed";
    updateBatchStatus(batchId, finalStatus, endedAt);
    unregisterRunningBatch(deps.parentAgentId, batchId);

    for (const task of normalized.tasks) {
      if (getTaskStatus(batchId, task.id) === "pending") {
        const result: SubagentResult = {
          taskId: task.id,
          agentId: "",
          status: "aborted",
          error: "Batch ended before this task started.",
          startedAt: endedAt,
          endedAt,
        };
        updateTask(batchId, task.id, {
          status: "aborted",
          endedAt,
          error: result.error,
          verification: verifyTaskResult(task, result, endedAt),
        });
      }
    }

    const { verification, synthesis } = finalizeBatchArtifacts(batchId, endedAt);
    appendAuditEvent(
      batchId,
      auditEvent("batch_completed", `Subagent batch ended as ${finalStatus}.`, {
        at: endedAt,
        data: { status: finalStatus, resultCount: results.length },
      })
    );
    const auditEvents = getBatch(batchId)?.auditEvents;

    // A2-1：abort 路径已 push 过一次 batch_end。这里不再重复，避免 UI 衰减事件
    // 覆盖 audit_events 与闪闪。注意：如果是正常完成/失败路径（未被 abort），
    // controller.endedPushed 仍为 undefined，push 照旧。
    if (!controller.endedPushed) {
      controller.endedPushed = true;
      deps.pushParentEvent({
        type: "subagent_batch_end",
        batchId,
        status: finalStatus,
        results,
        endedAt,
        verification,
        synthesis,
        auditEvents,
      });
    }

    return results;
  };

  // Background queue v1 (Sprint 4): return immediately, keep running, push
  // batch_end when done. Errors in the detached run are swallowed (the
  // batch_end event and persisted status carry the outcome).
  if (input.background) {
    updateBatchStatus(batchId, "detached");
    appendAuditEvent(
      batchId,
      auditEvent("batch_detached", `Batch detached to background queue.`, {
        data: { taskCount: normalized.tasks.length },
      })
    );
    deps.pushParentEvent({
      type: "subagent_batch_detached",
      batchId,
      taskCount: normalized.tasks.length,
    });
    void executeBatch().catch(() => undefined);
    return {
      batchId,
      results: [],
      planning: normalized.planning,
      auditEvents: getBatch(batchId)?.auditEvents,
    };
  }

  const results = await executeBatch();
  const finalBatch = getBatch(batchId);
  return {
    batchId,
    results,
    planning: normalized.planning,
    synthesis: finalBatch?.synthesis,
    auditEvents: finalBatch?.auditEvents,
  };
}

export async function retrySubagentTask(
  deps: RunSubagentBatchDeps,
  batchId: string,
  taskId: string,
  signal?: AbortSignal
): Promise<SubagentResult> {
  const batch = getBatch(batchId);
  if (!batch) throw new Error(`subagent batch not found: ${batchId}`);
  assertCanControlBatch(deps, batch);
  const task = batch.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`subagent task not found: ${taskId}`);
  if (task.status === "running") {
    throw new Error(`subagent task is already running: ${taskId}`);
  }

  const retriedAt = Date.now();
  const previousAttempt = attemptFromTask(task, retriedAt);
  appendAuditEvent(
    batchId,
    auditEvent("task_retried", `Retry requested for subagent task ${task.title}.`, {
      at: retriedAt,
      taskId: task.id,
      data: {
        previousStatus: task.status,
        previousAgentId: task.agentId,
      },
    })
  );
  updateBatch(batchId, {
    parentAgentId: deps.parentAgentId,
    parentSessionPath: deps.parentSessionPath ?? batch.parentSessionPath,
    status: "running",
    endedAt: undefined,
  });
  resetTaskForRerun(
    batchId,
    task,
    previousAttempt
      ? [...(task.attempts ?? []), previousAttempt]
      : task.attempts
  );

  const controller = registerRunningBatch(deps.parentAgentId, batchId);
  const externalAbort = () => controller.abortController.abort();
  signal?.addEventListener("abort", externalAbort, { once: true });
  let result: SubagentResult;
  try {
    result = await runOneTask(deps, batchId, { ...task, status: "pending" }, controller);
  } finally {
    signal?.removeEventListener("abort", externalAbort);
    unregisterRunningBatch(deps.parentAgentId, batchId);
  }

  const finalStatus = computeFinalBatchStatus(getBatch(batchId));
  updateBatchStatus(
    batchId,
    finalStatus,
    finalStatus === "running" ? undefined : Date.now()
  );
  const { verification, synthesis } =
    finalStatus === "running" ? {} : finalizeBatchArtifacts(batchId);
  const auditEvents = getBatch(batchId)?.auditEvents;

  // A2-1：如果被 abort 路径走过，endedPushed 已为 true。这里只在未被 abort 时才 push。
  if (!controller.endedPushed) {
    controller.endedPushed = true;
    deps.pushParentEvent({
      type: "subagent_batch_end",
      batchId,
      status: finalStatus,
      results: [result],
      endedAt: Date.now(),
      verification,
      synthesis,
      auditEvents,
    });
  }

  return result;
}

export async function resumeSubagentBatch(
  deps: RunSubagentBatchDeps,
  batchId: string,
  signal?: AbortSignal
): Promise<{
  batchId: string;
  results: SubagentResult[];
  synthesis?: SubagentBatchSynthesis;
  auditEvents?: SubagentAuditEvent[];
}> {
  const batch = getBatch(batchId);
  if (!batch) throw new Error(`subagent batch not found: ${batchId}`);
  assertCanControlBatch(deps, batch);
  if (runningControllers.has(batchId)) {
    throw new Error(`subagent batch is already running: ${batchId}`);
  }
  const resumableTasks = batch.tasks.filter(
    (task) => !isTerminalTaskStatus(task.status)
  );
  if (resumableTasks.length === 0) {
    throw new Error(`subagent batch has no unfinished tasks: ${batchId}`);
  }

  const resumedAt = Date.now();
  appendAuditEvent(
    batchId,
    auditEvent("batch_resumed", `Resume requested for ${resumableTasks.length} unfinished subagent task(s).`, {
      at: resumedAt,
      data: {
        unfinishedTaskIds: resumableTasks.map((task) => task.id),
        previousParentAgentId: batch.parentAgentId,
        newParentAgentId: deps.parentAgentId,
      },
    })
  );
  updateBatch(batchId, {
    parentAgentId: deps.parentAgentId,
    parentSessionPath: deps.parentSessionPath ?? batch.parentSessionPath,
    status: "running",
    endedAt: undefined,
  });

  for (const task of resumableTasks) {
    const interruptedAttempt = interruptedAttemptFromTask(task, resumedAt);
    resetTaskForRerun(
      batchId,
      task,
      interruptedAttempt
        ? [...(task.attempts ?? []), interruptedAttempt]
        : task.attempts
    );
  }

  const restored = getBatch(batchId);
  if (restored) {
    deps.pushParentEvent({ type: "subagent_batch_start", batch: restored });
  }

  const controller = registerRunningBatch(deps.parentAgentId, batchId);
  const externalAbort = () => controller.abortController.abort();
  signal?.addEventListener("abort", externalAbort, { once: true });
  const queue = resumableTasks.map((task) => ({ ...task, status: "pending" as const }));
  const results: SubagentResult[] = [];
  let nextIndex = 0;

  const worker = async () => {
    while (!controller.abortController.signal.aborted) {
      const task = queue[nextIndex++];
      if (!task) return;
      const result = await runOneTask(deps, batchId, task, controller);
      results.push(result);
    }
  };

  try {
    await Promise.all(
      Array.from(
        { length: Math.min(DEFAULT_CONCURRENCY, queue.length) },
        () => worker()
      )
    );
  } finally {
    signal?.removeEventListener("abort", externalAbort);
    unregisterRunningBatch(deps.parentAgentId, batchId);
  }

  const finalStatus = controller.abortController.signal.aborted
    ? "aborted"
    : computeFinalBatchStatus(getBatch(batchId));
  const endedAt = Date.now();
  updateBatchStatus(
    batchId,
    finalStatus,
    finalStatus === "running" ? undefined : endedAt
  );
  const { verification, synthesis } =
    finalStatus === "running" ? {} : finalizeBatchArtifacts(batchId, endedAt);
  appendAuditEvent(
    batchId,
    auditEvent("batch_completed", `Resumed subagent batch ended as ${finalStatus}.`, {
      at: endedAt,
      data: { status: finalStatus, resultCount: results.length },
    })
  );
  const auditEvents = getBatch(batchId)?.auditEvents;

  // A2-1：abort 路径已推过一条 batch_end，这里不重复。
  if (!controller.endedPushed) {
    controller.endedPushed = true;
    deps.pushParentEvent({
      type: "subagent_batch_end",
      batchId,
      status: finalStatus,
      results,
      endedAt,
      verification,
      synthesis,
      auditEvents,
    });
  }

  return { batchId, results, synthesis, auditEvents };
}

import type { ThinkingLevel } from "@/lib/types";

export type SubagentRole =
  | "general"
  | "rag"
  | "research"
  | "code-review"
  | "implementation";

export type SubagentTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "timeout";

export type SubagentBatchStatus =
  | "pending"
  | "running"
  | "detached"
  | "completed"
  | "failed"
  | "aborted";

export interface SubagentTask {
  id: string;
  title: string;
  prompt: string;
  role?: SubagentRole;
  /**
   * Optional registered specialist id (resolves to a SubagentDefinition). When
   * present, the orchestrator merges the definition's prompt/tools/permission.
   *
   * Named `specialistId` (not `agentId`) to avoid colliding with
   * SubagentTaskRuntime.agentId, which holds the spawned CHILD agent id.
   * Independent from `role` (a closed enum); see plan 修正 2.
   */
  specialistId?: string;
  /**
   * Write isolation strategy (Sprint 3). "worktree" runs the child in an
   * isolated git worktree and requires merge approval. Independent from the
   * definition's isolation (task can request, definition can pin).
   */
  isolation?: "none" | "worktree";
  cwd?: string;
  allowedTools?: string[];
  /**
   * Explicit file or directory paths this subagent may modify. Write-capable
   * tools are removed unless this boundary is present.
   */
  writePaths?: string[];
  maxTurns?: number;
  timeoutMs?: number;
}

export interface DelegateSubagentsInput {
  reason: string;
  /**
   * Run the batch in the background (Sprint 4 background queue v1). When true,
   * delegate returns immediately with the batchId and the batch keeps running;
   * a `subagent_batch_end` event is pushed when it completes.
   */
  background?: boolean;
  tasks: SubagentTask[];
  concurrency?: number;
  synthesisInstructions?: string;
}

export interface SubagentBatchPlan {
  status: "accepted" | "caution";
  plannedAt: number;
  rationale: string;
  taskCount: number;
  requestedConcurrency?: number;
  concurrency: number;
  maxConcurrency: number;
  warnings: string[];
}

export interface SubagentResult {
  taskId: string;
  agentId: string;
  sessionFile?: string;
  status: Exclude<SubagentTaskStatus, "pending" | "running">;
  answer?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  usage?: {
    turns?: number;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface SubagentTaskAttempt {
  attempt: number;
  agentId?: string;
  status: SubagentResult["status"];
  answer?: string;
  answerPreview?: string;
  error?: string;
  sessionFile?: string;
  startedAt?: number;
  endedAt?: number;
  usage?: SubagentResult["usage"];
  retriedAt: number;
}

export type SubagentVerificationStatus = "passed" | "warning" | "failed";

export interface SubagentTaskVerification {
  status: SubagentVerificationStatus;
  checks: Array<{
    id: string;
    status: SubagentVerificationStatus;
    message: string;
  }>;
  verifiedAt: number;
}

export interface SubagentTaskRuntime extends SubagentTask {
  agentId?: string;
  status: SubagentTaskStatus;
  startedAt?: number;
  endedAt?: number;
  answer?: string;
  answerPreview?: string;
  error?: string;
  sessionFile?: string;
  usage?: SubagentResult["usage"];
  attempts?: SubagentTaskAttempt[];
  verification?: SubagentTaskVerification;
  /** Worktree metadata when this task ran in isolation (Sprint 3). */
  worktree?: {
    id: string;
    path: string;
    branchName: string;
    merged?: boolean;
  };
}

export interface SubagentBatchVerification {
  status: SubagentVerificationStatus;
  verifiedAt: number;
  summary: string;
  passed: number;
  warnings: number;
  failed: number;
  checks?: Array<{
    id: string;
    status: SubagentVerificationStatus;
    message: string;
  }>;
}

export interface SubagentBatchSynthesis {
  status: "ready" | "partial" | "blocked";
  generatedAt: number;
  summary: string;
  usableTaskIds: string[];
  cautionTaskIds: string[];
  rejectedTaskIds: string[];
  instructions?: string;
}

export type SubagentAuditEventType =
  | "batch_created"
  | "task_started"
  | "agent_selected"
  | "write_boundary_applied"
  | "worktree_created"
  | "worktree_merged"
  | "worktree_discarded"
  | "hook_fired"
  | "memory_updated"
  | "subagent_started_hook"
  | "batch_detached"
  | "task_completed"
  | "task_failed"
  | "task_retried"
  | "batch_resumed"
  | "batch_verified"
  | "batch_synthesized"
  | "batch_completed";

export interface SubagentAuditEvent {
  type: SubagentAuditEventType;
  at: number;
  taskId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface SubagentBatch {
  id: string;
  parentAgentId: string;
  parentSessionPath?: string;
  status: SubagentBatchStatus;
  reason: string;
  synthesisInstructions?: string;
  planning?: SubagentBatchPlan;
  tasks: SubagentTaskRuntime[];
  verification?: SubagentBatchVerification;
  synthesis?: SubagentBatchSynthesis;
  auditEvents?: SubagentAuditEvent[];
  createdAt: number;
  endedAt?: number;
}

export interface SubagentBatchStartEvent {
  type: "subagent_batch_start";
  batch: SubagentBatch;
}

export interface SubagentBatchDetachedEvent {
  type: "subagent_batch_detached";
  batchId: string;
  taskCount: number;
}

export interface SubagentTaskStartEvent {
  type: "subagent_task_start";
  batchId: string;
  taskId: string;
  agentId: string;
  title: string;
  role: SubagentRole;
  startedAt: number;
  attempts?: SubagentTaskAttempt[];
}

export interface SubagentTaskUpdateEvent {
  type: "subagent_task_update";
  batchId: string;
  taskId: string;
  answerPreview?: string;
  attempts?: SubagentTaskAttempt[];
}

export interface SubagentTaskEndEvent {
  type: "subagent_task_end";
  batchId: string;
  taskId: string;
  status: SubagentResult["status"];
  answer?: string;
  answerPreview?: string;
  error?: string;
  sessionFile?: string;
  usage?: SubagentResult["usage"];
  endedAt: number;
  attempts?: SubagentTaskAttempt[];
  verification?: SubagentTaskVerification;
}

export interface SubagentBatchEndEvent {
  type: "subagent_batch_end";
  batchId: string;
  status: SubagentBatchStatus;
  results: SubagentResult[];
  endedAt: number;
  verification?: SubagentBatchVerification;
  synthesis?: SubagentBatchSynthesis;
  auditEvents?: SubagentAuditEvent[];
}

export type SubagentEvent =
  | SubagentBatchStartEvent
  | SubagentBatchDetachedEvent
  | SubagentTaskStartEvent
  | SubagentTaskUpdateEvent
  | SubagentTaskEndEvent
  | SubagentBatchEndEvent;

export interface CreateChildAgentOptions {
  provider: string;
  modelId: string;
  cwd: string;
  parentSessionPath?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  excludeTools?: string[];
  writePaths?: string[];
  parentAgentId?: string;
  childRole?: SubagentRole;
  hidden?: boolean;
  enableSubagents?: boolean;
  /** MCP server scope for the child (Sprint 5). [] = no MCP tools. */
  mcpServers?: string[];
  /**
   * Clarification attribution (cowork): when this child raises ask_user, the
   * request is surfaced on the parent channel tagged with this task id/title.
   */
  taskId?: string;
  taskTitle?: string;
}

export interface CreatedChildAgent {
  id: string;
  sessionId: string;
  sessionFile: string | undefined;
}

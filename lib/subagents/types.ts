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
  | "completed"
  | "failed"
  | "aborted";

export interface SubagentTask {
  id: string;
  title: string;
  prompt: string;
  role?: SubagentRole;
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
  | "write_boundary_applied"
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
}

export interface CreatedChildAgent {
  id: string;
  sessionId: string;
  sessionFile: string | undefined;
}

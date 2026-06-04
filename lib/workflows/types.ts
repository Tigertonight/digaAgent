import type { DelegateSubagentsInput, SubagentResult, SubagentRole } from "@/lib/subagents/types";
import type { ApprovalResponse } from "@/lib/collab/types";

export type WorkflowStageStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface WorkflowStep {
  id: string;
  title: string;
  prompt: string;
  role?: SubagentRole;
  cwd?: string;
  allowedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
}

export interface WorkflowStage {
  id: string;
  title: string;
  strategy?: "fan-out" | "verify" | "synthesize";
  steps: WorkflowStep[];
  concurrency?: number;
  synthesisInstructions?: string;
}

export interface RunDynamicWorkflowInput {
  objective: string;
  rationale: string;
  stages: WorkflowStage[];
  finalSynthesisInstructions?: string;
}

export interface WorkflowStageResult {
  stageId: string;
  title: string;
  status: WorkflowStageStatus;
  batchId?: string;
  results: SubagentResult[];
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface DynamicWorkflowResult {
  workflowId: string;
  objective: string;
  status: Exclude<WorkflowStageStatus, "pending" | "running">;
  stages: WorkflowStageResult[];
  startedAt: number;
  endedAt: number;
}

export interface RunDynamicWorkflowDeps {
  runSubagents: (
    input: DelegateSubagentsInput,
    signal?: AbortSignal
  ) => Promise<{ batchId: string; results: SubagentResult[] }>;
}

export interface RunWorkflowScriptInput {
  objective: string;
  rationale: string;
  script: string;
  resumeFromWorkflowId?: string;
  resumeFromCheckpointName?: string;
  capabilities?: WorkflowCapability[];
  maxAgents?: number;
  maxConcurrency?: number;
  timeoutMs?: number;
}

export interface WorkflowArtifact {
  name: string;
  value: unknown;
  createdAt: number;
}

export interface WorkflowCheckpoint {
  name: string;
  value: unknown;
  createdAt: number;
}

export interface WorkflowScriptLog {
  level: "info" | "warn" | "error";
  message: string;
  createdAt: number;
}

export interface WorkflowScriptResult {
  workflowId: string;
  objective: string;
  status: "completed" | "failed" | "aborted";
  manifest: WorkflowManifest;
  resumedFromWorkflowId?: string;
  returnValue?: unknown;
  artifacts: WorkflowArtifact[];
  checkpoints: WorkflowCheckpoint[];
  logs: WorkflowScriptLog[];
  startedAt: number;
  endedAt: number;
  error?: string;
}

export interface WorkflowResumeEntrySummary {
  name: string;
  createdAt: number;
  preview: string;
}

export interface WorkflowResumeSnapshot {
  workflowId: string;
  objective: string;
  status: WorkflowRunStatus;
  checkpointNames: string[];
  artifactNames: string[];
  checkpointSummaries: WorkflowResumeEntrySummary[];
  artifactSummaries: WorkflowResumeEntrySummary[];
  lastCheckpoint?: WorkflowCheckpoint;
  canResume: boolean;
  reason?: string;
}

export interface WorkflowSpawnAgentInput {
  id?: string;
  title: string;
  prompt: string;
  role?: SubagentRole;
  cwd?: string;
  allowedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
}

export interface WorkflowCreateWorktreeInput {
  name?: string;
  baseRef?: string;
}

export interface WorkflowWorktree {
  id: string;
  path: string;
  branchName: string;
  baseRef: string;
  createdAt: number;
}

export interface WorkflowWorktreeDiff {
  worktreeId: string;
  path: string;
  branchName: string;
  baseRef: string;
  diff: string;
  stat: string;
  createdAt: number;
}

export interface WorkflowWorktreeMergeResult {
  worktreeId: string;
  path: string;
  branchName: string;
  mergedAt: number;
  applied: boolean;
  summary?: string;
}

export interface WorkflowAskUserOption {
  id?: string;
  label: string;
  description?: string;
  value?: string;
}

export interface WorkflowAskUserInput {
  title?: string;
  question: string;
  context?: string;
  options: WorkflowAskUserOption[];
  recommendedOptionId?: string;
}

export interface WorkflowAskUserResult {
  requestId: string;
  selectedOptionId?: string;
  customText?: string;
  answer: string;
}

export interface WorkflowFetchUrlInput {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
}

export interface WorkflowFetchUrlResult {
  url: string;
  status: number;
  ok: boolean;
  statusText: string;
  contentType?: string;
  text: string;
  truncated: boolean;
}

export interface WorkflowNetworkPolicy {
  allowedOrigins?: string[];
  deniedOrigins?: string[];
  allowedUrlPatterns?: string[];
  deniedUrlPatterns?: string[];
  allowedMethods?: Array<"GET" | "POST">;
}

export interface WorkflowNetworkAuditEntry {
  id: string;
  workflowId: string;
  url: string;
  method: "GET" | "POST";
  outcome: "allowed" | "denied" | "failed";
  status?: number;
  reason?: string;
  createdAt: number;
}

export interface WorkflowNetworkAuditQuery {
  limit?: number;
  workflowId?: string;
  origin?: string;
  outcome?: WorkflowNetworkAuditEntry["outcome"];
  q?: string;
}

export interface WorkflowWorktreeManager {
  create(input: {
    workflowId: string;
    name?: string;
    baseRef?: string;
  }): Promise<WorkflowWorktree>;
  diff?(worktree: WorkflowWorktree): Promise<WorkflowWorktreeDiff>;
  merge?(worktree: WorkflowWorktree): Promise<WorkflowWorktreeMergeResult>;
  remove?(worktree: WorkflowWorktree): Promise<void>;
}

export interface RunWorkflowScriptDeps {
  runSubagents: RunDynamicWorkflowDeps["runSubagents"];
  parentAgentId?: string;
  onEvent?: (event: WorkflowEvent) => void;
  approveCapability?: (request: WorkflowCapabilityApprovalRequest) => Promise<ApprovalResponse>;
  approveWorktreeMerge?: (request: WorkflowWorktreeMergeApprovalRequest) => Promise<ApprovalResponse>;
  approveNetworkRequest?: (request: WorkflowNetworkApprovalRequest) => Promise<ApprovalResponse>;
  askUser?: (request: WorkflowAskUserRequest) => Promise<WorkflowAskUserResult>;
  fetchUrl?: (input: WorkflowFetchUrlInput, signal: AbortSignal) => Promise<WorkflowFetchUrlResult>;
  resolveFetchHost?: (host: string) => Promise<string[]>;
  networkPolicy?: WorkflowNetworkPolicy;
  worktrees?: WorkflowWorktreeManager;
}

export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export type WorkflowCapability =
  | "spawn_agent"
  | "read_files"
  | "write_files"
  | "shell"
  | "browser"
  | "network"
  | "worktree"
  | "ask_user";

export interface WorkflowManifest {
  capabilities: WorkflowCapability[];
  maxAgents: number;
  maxConcurrency: number;
  timeoutMs: number;
  runtime: "process";
}

export interface WorkflowCapabilityApprovalRequest {
  workflowId: string;
  capability: WorkflowCapability;
  manifest: WorkflowManifest;
  objective: string;
  rationale: string;
}

export interface WorkflowWorktreeMergeApprovalRequest {
  workflowId: string;
  manifest: WorkflowManifest;
  objective: string;
  rationale: string;
  worktree: WorkflowWorktree;
  diff: WorkflowWorktreeDiff;
}

export interface WorkflowNetworkApprovalRequest {
  workflowId: string;
  manifest: WorkflowManifest;
  objective: string;
  rationale: string;
  input: WorkflowFetchUrlInput;
}

export interface WorkflowAskUserRequest {
  workflowId: string;
  manifest: WorkflowManifest;
  objective: string;
  rationale: string;
  input: WorkflowAskUserInput;
}

export interface WorkflowRun {
  id: string;
  parentAgentId: string;
  objective: string;
  rationale: string;
  status: WorkflowRunStatus;
  script: string;
  manifest: WorkflowManifest;
  resumedFromWorkflowId?: string;
  artifacts: WorkflowArtifact[];
  checkpoints: WorkflowCheckpoint[];
  logs: WorkflowScriptLog[];
  createdAt: number;
  endedAt?: number;
  returnValue?: unknown;
  error?: string;
}

export interface WorkflowStartEvent {
  type: "workflow_start";
  run: WorkflowRun;
}

export interface WorkflowLogEvent {
  type: "workflow_log";
  workflowId: string;
  log: WorkflowScriptLog;
}

export interface WorkflowCheckpointEvent {
  type: "workflow_checkpoint";
  workflowId: string;
  checkpoint: WorkflowCheckpoint;
}

export interface WorkflowArtifactEvent {
  type: "workflow_artifact";
  workflowId: string;
  artifact: WorkflowArtifact;
}

export interface WorkflowEndEvent {
  type: "workflow_end";
  workflowId: string;
  status: Exclude<WorkflowRunStatus, "pending" | "running">;
  endedAt: number;
  artifacts: WorkflowArtifact[];
  checkpoints: WorkflowCheckpoint[];
  logs: WorkflowScriptLog[];
  returnValue?: unknown;
  error?: string;
}

export type WorkflowEvent =
  | WorkflowStartEvent
  | WorkflowLogEvent
  | WorkflowCheckpointEvent
  | WorkflowArtifactEvent
  | WorkflowEndEvent;

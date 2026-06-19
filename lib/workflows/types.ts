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
  draftRef?: string;
  templateParams?: unknown;
  templateRef?: {
    id: string;
    name: string;
    version: string;
  };
  resumeFromWorkflowId?: string;
  resumeFromCheckpointName?: string;
  capabilities?: WorkflowCapability[];
  maxAgents?: number;
  maxConcurrency?: number;
  timeoutMs?: number;
  successCriteria?: WorkflowSuccessCriteria;
}

export interface RunWorkflowTemplateInput {
  templateId: string;
  params?: unknown;
  objective?: string;
  rationale?: string;
  capabilities?: WorkflowCapability[];
  maxAgents?: number;
  maxConcurrency?: number;
  timeoutMs?: number;
}

export type WorkflowJsonSchema = Record<string, unknown>;

export interface WorkflowArtifact {
  name: string;
  value: unknown;
  createdAt: number;
  kind?:
    | "result"
    | "schema_output"
    | "worktree"
    | "diff"
    | "verification"
    | "debug";
  preview?: string;
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
  status:
    | "completed"
    | "completed_with_warnings"
    | "failed"
    | "aborted"
    | "needs_continue";
  manifest: WorkflowManifest;
  resumedFromWorkflowId?: string;
  returnValue?: unknown;
  artifacts: WorkflowArtifact[];
  checkpoints: WorkflowCheckpoint[];
  logs: WorkflowScriptLog[];
  traceEvents: WorkflowTraceEvent[];
  startedAt: number;
  endedAt: number;
  error?: string;
  /** End-state quality warnings (set when status is completed_with_warnings). */
  warnings?: string[];
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

export type WorkflowAgentType =
  | "general"
  | "classifier"
  | "researcher"
  | "implementer"
  | "reviewer"
  | "verifier";

export interface WorkflowAgentInput {
  id?: string;
  title?: string;
  prompt: string;
  schema?: WorkflowJsonSchema;
  model?: string;
  isolation?: "none" | "worktree";
  agentType?: WorkflowAgentType;
  tools?: string[];
  allowedTools?: string[];
  cwd?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface WorkflowAgentResult<T = unknown> {
  title: string;
  status: "completed" | "failed" | "aborted" | "timeout";
  text: string;
  data?: T;
  error?: string;
  taskId: string;
  agentId: string;
  worktree?: WorkflowWorktree;
  artifacts: WorkflowArtifact[];
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

export interface WorkflowMcpToolDescriptor {
  serverId: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Progressive disclosure for MCP (Claude "code execution with MCP"): instead of
 * loading every tool definition up front, the harness searches for relevant
 * tools and chooses how much detail to pull, conserving context.
 */
export type WorkflowMcpDetailLevel = "name" | "summary" | "full";

export interface WorkflowSearchToolsInput {
  /** Case-insensitive substring matched against tool name + description. */
  query?: string;
  /** Restrict to a single MCP server (must be in scope). */
  serverId?: string;
  /** How much of each descriptor to return. Defaults to "summary". */
  detailLevel?: WorkflowMcpDetailLevel;
  /** Max results returned. Defaults to 20. */
  limit?: number;
}

export interface WorkflowCallToolInput {
  server: string;
  tool: string;
  input?: Record<string, unknown>;
}

export interface WorkflowCallToolResult {
  server: string;
  tool: string;
  text: string;
  isError: boolean;
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
  approveMcpTool?: (request: WorkflowMcpToolApprovalRequest) => Promise<ApprovalResponse>;
  askUser?: (request: WorkflowAskUserRequest) => Promise<WorkflowAskUserResult>;
  fetchUrl?: (input: WorkflowFetchUrlInput, signal: AbortSignal) => Promise<WorkflowFetchUrlResult>;
  resolveFetchHost?: (host: string) => Promise<string[]>;
  networkPolicy?: WorkflowNetworkPolicy;
  worktrees?: WorkflowWorktreeManager;
  /** List MCP tools available to a workflow (optionally scoped to a server). */
  listMcpTools?: (serverId?: string) => Promise<WorkflowMcpToolDescriptor[]>;
  /** Invoke an MCP tool through the parent runtime (never from the worker). */
  callMcpTool?: (
    input: WorkflowCallToolInput
  ) => Promise<WorkflowCallToolResult>;
  /** Server ids the workflow is allowed to use; undefined means all enabled. */
  allowedMcpServers?: string[];
}

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "completed"
  // The harness returned normally but failed an end-state quality check
  // (e.g. required artifacts empty/missing). Distinguished from "completed" so
  // the UI and any consuming goal loop can see "formally done, substantively
  // incomplete" instead of a false success.
  | "completed_with_warnings"
  | "needs_continue"
  | "failed"
  | "aborted";

/**
 * End-state quality gate for a workflow run. Evaluated when the harness returns
 * normally. If unmet, the run is downgraded to "completed_with_warnings" with
 * human-readable warnings, instead of silently reporting success.
 */
export interface WorkflowSuccessCriteria {
  /** Artifact names that must exist and be non-empty. */
  requiredArtifacts?: string[];
  /** Minimum number of non-empty artifacts overall. */
  minNonEmptyArtifacts?: number;
  /** If set, the named artifact's string form must be at least this long. */
  minReportChars?: number;
  /** Artifact name to measure for minReportChars (defaults to the last one). */
  reportArtifact?: string;
}

export type WorkflowCapability =
  | "spawn_agent"
  | "read_files"
  | "write_files"
  | "shell"
  | "browser"
  | "network"
  | "worktree"
  | "ask_user"
  | "mcp";

export interface WorkflowManifest {
  capabilities: WorkflowCapability[];
  maxAgents: number;
  maxConcurrency: number;
  timeoutMs: number;
  runtime: "process";
  /** Optional end-state quality gate evaluated when the harness returns. */
  successCriteria?: WorkflowSuccessCriteria;
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

export interface WorkflowMcpToolApprovalRequest {
  workflowId: string;
  manifest: WorkflowManifest;
  objective: string;
  rationale: string;
  input: WorkflowCallToolInput;
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
  traceEvents?: WorkflowTraceEvent[];
  createdAt: number;
  endedAt?: number;
  returnValue?: unknown;
  error?: string;
  /** End-state quality warnings (set when status is completed_with_warnings). */
  warnings?: string[];
}

export interface WorkflowScriptDraft {
  id: string;
  parentAgentId: string;
  title?: string;
  script: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowScriptDraftSummary {
  id: string;
  parentAgentId: string;
  title?: string;
  chars: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description?: string;
  version: string;
  script: string;
  paramsSchema?: WorkflowJsonSchema;
  defaultParams?: unknown;
  capabilities?: WorkflowCapability[];
  maxAgents?: number;
  maxConcurrency?: number;
  timeoutMs?: number;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowTemplateSummary {
  id: string;
  name: string;
  description?: string;
  version: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * A reusable workflow harness saved as a "skill" (Claude Code style). Unlike a
 * template (which is parameterized + versioned for repeated structured runs), a
 * skill is a lighter-weight, named harness body that an orchestrator can read
 * on demand (progressive disclosure) and run via run_workflow_script({ skillRef }).
 * Persisted as ~/.diga-agent/workflows/skills/<name>/{SKILL.md, harness.js}.
 */
export interface WorkflowSkill {
  /** Stable slug; also the folder name. */
  name: string;
  /** One-line human/agent-facing description (the SKILL.md front line). */
  description: string;
  /** Longer markdown body (usage notes, when-to-use, inputs). */
  instructions?: string;
  /** The async workflow harness body executed by the script runtime. */
  harness: string;
  /** Capabilities the harness needs (auto-inferred at run time if omitted). */
  capabilities?: WorkflowCapability[];
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

/** Lightweight skill descriptor for progressive disclosure (no harness body). */
export interface WorkflowSkillSummary {
  name: string;
  description: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowDebugBundle {
  workflow: {
    id: string;
    parentAgentId: string;
    objective: string;
    rationale: string;
    status: WorkflowRunStatus;
    manifest: WorkflowManifest;
    createdAt: number;
    endedAt?: number;
    resumedFromWorkflowId?: string;
    error?: string;
  };
  resume: WorkflowResumeSnapshot;
  script: string;
  counts: {
    artifacts: number;
    checkpoints: number;
    logs: number;
    traceEvents: number;
  };
  artifacts: WorkflowArtifact[];
  checkpoints: WorkflowCheckpoint[];
  logs: WorkflowScriptLog[];
  traceEvents: WorkflowTraceEvent[];
  returnValue?: unknown;
}

export type WorkflowTraceEvent =
  | {
      type: "agent_start";
      workflowId: string;
      agentRunId: string;
      title: string;
      agentType?: WorkflowAgentType;
      role?: SubagentRole;
      model?: string;
      isolation?: "none" | "worktree";
      createdAt: number;
    }
  | {
      type: "agent_end";
      workflowId: string;
      agentRunId: string;
      title: string;
      status: WorkflowAgentResult["status"];
      schemaValid?: boolean;
      error?: string;
      createdAt: number;
    }
  | {
      type: "schema_validation";
      workflowId: string;
      agentRunId?: string;
      valid: boolean;
      errors: string[];
      createdAt: number;
    }
  | {
      type: "approval";
      workflowId: string;
      capability: WorkflowCapability;
      decision: ApprovalResponse["decision"];
      createdAt: number;
    };

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
  traceEvents?: WorkflowTraceEvent[];
  returnValue?: unknown;
  error?: string;
  warnings?: string[];
}

export interface WorkflowTraceRuntimeEvent {
  type: "workflow_trace";
  workflowId: string;
  trace: WorkflowTraceEvent;
}

export type WorkflowEvent =
  | WorkflowStartEvent
  | WorkflowLogEvent
  | WorkflowCheckpointEvent
  | WorkflowArtifactEvent
  | WorkflowEndEvent
  | WorkflowTraceRuntimeEvent;

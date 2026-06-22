export type AgentTeamRunStatus =
  | "draft"
  | "running"
  | "paused"
  | "finalizing"
  | "completed"
  | "failed"
  | "aborted";

export type AgentTeamLeadState =
  | "exploring"
  | "needs_decision"
  | "ready_to_synthesize"
  | "finalized";

export type AgentTeamTaskStatus =
  | "pending"
  | "needs_plan"
  | "claimed"
  | "running"
  | "blocked"
  | "completed";

export type AgentTeamFindingStatus =
  | "proposed"
  | "accepted"
  | "challenged"
  | "rejected";

export type AgentTeamChallengeStatus =
  | "open"
  | "needs_evidence"
  | "resolved"
  | "dismissed";

export type AgentTeamDisplayMode = "workspace" | "in_process" | "split_panes";

export type AgentTeamCapabilityStatus =
  | "implemented"
  | "partial"
  | "planned"
  | "blocked";

export type AgentTeamCoordinationProfile = "none" | "basic" | "full";

export type AgentTeamHookTrigger =
  | "TaskCreated"
  | "TaskCompleted"
  | "TeammateIdle";

export type AgentTeamHookRule =
  | "required_task_needs_finding"
  | "task_needs_evidence"
  | "idle_requires_no_runnable_tasks";

export type AgentTeamEventType =
  | "team_created"
  | "member_spawned"
  | "member_status_changed"
  | "task_created"
  | "task_claimed"
  | "task_blocked"
  | "task_retried"
  | "task_unblocked"
  | "task_completed"
  | "result_submitted"
  | "finding_proposed"
  | "finding_accepted"
  | "finding_rejected"
  | "finding_challenged"
  | "challenge_resolved"
  | "challenge_dismissed"
  | "decision_recorded"
  | "plan_submitted"
  | "plan_approved"
  | "plan_rejected"
  | "message_sent"
  | "member_promoted"
  | "member_replaced"
  | "worktree_created"
  | "worktree_failed"
  | "worktree_cleaned"
  | "worktree_merged"
  | "file_lock_acquired"
  | "file_lock_released"
  | "quality_gate_failed"
  | "team_paused"
  | "team_resumed"
  | "team_finalized"
  | "team_aborted";

export interface AgentTeamMember {
  id: string;
  name: string;
  role: string;
  agentId?: string;
  status: "idle" | "working" | "blocked" | "done";
  currentTaskId?: string;
  latestOutput?: string;
  sessionFile?: string;
  turns?: number;
  costUsd?: number;
  failureCount?: number;
  modelId?: string;
  permissionMode?: "inherit" | "read_only" | "write_allowed" | "dangerous";
  sidebarVisible?: boolean;
  promotedAt?: number;
  spawnedAt?: number;
  lastActiveAt?: number;
  worktree?: {
    id: string;
    path: string;
    branchName: string;
    baseRef: string;
    status: "active" | "merge_pending" | "merged" | "failed" | "cleaned";
    createdAt: number;
    failureReason?: string;
  };
  hydrateState?: "intact" | "rehydrated" | "missing" | "replaced";
  toolCallCounts?: {
    read: number;
    write: number;
    network: number;
    coordination: number;
  };
}

export interface AgentTeamTaskAttempt {
  attempt: number;
  memberId: string;
  status: "completed" | "failed" | "timeout" | "needs_review";
  startedAt: number;
  endedAt?: number;
  resultId?: string;
  error?: string;
}

export interface AgentTeamTask {
  id: string;
  title: string;
  description: string;
  status: AgentTeamTaskStatus;
  ownerAgentId?: string;
  claimedAt?: number;
  completedAt?: number;
  assignedAgentId?: string;
  planId?: string;
  resultId?: string;
  completionSource?: "manual" | "teammate_result" | "lead_override";
  expectedOutput?: "findings" | "review" | "implementation" | "plan" | "decision_input";
  acceptanceCriteria?: string[];
  evidenceRequired?: boolean;
  maxAttempts?: number;
  dependsOnTaskIds?: string[];
  blocker?: string;
  retryCount?: number;
  lastError?: string;
  writePaths?: string[];
  priority: "low" | "normal" | "high";
  required: boolean;
  findingIds: string[];
  attempts?: AgentTeamTaskAttempt[];
  worktreeId?: string;
  selfClaimedAt?: number;
  selfClaimedToolCallId?: string;
}

export interface AgentTeamFinding {
  id: string;
  taskId?: string;
  authorAgentId: string;
  claim: string;
  evidenceRefs: string[];
  confidence: "low" | "medium" | "high";
  status: AgentTeamFindingStatus;
  challengeIds: string[];
  sourceResultId?: string;
  acceptedByAgentId?: string;
  acceptedAt?: number;
  rejectedByAgentId?: string;
  rejectedAt?: number;
  rejectionReason?: string;
  provenance?: AgentTeamEvidenceRef[];
}

export interface AgentTeamChallenge {
  id: string;
  targetFindingId: string;
  authorAgentId: string;
  reason: string;
  severity: "low" | "medium" | "high";
  status: AgentTeamChallengeStatus;
  resolution?: string;
  sourceResultId?: string;
  createdAt?: number;
  resolvedAt?: number;
  resolvedByAgentId?: string;
  resolutionFindingIds?: string[];
  requiredEvidenceRefs?: string[];
}

export interface AgentTeamDecision {
  id: string;
  title: string;
  rationale: string;
  acceptedFindingIds: string[];
  rejectedFindingIds: string[];
  challengeIds?: string[];
  evidenceRefs?: string[];
  sourceResultIds?: string[];
  confidence?: "low" | "medium" | "high";
  status?: "draft" | "accepted" | "superseded";
  madeByAgentId: string;
  createdAt?: number;
}

export interface AgentTeamEvidenceRef {
  kind: "result" | "session" | "artifact" | "file" | "message" | "task";
  ref: string;
  quote?: string;
}

export interface AgentTeamResult {
  id: string;
  taskId: string;
  authorAgentId: string;
  sessionFile?: string;
  rawText: string;
  summary: string;
  parsedAt: number;
  status: "parsed" | "needs_review" | "rejected";
  findingIds: string[];
  challengeIds: string[];
  evidenceRefs: string[];
  parseWarnings: string[];
}

export interface AgentTeamPlan {
  id: string;
  taskId: string;
  authorAgentId: string;
  body: string;
  status: "requested" | "submitted" | "approved" | "rejected";
  submittedAt?: number;
  reviewedAt?: number;
  reviewedByAgentId?: string;
  rejectionReason?: string;
  criteria: string[];
}

export interface AgentTeamMessage {
  id: string;
  fromAgentId: string;
  toAgentId?: string;
  body: string;
  createdAt: number;
  taskId?: string;
  findingId?: string;
  challengeId?: string;
}

export interface AgentTeamQualityGate {
  id: string;
  title: string;
  status: "pending" | "passed" | "failed";
  severity: "info" | "warning" | "blocking";
  message: string;
  checkedAt?: number;
  relatedTaskIds?: string[];
  relatedFindingIds?: string[];
  relatedChallengeIds?: string[];
}

export interface AgentTeamHook {
  id: string;
  title: string;
  trigger: AgentTeamHookTrigger;
  rule: AgentTeamHookRule;
  enabled: boolean;
  severity: "info" | "warning" | "blocking";
  status: "pending" | "passed" | "failed";
  message: string;
  lastCheckedAt?: number;
  lastFailure?: string;
}

export interface AgentTeamFileLock {
  id: string;
  path: string;
  ownerAgentId: string;
  taskId: string;
  status: "active" | "released";
  acquiredAt: number;
  releasedAt?: number;
}

export interface AgentTeamCapabilityAuditItem {
  id: string;
  title: string;
  claudeCapability: string;
  digaStatus: AgentTeamCapabilityStatus;
  evidence: string[];
  gap?: string;
  nextStep?: string;
}

export interface AgentTeamSettings {
  memberScale: "small" | "standard" | "deep";
  allowNetwork: boolean;
  allowWrite: boolean;
  allowWorktree: boolean;
  allowChallenges: boolean;
  requirePlanApproval: boolean;
  displayMode: AgentTeamDisplayMode;
  writePolicy?: "read_only" | "plan_approval" | "write_allowed";
  networkPolicy?: "disabled" | "lead_only" | "teammates_allowed";
  worktreePolicy?: "none" | "per_member" | "per_task";
  resultIngestionMode?: "structured" | "transcript_summary";
  coordinationProfile?: AgentTeamCoordinationProfile;
  stopConditions: {
    requiredTasksComplete: boolean;
    noOpenBlockingChallenges: boolean;
    leadFinalSynthesis: boolean;
  };
}

export interface AgentTeamCoordinationCall {
  id: string;
  at: number;
  memberId: string;
  toolName: string;
  args: Record<string, unknown>;
  outcome: "ok" | "rejected";
  rejectionReason?: string;
}

export interface AgentTeamEvent {
  id: string;
  type: AgentTeamEventType;
  at: number;
  actorAgentId?: string;
  targetAgentId?: string;
  taskId?: string;
  findingId?: string;
  challengeId?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface AgentTeamBoard {
  summary: string;
  tasks: AgentTeamTask[];
  results: AgentTeamResult[];
  plans: AgentTeamPlan[];
  findings: AgentTeamFinding[];
  challenges: AgentTeamChallenge[];
  decisions: AgentTeamDecision[];
  messages: AgentTeamMessage[];
  fileLocks: AgentTeamFileLock[];
  hooks: AgentTeamHook[];
  qualityGates: AgentTeamQualityGate[];
  capabilityAudit: AgentTeamCapabilityAuditItem[];
  events: AgentTeamEvent[];
}

export interface AgentTeamRun {
  id: string;
  parentAgentId?: string;
  parentSessionPath?: string;
  objective: string;
  status: AgentTeamRunStatus;
  leadState: AgentTeamLeadState;
  leadAgentId: string;
  members: AgentTeamMember[];
  board: AgentTeamBoard;
  settings: AgentTeamSettings;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  error?: string;
  hydrate?: {
    lastHydratedAt: number;
    rehydratedMemberIds: string[];
    missingMemberIds: string[];
    notes?: string;
  };
  worktreeRoot?: string;
  coordinationAudit?: AgentTeamCoordinationCall[];
  plannerProfile?: "deterministic" | "llm";
  plannerInputs?: { objective: string; tags: string[] };
}

export interface AgentTeamRunStartedEvent {
  type: "agent_team_run_start";
  run: AgentTeamRun;
}

export interface AgentTeamRunUpdatedEvent {
  type: "agent_team_run_update";
  run: AgentTeamRun;
}

export interface AgentTeamRunFinalizedEvent {
  type: "agent_team_run_finalized";
  run: AgentTeamRun;
}

export type AgentTeamRuntimeEvent =
  | AgentTeamRunStartedEvent
  | AgentTeamRunUpdatedEvent
  | AgentTeamRunFinalizedEvent;

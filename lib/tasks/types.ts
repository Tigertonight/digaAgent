export type LongTaskCadence = "manual" | "daily" | "weekly";

export type LongTaskStatus =
  | "idle"
  | "scheduled"
  | "running"
  | "waiting_user"
  | "completed"
  | "failed"
  | "paused"
  | "archived";

export type LongTaskRunStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "completed_with_findings"
  | "completed_empty"
  | "failed"
  | "aborted";

export type TaskFindingSeverity = "info" | "warning" | "critical";
export type TaskFindingStatus = "unread" | "reviewed" | "resolved" | "archived";
export type LongTaskCheckpointKind =
  | "queued"
  | "started"
  | "waiting_user"
  | "resumed"
  | "completed"
  | "failed";

export interface TaskPermissionPolicy {
  requireApprovalBeforeWrite: boolean;
  requireApprovalBeforeNetwork: boolean;
  maxDurationMinutes: number;
}

export interface LongTaskDefinition {
  id: string;
  title: string;
  prompt: string;
  projectPath: string;
  provider: string;
  modelId: string;
  cadence: LongTaskCadence;
  enabled: boolean;
  skillIds: string[];
  permissionPolicy: TaskPermissionPolicy;
  status: LongTaskStatus;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  lastRunId?: string;
  lastSummary?: string;
  failureReason?: string;
}

export interface LongTaskRun {
  id: string;
  taskId: string;
  status: LongTaskRunStatus;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  agentId?: string;
  sessionId?: string;
  sessionFile?: string;
  summary?: string;
  waitingReason?: string;
  error?: string;
  checkpoints: LongTaskCheckpoint[];
  findingIds: string[];
}

export interface LongTaskCheckpoint {
  id: string;
  kind: LongTaskCheckpointKind;
  title: string;
  detail?: string;
  createdAt: number;
}

export interface TaskFinding {
  id: string;
  taskId: string;
  runId: string;
  title: string;
  body: string;
  severity: TaskFindingSeverity;
  status: TaskFindingStatus;
  createdAt: number;
  updatedAt: number;
}

export interface LongTaskCreateInput {
  title: string;
  prompt: string;
  projectPath: string;
  provider: string;
  modelId: string;
  cadence?: LongTaskCadence;
  enabled?: boolean;
  skillIds?: string[];
  permissionPolicy?: Partial<TaskPermissionPolicy>;
}

export interface LongTaskUpdateInput extends Partial<LongTaskCreateInput> {
  status?: LongTaskStatus;
}

export interface LongTaskDashboard {
  tasks: LongTaskDefinition[];
  runs: LongTaskRun[];
  findings: TaskFinding[];
  dueTasks: LongTaskDefinition[];
  inboxCount: number;
  scheduler?: LongTaskSchedulerState;
}

export interface LongTaskSchedulerState {
  enabled: boolean;
  intervalMs: number;
  running: boolean;
  lastCheckedAt?: number;
  lastStartedCount?: number;
  lastError?: string;
}

export type EvidenceKind =
  | "browser_snapshot"
  | "browser_step"
  | "browser_annotation"
  | "workflow_artifact"
  | "agent_team_finding"
  | "subagent_result"
  | "goal_turn"
  | "approval_decision"
  | "progress_artifact"
  | "log";

export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  title: string;
  sessionId?: string | null;
  agentId?: string | null;
  browserId?: string | null;
  taskId?: string | null;
  workflowId?: string | null;
  url?: string | null;
  filePath?: string;
  screenshotDataUrl?: string | null;
  textPreview?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt?: number;
}

export interface EvidenceListFilter {
  sessionId?: string | null;
  agentId?: string | null;
  browserId?: string | null;
  taskId?: string | null;
  workflowId?: string | null;
  kind?: EvidenceKind;
}

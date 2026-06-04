export type ProgressStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "failed";

export type ProgressArtifactKind =
  | "file"
  | "url"
  | "screenshot"
  | "test"
  | "diff"
  | "log"
  | "browser"
  | "other";

export interface ProgressStep {
  id: string;
  title: string;
  status: ProgressStepStatus;
  summary?: string;
  evidenceIds?: string[];
  startedAt?: number;
  completedAt?: number;
}

export interface ProgressArtifact {
  id: string;
  kind: ProgressArtifactKind;
  title: string;
  href?: string;
  summary?: string;
  createdAt: number;
}

export interface AgentProgress {
  steps: ProgressStep[];
  artifacts: ProgressArtifact[];
  updatedAt: number;
}

export interface ProgressUpdatedEvent {
  type: "progress_updated";
  progress: AgentProgress;
}

export interface ProgressStepUpdateInput {
  id?: string;
  title: string;
  status: ProgressStepStatus;
  summary?: string;
  evidenceIds?: string[];
}

export interface ProgressArtifactUpdateInput {
  id?: string;
  kind: ProgressArtifactKind;
  title: string;
  href?: string;
  summary?: string;
}

export interface ProgressUpdateInput {
  steps?: ProgressStepUpdateInput[];
  artifacts?: ProgressArtifactUpdateInput[];
  replaceSteps?: boolean;
  replaceArtifacts?: boolean;
}

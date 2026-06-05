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

/**
 * A progress group is one self-contained batch of steps with its own 1-based
 * numbering. A new group is opened whenever the agent replaces the step list
 * (replaceSteps), so a later round of work shows as a fresh "1..N" group
 * instead of accumulating onto the previous one.
 */
export interface ProgressGroup {
  id: string;
  /** 1-based group order. */
  index: number;
  steps: ProgressStep[];
  startedAt: number;
  endedAt?: number;
}

export interface AgentProgress {
  /**
   * Steps of the CURRENT (latest) group. Kept for backward compatibility with
   * existing consumers; UI prefers `groups` when present.
   */
  steps: ProgressStep[];
  /** Ordered progress groups; the last one is the current group. */
  groups: ProgressGroup[];
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

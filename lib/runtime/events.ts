import type { EvidenceRef } from "@/lib/evidence/types";

export type RuntimeEventSource =
  | "agent"
  | "browser"
  | "workflow"
  | "subagent"
  | "goal"
  | "approval"
  | "progress";

export type RuntimeEventStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "blocked"
  | "aborted";

export interface RuntimeEvent<TPayload = unknown> {
  id: string;
  source: RuntimeEventSource;
  type: string;
  status?: RuntimeEventStatus;
  sessionId?: string | null;
  agentId?: string | null;
  browserId?: string | null;
  taskId?: string | null;
  workflowId?: string | null;
  parentId?: string | null;
  payload: TPayload;
  evidence?: EvidenceRef[];
  createdAt: number;
  updatedAt?: number;
}

export interface RuntimeEventListFilter {
  source?: RuntimeEventSource;
  status?: RuntimeEventStatus;
  sessionId?: string | null;
  agentId?: string | null;
  browserId?: string | null;
  taskId?: string | null;
  workflowId?: string | null;
  parentId?: string | null;
}

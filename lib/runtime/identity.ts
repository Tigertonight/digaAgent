import {
  agentBrowserId,
  standaloneBrowserId,
  taskBrowserId,
} from "@/lib/browser/browser-id";

export type RuntimeMode = "draft" | "persisted_only" | "live";

export interface RuntimeIdentity {
  mode: RuntimeMode;
  sessionId: string | null;
  sessionPath: string | null;
  cwd: string;
  runnerKey: string;
  agentId: string | null;
  browserId: string;
  goalId?: string | null;
  taskId?: string | null;
}

export interface RuntimeIdentityInput {
  selectedSessionId: string | null;
  selectedSessionPath: string | null;
  cwd: string;
  activeRunnerKey: string;
  liveAgentId: string | null;
  goalId?: string | null;
  taskId?: string | null;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function browserIdForRuntime(input: {
  agentId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
}): string {
  const taskId = clean(input.taskId);
  if (taskId) return taskBrowserId(taskId);

  const agentId = clean(input.agentId);
  if (agentId) return agentBrowserId(agentId);

  const sessionId = clean(input.sessionId);
  if (sessionId) return standaloneBrowserId(`session:${sessionId}`);

  return standaloneBrowserId("default");
}

export function resolveRuntimeIdentity(
  input: RuntimeIdentityInput
): RuntimeIdentity {
  const sessionId = clean(input.selectedSessionId);
  const sessionPath = clean(input.selectedSessionPath);
  const agentId = clean(input.liveAgentId);
  const taskId = clean(input.taskId);
  const goalId = clean(input.goalId);

  const mode: RuntimeMode = agentId
    ? "live"
    : sessionId
      ? "persisted_only"
      : "draft";

  return {
    mode,
    sessionId,
    sessionPath,
    cwd: input.cwd,
    runnerKey: input.activeRunnerKey,
    agentId,
    browserId: browserIdForRuntime({ agentId, sessionId, taskId }),
    ...(goalId ? { goalId } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

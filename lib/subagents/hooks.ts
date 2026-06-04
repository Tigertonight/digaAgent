import "server-only";
import type { SubagentDefinition } from "./definition";
import type {
  SubagentResult,
  SubagentTaskRuntime,
  SubagentTaskVerification,
} from "./types";
import { getSubagentMemory, updateSubagentMemory } from "./memory";

export type SubagentHook =
  | "SubagentStart"
  | "SubagentStop"
  | "BeforeToolUse"
  | "AfterToolUse";

/** Dangerous shell patterns reused from the collab dangerous-bash rule idea. */
const DANGEROUS_SHELL = [
  /rm\s+-rf/i,
  /rm\s+-fr/i,
  /git\s+reset\s+--hard/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, // fork bomb
  /mkfs/i,
  /dd\s+if=/i,
  />\s*\/dev\/sd/i,
];

/**
 * BeforeToolUse hook (pure): decide whether a tool call should be denied.
 * M1 only implements `deny-dangerous-shell`.
 */
export function isDangerousShellCommand(command: string | undefined): boolean {
  if (!command) return false;
  return DANGEROUS_SHELL.some((re) => re.test(command));
}

export interface SubagentStartHookResult {
  fired: boolean;
  hooks: string[];
  notes: string[];
}

/**
 * SubagentStart hook (Sprint 4): runs after the child agent is created, before
 * its prompt. M1 only supports informational hooks (no mutation), recorded for
 * audit. Returns which hooks fired so the orchestrator can log them.
 */
export function runSubagentStartHook(
  definition: SubagentDefinition | null,
  ctx: { taskId: string; agentId: string; role: string }
): SubagentStartHookResult {
  const hooks = definition?.hooks?.subagentStart ?? [];
  if (hooks.length === 0) return { fired: false, hooks: [], notes: [] };
  const notes: string[] = [];
  if (hooks.includes("log-start")) {
    notes.push(
      `Specialist ${definition?.id} started for task ${ctx.taskId} (agent ${ctx.agentId}, role ${ctx.role}).`
    );
  }
  return { fired: notes.length > 0, hooks, notes };
}

/**
 * AfterToolUse hook (Sprint 4 placeholder). Declared so definitions can carry
 * it and the type surface is stable; full wiring (subscribing to child tool
 * events to record evidence) is deferred to a later phase.
 */
export function runAfterToolUseHook(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder extension point (M1 no-op)
  hookNames: string[] | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- placeholder extension point (M1 no-op)
  input: { toolName: string; ok: boolean }
): { recorded: boolean } {
  // Intentionally a no-op in M1. Kept as an extension point.
  return { recorded: false };
}

export interface BeforeToolUseDecision {
  decision: "allow" | "deny";
  reason?: string;
  hook?: string;
}

export function runBeforeToolUseHook(
  hookNames: string[] | undefined,
  input: { toolName: string; command?: string }
): BeforeToolUseDecision {
  if (!hookNames || hookNames.length === 0) return { decision: "allow" };
  if (
    hookNames.includes("deny-dangerous-shell") &&
    (input.toolName === "bash" || input.toolName === "shell") &&
    isDangerousShellCommand(input.command)
  ) {
    return {
      decision: "deny",
      reason: "Blocked by deny-dangerous-shell hook (destructive command).",
      hook: "deny-dangerous-shell",
    };
  }
  return { decision: "allow" };
}

/**
 * Extract compact memory updates from a finished task result (pure). M1 uses
 * rule-based extraction (no LLM): verification warnings and explicit risk
 * phrases become recurring risks.
 */
export function extractMemoryFromResult(
  task: SubagentTaskRuntime,
  result: SubagentResult,
  verification?: SubagentTaskVerification
): { recurringRisks: string[] } {
  const risks: string[] = [];

  // Verification warnings are recurring risks worth remembering.
  for (const check of verification?.checks ?? []) {
    if (check.status === "warning" || check.status === "failed") {
      risks.push(`${task.title}: ${check.message}`.slice(0, 200));
    }
  }

  // Explicit risk phrases in the answer.
  const answer = result.answer ?? "";
  const riskLines = answer
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) =>
      /(risk|regression|missing test|security|vulnerab|race condition|风险|缺少测试|安全)/i.test(
        l
      )
    )
    .slice(0, 3)
    .map((l) => l.slice(0, 200));
  risks.push(...riskLines);

  return { recurringRisks: dedupe(risks).slice(0, 5) };
}

export interface SubagentStopHookResult {
  updatedMemory: boolean;
  addedRisks: string[];
}

/**
 * SubagentStop hook: update the specialist's project memory from the result.
 * No-op unless the definition declares the `update-memory-from-result` hook.
 */
export function runSubagentStopHook(
  definition: SubagentDefinition | null,
  task: SubagentTaskRuntime,
  result: SubagentResult,
  verification?: SubagentTaskVerification
): SubagentStopHookResult {
  if (!definition) return { updatedMemory: false, addedRisks: [] };
  const hooks = definition.hooks?.subagentStop ?? [];
  if (!hooks.includes("update-memory-from-result")) {
    return { updatedMemory: false, addedRisks: [] };
  }
  const { recurringRisks } = extractMemoryFromResult(task, result, verification);
  if (recurringRisks.length === 0) {
    return { updatedMemory: false, addedRisks: [] };
  }
  // Merge with existing risks (dedupe) and persist.
  const existing = getSubagentMemory(definition.id, "project");
  const merged = dedupe([
    ...(existing?.recurringRisks ?? []),
    ...recurringRisks,
  ]);
  updateSubagentMemory(definition.id, "project", { recurringRisks: merged });
  return { updatedMemory: true, addedRisks: recurringRisks };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));
}

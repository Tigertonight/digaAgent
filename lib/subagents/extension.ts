import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  SubagentAuditEvent,
  DelegateSubagentsInput,
  SubagentBatchPlan,
  SubagentBatchSynthesis,
  SubagentResult,
  SubagentRole,
} from "./types";
import { planSubagents, type SubagentPlannerRecommendation } from "./planner";
import { diagnoseOversizedToolPayload } from "@/lib/tool-recovery/truncation-diagnosis";

const RoleSchema = Type.Union([
  Type.Literal("general"),
  Type.Literal("rag"),
  Type.Literal("research"),
  Type.Literal("code-review"),
  Type.Literal("implementation"),
]);

const IsolationSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("worktree"),
]);

const TaskSchema = Type.Object({
  id: Type.Optional(
    Type.String({ description: "Stable task id, e.g. q1 or module-hooks." })
  ),
  title: Type.String({
    description:
      "Subagent 子任务的高信息密度标题（会直接进入 sidebar / batch 卡片 / session list）。\n" +
      "要求：\n" +
      "- 8–24 字符（中文 4–12 字）。\n" +
      "- 包含明确的对象 + 动作，例如“检查 Electron 启动链路”、“梳理 Sidebar 标题来源”、\n" +
      "  “验证 Workflow 续跑语义”。\n" +
      "- 不要用 “Question 1 / Task 1 / Review / Subtask” 这种无区分性模板。\n" +
      "- 不要重复 “subagent 作为 / 帮我检查一下” 这种上下文词。",
  }),
  prompt: Type.String({
    description:
      "Complete standalone task prompt. Include all context the subagent needs.",
  }),
  role: Type.Optional(RoleSchema),
  specialistId: Type.Optional(
    Type.String({
      description:
        "Optional registered specialist id (from .agents/subagents/*.md) to run this task as. Merges that specialist's prompt, tools, and permission mode.",
    })
  ),
  isolation: Type.Optional(
    IsolationSchema
  ),
  cwd: Type.Optional(
    Type.String({ description: "Optional working directory override." })
  ),
  allowedTools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional explicit tool allowlist. Omit for the safe role defaults.",
    })
  ),
  writePaths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Explicit file or directory paths this subagent may modify. Write-capable allowedTools are stripped unless writePaths is provided.",
    })
  ),
  maxTurns: Type.Optional(Type.Number()),
  timeoutMs: Type.Optional(
    Type.Number({
      description:
        "Optional task timeout in milliseconds. Subagent runtime normalizes task timeouts to 1800000 ms (30 minutes).",
    })
  ),
});

const DelegateParams = Type.Object({
  reason: Type.String({
    description: "Why this task should be split across subagents.",
  }),
  tasks: Type.Optional(
    Type.Array(TaskSchema, {
      description:
        "Independent tasks. Each subagent handles exactly one task and does not solve siblings. " +
        "Required in practice — declared optional only so a truncated call (missing tasks) yields an actionable error instead of a generic schema failure. " +
        "Keep each task.prompt focused; if the overall call gets large, split into fewer tasks per call or have subagents read context from files instead of inlining it.",
    })
  ),
  concurrency: Type.Optional(
    Type.Number({ description: "Maximum parallel subagents. Defaults to 4." })
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run the batch in the background and return immediately. Results arrive via a later batch-end event. Use for long-running batches the user does not want to block on.",
    })
  ),
  synthesisInstructions: Type.Optional(
    Type.String({
      description:
        "Instructions for how the main agent should combine the subagent results.",
    })
  ),
});

const PlannerTaskSchema = Type.Object({
  id: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  role: Type.Optional(RoleSchema),
});

const PlannerParams = Type.Object({
  goal: Type.String({
    description:
      "The user goal or current request to evaluate for multi-agent fan-out.",
  }),
  candidateTasks: Type.Optional(
    Type.Array(PlannerTaskSchema, {
      description:
        "Optional candidate independent tasks if the main agent has already sketched them.",
    })
  ),
});

interface DelegateDetails {
  batchId: string;
  results: SubagentResult[];
  planning?: SubagentBatchPlan;
  synthesis?: SubagentBatchSynthesis;
  auditEvents?: SubagentAuditEvent[];
}

type DelegateParamsValue = {
  reason: string;
  tasks?: Array<{
    id?: string;
    title: string;
    prompt: string;
    role?: unknown;
    specialistId?: string;
    isolation?: "none" | "worktree";
    cwd?: string;
    allowedTools?: string[];
    writePaths?: string[];
    maxTurns?: number;
    timeoutMs?: number;
  }>;
  concurrency?: number;
  synthesisInstructions?: string;
  background?: boolean;
};

type PlannerParamsValue = {
  goal: string;
  candidateTasks?: Array<{
    id?: string;
    title?: string;
    prompt?: string;
    role?: unknown;
  }>;
};

export interface SubagentsExtensionOptions {
  onDelegate: (
    input: DelegateSubagentsInput,
    signal?: AbortSignal
  ) => Promise<{
    batchId: string;
    results: SubagentResult[];
    planning?: SubagentBatchPlan;
    synthesis?: SubagentBatchSynthesis;
    auditEvents?: SubagentAuditEvent[];
  }>;
}

function normalizePlannerInput(params: PlannerParamsValue) {
  return {
    goal: params.goal,
    candidateTasks: params.candidateTasks?.map((task) => ({
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      role: normalizeRole(task.role),
    })),
  };
}

function normalizeRole(role: unknown): SubagentRole | undefined {
  return role === "general" ||
    role === "rag" ||
    role === "research" ||
    role === "code-review" ||
    role === "implementation"
    ? role
    : undefined;
}

function normalizeIsolation(
  value: unknown
): "none" | "worktree" | undefined {
  return value === "none" || value === "worktree" ? value : undefined;
}

function normalizeInput(params: DelegateParamsValue): DelegateSubagentsInput {
  return {
    reason: params.reason,
    concurrency: params.concurrency,
    synthesisInstructions: params.synthesisInstructions,
    background: params.background,
    tasks: (params.tasks ?? []).map((task, index) => ({
      id: task.id || `task-${index + 1}`,
      title: task.title,
      prompt: task.prompt,
      role: normalizeRole(task.role),
      specialistId: task.specialistId,
      isolation: normalizeIsolation(task.isolation),
      cwd: task.cwd,
      allowedTools: task.allowedTools,
      writePaths: task.writePaths,
      maxTurns: task.maxTurns,
      timeoutMs: task.timeoutMs,
    })),
  };
}

function resultSummary(results: SubagentResult[]): string {
  return results
    .map((result, index) => {
      const header = `## ${index + 1}. ${result.taskId} (${result.status})`;
      if (result.status !== "completed") {
        return [header, result.error ? `Error: ${result.error}` : "No answer."].join(
          "\n"
        );
      }
      return [header, result.answer || "(empty answer)"].join("\n");
    })
    .join("\n\n");
}

function synthesisSummary(synthesis: SubagentBatchSynthesis | undefined): string {
  if (!synthesis) return "No synthesis artifact was produced.";
  const sections = [
    `Status: ${synthesis.status}`,
    synthesis.summary,
    `Usable task ids: ${synthesis.usableTaskIds.join(", ") || "(none)"}`,
    `Caution task ids: ${synthesis.cautionTaskIds.join(", ") || "(none)"}`,
    `Rejected task ids: ${synthesis.rejectedTaskIds.join(", ") || "(none)"}`,
  ];
  if (synthesis.instructions) {
    sections.push(`Caller synthesis instructions: ${synthesis.instructions}`);
  }
  sections.push(
    "When answering the user, rely on usable tasks, label caution tasks, and do not silently use rejected tasks."
  );
  return sections.join("\n");
}

function planningSummary(planning: SubagentBatchPlan | undefined): string {
  if (!planning) return "No planning artifact was produced.";
  return [
    `Status: ${planning.status}`,
    `Tasks: ${planning.taskCount}`,
    `Concurrency: ${planning.concurrency}/${planning.maxConcurrency}`,
    planning.requestedConcurrency !== undefined
      ? `Requested concurrency: ${planning.requestedConcurrency}`
      : null,
    planning.warnings.length
      ? `Warnings: ${planning.warnings.join(" | ")}`
      : "Warnings: none",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function createDelegateSubagentsTool(
  opts: SubagentsExtensionOptions
): ToolDefinition<typeof DelegateParams, DelegateDetails> {
  return defineTool<typeof DelegateParams, DelegateDetails>({
    name: "delegate_subagents",
    label: "Delegate Subagents",
    description:
      "Run multiple independent subagents in parallel and return their results for synthesis. Use for batch Q&A, multi-document RAG, multi-role analysis, or modular code review. Do not use for small tasks, tightly sequential work, or parallel edits to the same files.",
    promptSnippet:
      "delegate_subagents: split independent work into multiple parallel subagents and synthesize their results.",
    promptGuidelines: [
      "For unclear complex requests, call plan_subagents first to decide whether fan-out is justified and to draft independent tasks.",
      "Use delegate_subagents when the user explicitly asks for multiple subagents or when 4+ independent subtasks can run in parallel.",
      "Each task prompt must be standalone and scoped to exactly one subtask.",
      "AVOID TRUNCATION: the tasks array can get large because each prompt is long. If you have many tasks, prefer 2–4 focused tasks per call (add more via follow-up calls) and keep each prompt tight — point subagents at files/paths to read instead of pasting large context inline. An oversized call can be cut off before `tasks` is emitted.",
      "Do not delegate tasks that require parallel file edits unless the user explicitly asks and the edit boundaries are isolated.",
      "After delegate_subagents returns, synthesize the results; do not merely paste them verbatim unless the user asked for per-task answers.",
      "Each task.title must be a high-signal scannable name (8–24 chars / 4–12 中文字) that pairs an object and an action, e.g. '检查 Electron 启动链路'. Do not use 'Question 1 / Task 1 / Review' or repeat 'subagent / 帮我检查'—titles drive sidebar discovery for parallel tasks.",
    ],
    parameters: DelegateParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal) {
      const oversized = diagnoseOversizedToolPayload({
        toolName: "delegate_subagents",
        args: params,
      });
      if (oversized) {
        throw new Error(
          `${oversized.userMessage} Diagnostic: ${oversized.reason}`
        );
      }
      // tasks is declared optional in the schema so a truncated tool call (very
      // common: each task.prompt is long, so the model's output hits the length
      // limit before `tasks` is emitted) reaches here instead of being rejected
      // with an opaque "must have required properties tasks". Give actionable
      // recovery guidance — the same failure mode handled for run_workflow_script.
      if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
        throw new Error(
          "delegate_subagents was called without any tasks. This usually means the tool " +
            "call was truncated by the model output limit before the (often long) tasks " +
            "array was emitted. Recover by: (1) sending fewer tasks per call (e.g. 2–3) " +
            "and adding more in follow-up calls, (2) shortening each task.prompt and having " +
            "subagents read large context from files instead of inlining it, or " +
            "(3) using plan_subagents first to draft compact tasks. Do not retry the same " +
            "oversized call unchanged."
        );
      }
      const input = normalizeInput(params);
      const { batchId, results, planning, synthesis, auditEvents } = await opts.onDelegate(
        input,
        signal
      );
      // Background batches return immediately with no results; tell the model
      // it will be notified when the batch finishes.
      if (input.background) {
        return {
          content: [
            {
              type: "text",
              text: [
                `Subagent batch ${batchId} was detached to the background and is running.`,
                "You will receive its results in a later batch-end update. Continue with other work; do not wait synchronously.",
                "",
                "## Planning policy",
                planningSummary(planning),
              ].join("\n"),
            },
          ],
          details: { batchId, results, planning, synthesis, auditEvents },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: [
              `Subagent batch ${batchId} completed with ${results.length} result(s).`,
              "",
              "## Planning policy",
              planningSummary(planning),
              "",
              "## Synthesis guidance",
              synthesisSummary(synthesis),
              "",
              resultSummary(results),
            ].join("\n"),
          },
        ],
        details: { batchId, results, planning, synthesis, auditEvents },
      };
    },
  });
}

function plannerSummary(plan: SubagentPlannerRecommendation): string {
  return [
    `Mode: ${plan.mode}`,
    `Confidence: ${plan.confidence}`,
    `Reason: ${plan.reason}`,
    `Signals: ${plan.signals.join(", ") || "(none)"}`,
    `Suggested concurrency: ${plan.suggestedConcurrency}`,
    `Task count: ${plan.taskCount}`,
    plan.tasks.length
      ? [
          "",
          "Suggested tasks:",
          ...plan.tasks.map(
            (task, index) =>
              `${index + 1}. ${task.title} [${task.role ?? "general"}]`
          ),
        ].join("\n")
      : "",
    plan.availableSpecialists.length
      ? [
          "",
          "Available specialists (assign via task.specialistId):",
          ...plan.availableSpecialists.map(
            (s) => `- ${s.id}: ${s.description}`
          ),
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface PlanSubagentsToolOptions {
  /** Optional registry hint provider so the planner can surface specialists. */
  getSpecialists?: () => Array<{
    id: string;
    title: string;
    description: string;
  }>;
}

export function createPlanSubagentsTool(
  opts: PlanSubagentsToolOptions = {}
): ToolDefinition<typeof PlannerParams, SubagentPlannerRecommendation> {
  return defineTool<typeof PlannerParams, SubagentPlannerRecommendation>({
    name: "plan_subagents",
    label: "Plan Subagents",
    description:
      "Heuristically decide whether a user goal should fan out into multiple subagents before calling delegate_subagents. Returns mode, confidence, signals, suggested concurrency, and draft independent tasks.",
    promptSnippet:
      "plan_subagents: evaluate whether a complex goal should use multiple subagents before delegating.",
    promptGuidelines: [
      "Use plan_subagents before delegate_subagents when the user asks for a broad, batched, multi-document, multi-module, or multi-question task and the split is not already obvious.",
      "If the recommendation is multi-agent, convert the suggested tasks into delegate_subagents tasks and synthesize after execution.",
      "If the recommendation is single-agent, answer directly or ask for clarification instead of forcing fan-out.",
    ],
    parameters: PlannerParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const availableSpecialists = opts.getSpecialists?.() ?? [];
      const recommendation = planSubagents({
        ...normalizePlannerInput(params),
        availableSpecialists,
      });
      return {
        content: [
          {
            type: "text",
            text: ["## Subagent planner recommendation", plannerSummary(recommendation)].join(
              "\n"
            ),
          },
        ],
        details: recommendation,
      };
    },
  });
}

export function createSubagentsExtension(
  opts: SubagentsExtensionOptions & PlanSubagentsToolOptions
): ExtensionFactory {
  return (pi) => {
    pi.registerTool(
      createPlanSubagentsTool({ getSpecialists: opts.getSpecialists })
    );
    pi.registerTool(createDelegateSubagentsTool(opts));
  };
}

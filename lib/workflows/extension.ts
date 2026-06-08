import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  DynamicWorkflowResult,
  RunDynamicWorkflowInput,
  RunWorkflowScriptInput,
  RunWorkflowTemplateInput,
  WorkflowStep,
  WorkflowScriptResult,
} from "./types";
import { validateJsonSchema } from "./json-schema";
import { getWorkflowTemplate } from "./template-store";

const RoleSchema = Type.Union([
  Type.Literal("general"),
  Type.Literal("rag"),
  Type.Literal("research"),
  Type.Literal("code-review"),
  Type.Literal("implementation"),
]);

const StepSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable step id." })),
  title: Type.String({ description: "Short visible step title." }),
  prompt: Type.String({
    description: "Standalone instruction for this workflow step.",
  }),
  role: Type.Optional(RoleSchema),
  cwd: Type.Optional(Type.String()),
  allowedTools: Type.Optional(Type.Array(Type.String())),
  maxTurns: Type.Optional(Type.Number()),
  timeoutMs: Type.Optional(Type.Number()),
});

const StageSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Stable stage id." })),
  title: Type.String({ description: "Short stage title." }),
  strategy: Type.Optional(
    Type.Union([
      Type.Literal("fan-out"),
      Type.Literal("verify"),
      Type.Literal("synthesize"),
    ])
  ),
  steps: Type.Array(StepSchema, {
    description: "Independent steps that can run in parallel within this stage.",
  }),
  concurrency: Type.Optional(Type.Number()),
  synthesisInstructions: Type.Optional(Type.String()),
});

const WorkflowParams = Type.Object({
  objective: Type.String({
    description: "The user-facing objective this workflow is designed to solve.",
  }),
  rationale: Type.String({
    description: "Why a dynamic workflow is useful for this task.",
  }),
  stages: Type.Array(StageSchema, {
    description:
      "Sequential stages. Steps inside a stage run in parallel; later stages receive prior results.",
  }),
  finalSynthesisInstructions: Type.Optional(Type.String()),
});

const WorkflowScriptParams = Type.Object({
  objective: Type.String({
    description: "The user-facing objective this generated workflow script solves.",
  }),
  rationale: Type.String({
    description: "Why a script harness is useful for this task.",
  }),
  script: Type.String({
    description:
      "JavaScript body for an async workflow harness. Use the provided workflow SDK; do not use import, require, process, fs, network, or shell APIs.",
  }),
  resumeFromWorkflowId: Type.Optional(
    Type.String({
      description:
        "Optional previous workflow id to resume from. The new script receives prior checkpoints/artifacts through workflow.resume and workflow.readArtifact().",
    })
  ),
  resumeFromCheckpointName: Type.Optional(
    Type.String({
      description:
        "Optional checkpoint name within resumeFromWorkflowId. When provided, workflow.resume.lastCheckpoint is set to that checkpoint instead of the latest one.",
    })
  ),
  capabilities: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("spawn_agent"),
        Type.Literal("read_files"),
        Type.Literal("write_files"),
        Type.Literal("shell"),
        Type.Literal("browser"),
        Type.Literal("network"),
        Type.Literal("worktree"),
        Type.Literal("ask_user"),
        Type.Literal("mcp"),
      ]),
      {
        description:
          "Explicit workflow capability manifest. Omit for the safe default: spawn_agent + read_files. write_files, shell, browser, worktree, network, ask_user, and mcp require user approval.",
      }
    )
  ),
  maxAgents: Type.Optional(
    Type.Number({
      description: "Maximum child agents this workflow may spawn. Defaults to 8.",
    })
  ),
  maxConcurrency: Type.Optional(
    Type.Number({
      description:
        "Maximum workflow.parallel item count. Defaults to 4; capped by the runtime.",
    })
  ),
  timeoutMs: Type.Optional(Type.Number()),
});

const WorkflowTemplateParams = Type.Object({
  templateId: Type.String({
    description: "Workflow template id from the template registry.",
  }),
  params: Type.Optional(
    Type.Any({
      description:
        "Template parameters. They are exposed to the workflow script as workflow.params.",
    })
  ),
  objective: Type.Optional(Type.String()),
  rationale: Type.Optional(Type.String()),
  capabilities: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("spawn_agent"),
        Type.Literal("read_files"),
        Type.Literal("write_files"),
        Type.Literal("shell"),
        Type.Literal("browser"),
        Type.Literal("network"),
        Type.Literal("worktree"),
        Type.Literal("ask_user"),
        Type.Literal("mcp"),
      ])
    )
  ),
  maxAgents: Type.Optional(Type.Number()),
  maxConcurrency: Type.Optional(Type.Number()),
  timeoutMs: Type.Optional(Type.Number()),
});

type WorkflowParamsValue = {
  objective: string;
  rationale: string;
  stages?: Array<{
    id?: string;
    title: string;
    strategy?: "fan-out" | "verify" | "synthesize";
    steps?: Array<Omit<WorkflowStep, "id"> & { id?: string }>;
    concurrency?: number;
    synthesisInstructions?: string;
  }>;
  finalSynthesisInstructions?: string;
};

export interface WorkflowsExtensionOptions {
  onRunWorkflow: (
    input: RunDynamicWorkflowInput,
    signal?: AbortSignal
  ) => Promise<DynamicWorkflowResult>;
  onRunWorkflowScript?: (
    input: RunWorkflowScriptInput,
    signal?: AbortSignal
  ) => Promise<WorkflowScriptResult>;
  onRunWorkflowTemplate?: (
    input: RunWorkflowTemplateInput,
    signal?: AbortSignal
  ) => Promise<WorkflowScriptResult>;
}

function normalizeInput(params: WorkflowParamsValue): RunDynamicWorkflowInput {
  return {
    objective: params.objective,
    rationale: params.rationale,
    finalSynthesisInstructions: params.finalSynthesisInstructions,
    stages: (params.stages ?? []).map((stage, stageIndex) => ({
      id: stage.id || `stage-${stageIndex + 1}`,
      title: stage.title,
      strategy: stage.strategy,
      concurrency: stage.concurrency,
      synthesisInstructions: stage.synthesisInstructions,
      steps: (stage.steps ?? []).map((step, stepIndex) => ({
        ...step,
        id: step.id || `step-${stepIndex + 1}`,
      })),
    })),
  };
}

function resultSummary(result: DynamicWorkflowResult): string {
  return result.stages
    .map((stage, index) => {
      const lines = stage.results.map((subResult) => {
        const text = subResult.answer || subResult.error || "(no answer)";
        return `- ${subResult.taskId} (${subResult.status}): ${text}`;
      });
      return [
        `## ${index + 1}. ${stage.title} (${stage.status})`,
        stage.error ? `Error: ${stage.error}` : "",
        ...lines,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function scriptResultSummary(result: WorkflowScriptResult): string {
  const lines = [
    `Workflow script ${result.workflowId} finished with status ${result.status}.`,
  ];
  if (result.error) lines.push(`Error: ${result.error}`);
  if (result.checkpoints.length > 0) {
    lines.push(
      "",
      "## Checkpoints",
      ...result.checkpoints.map((checkpoint) => `- ${checkpoint.name}`)
    );
  }
  if (result.artifacts.length > 0) {
    lines.push(
      "",
      "## Artifacts",
      ...result.artifacts.map((artifact) => `- ${artifact.name}`)
    );
  }
  if (result.returnValue !== undefined) {
    lines.push("", "## Return Value", JSON.stringify(result.returnValue, null, 2));
  }
  return lines.join("\n");
}

function mergeParams(defaultParams: unknown, params: unknown): unknown {
  if (
    defaultParams &&
    typeof defaultParams === "object" &&
    !Array.isArray(defaultParams) &&
    params &&
    typeof params === "object" &&
    !Array.isArray(params)
  ) {
    return {
      ...(defaultParams as Record<string, unknown>),
      ...(params as Record<string, unknown>),
    };
  }
  return params ?? defaultParams ?? {};
}

function workflowTemplateToScriptInput(
  input: RunWorkflowTemplateInput
): RunWorkflowScriptInput {
  const template = getWorkflowTemplate(input.templateId);
  if (!template) throw new Error(`workflow template not found: ${input.templateId}`);
  const params = mergeParams(template.defaultParams, input.params);
  if (template.paramsSchema) {
    const errors = validateJsonSchema(params, template.paramsSchema);
    if (errors.length > 0) {
      throw new Error(
        `workflow template params validation failed: ${errors.join("; ")}`
      );
    }
  }
  return {
    objective:
      input.objective ??
      `Run workflow template ${template.name} (${template.id})`,
    rationale:
      input.rationale ??
      template.description ??
      `Reusable workflow template ${template.id}.`,
    script: template.script,
    templateParams: params,
    templateRef: {
      id: template.id,
      name: template.name,
      version: template.version,
    },
    capabilities: input.capabilities ?? template.capabilities,
    maxAgents: input.maxAgents ?? template.maxAgents,
    maxConcurrency: input.maxConcurrency ?? template.maxConcurrency,
    timeoutMs: input.timeoutMs ?? template.timeoutMs,
  };
}

export function createDynamicWorkflowTool(
  opts: WorkflowsExtensionOptions
): ToolDefinition<typeof WorkflowParams, DynamicWorkflowResult> {
  return defineTool<typeof WorkflowParams, DynamicWorkflowResult>({
    name: "run_dynamic_workflow",
    label: "Run Dynamic Workflow",
    description:
      "Design and run a task-specific multi-stage workflow. Use when a complex task benefits from staged fan-out, verification, and synthesis across subagents.",
    promptSnippet:
      "run_dynamic_workflow: create a task-specific staged workflow; each stage can fan out to subagents and later stages see prior results.",
    promptGuidelines: [
      "Use run_dynamic_workflow for complex research, code review, broad document analysis, or tasks that need one stage to inspect and a later stage to verify or synthesize.",
      "Keep stages sequential only where dependency is real; put independent work in the same stage.",
      "Make every step prompt standalone, specific, and bounded.",
      "After the workflow returns, synthesize the result for the user and call out uncertainties or failed stages.",
      "Do not use for small tasks, tightly interactive tasks, or unclear write operations.",
    ],
    parameters: WorkflowParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal) {
      const result = await opts.onRunWorkflow(normalizeInput(params), signal);
      return {
        content: [
          {
            type: "text",
            text: [
              `Dynamic workflow ${result.workflowId} finished with status ${result.status}.`,
              "",
              resultSummary(result),
            ].join("\n"),
          },
        ],
        details: result,
      };
    },
  });
}

export function createWorkflowScriptTool(
  opts: WorkflowsExtensionOptions
): ToolDefinition<typeof WorkflowScriptParams, WorkflowScriptResult> {
  return defineTool<typeof WorkflowScriptParams, WorkflowScriptResult>({
    name: "run_workflow_script",
    label: "Run Workflow Script",
    description:
      "Generate and run a task-specific JavaScript workflow harness with a restricted workflow SDK. Use this for Claude-Code-style dynamic workflows that need loops, conditionals, staged fan-out, checkpoints, artifacts, or custom control flow.",
    promptSnippet:
      "run_workflow_script: write an async JavaScript workflow body using workflow.spawnAgent, workflow.parallel, workflow.stage, workflow.checkpoint, and workflow.artifact.",
    promptGuidelines: [
      "Use run_workflow_script for complex tasks where a generated harness is clearer than a fixed stage list.",
      "The script runs inside an async function body. Use `return ...` for the final structured value.",
      "Available SDK: workflow.agent(prompt,{title,schema,isolation,agentType,tools,maxTurns,timeoutMs}), workflow.patterns.*, workflow.spawnAgent({title,prompt,role,cwd,allowedTools,maxTurns,timeoutMs}), workflow.askUser({title,question,context,options,recommendedOptionId}), workflow.fetchUrl({url,method,headers,body,maxBytes}), workflow.createWorktree({name,baseRef}), workflow.diffWorktree(worktree), workflow.mergeWorktree(worktree), workflow.removeWorktree(worktree), workflow.parallel([...]), workflow.stage(title, fn), workflow.checkpoint(name,value), workflow.artifact(name,value), workflow.readArtifact(name), workflow.listArtifacts(), workflow.log(message), workflow.warn(message), workflow.error(message), workflow.sleep(ms), and workflow.resume when resumeFromWorkflowId is provided.",
      "To resume a prior workflow, pass resumeFromWorkflowId. Optionally pass resumeFromCheckpointName to resume from a specific checkpoint. Write a new harness that reads workflow.resume.lastCheckpoint plus workflow.readArtifact(name). This is checkpoint/artifact resume, not restoration of an arbitrary JavaScript call stack.",
      "Declare capabilities when needed. Safe default is capabilities: [\"spawn_agent\", \"read_files\"]. write_files, shell, browser, and worktree trigger user approval. For coding workflows, request capabilities [\"spawn_agent\", \"read_files\", \"write_files\", \"worktree\"], create a worktree, spawn implementation agents with cwd set to the worktree path, call workflow.diffWorktree, and only call workflow.mergeWorktree when the requested workflow should apply the isolated patch back to the main working tree.",
      "For command or browser workflows, request shell/browser explicitly and pass only the needed tool names through workflow.spawnAgent({ allowedTools: [...] }). The workflow script itself still cannot use shell, process, browser, or network APIs directly.",
      "For small public HTTP reads, request network explicitly and call workflow.fetchUrl. Do not try to use global fetch or third-party network libraries.",
      "For ambiguous or risky branches, request ask_user explicitly and call workflow.askUser with 2-4 concrete options. User interaction is handled by the host clarification UI.",
      "When the same workflow will be reused, prefer saving it as a workflow template and later running it with run_workflow_template instead of regenerating a large script each time.",
      "Do not use import, require, process, fs, network, shell, eval, or Function. All external work must go through workflow.spawnAgent.",
      "After the tool returns, synthesize the workflow result for the user and mention failed agents or uncertainty.",
    ],
    parameters: WorkflowScriptParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal) {
      if (!opts.onRunWorkflowScript) {
        throw new Error("run_workflow_script is not configured");
      }
      const result = await opts.onRunWorkflowScript(
        {
          objective: params.objective,
          rationale: params.rationale,
          script: params.script,
          resumeFromWorkflowId: params.resumeFromWorkflowId,
          resumeFromCheckpointName: params.resumeFromCheckpointName,
          capabilities: params.capabilities,
          maxAgents: params.maxAgents,
          maxConcurrency: params.maxConcurrency,
          timeoutMs: params.timeoutMs,
        },
        signal
      );
      return {
        content: [
          {
            type: "text",
            text: scriptResultSummary(result),
          },
        ],
        details: result,
      };
    },
  });
}

export function createWorkflowTemplateTool(
  opts: WorkflowsExtensionOptions
): ToolDefinition<typeof WorkflowTemplateParams, WorkflowScriptResult> {
  return defineTool<typeof WorkflowTemplateParams, WorkflowScriptResult>({
    name: "run_workflow_template",
    label: "Run Workflow Template",
    description:
      "Run a saved reusable workflow template from the local workflow registry. Use when a repeatable workflow already exists and only parameters need to vary.",
    promptSnippet:
      "run_workflow_template: execute a saved reusable workflow by templateId with params exposed as workflow.params.",
    promptGuidelines: [
      "Use run_workflow_template for repeatable workflows such as triage, research, migration, verification, or evaluation.",
      "Pass params as structured JSON. The workflow script receives them as workflow.params.",
      "Override capabilities or budgets only when this specific run needs different permissions or limits.",
      "When pursuing an active /goal, inspect the workflow artifacts and trace before deciding the goal is complete.",
    ],
    parameters: WorkflowTemplateParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal) {
      const runner =
        opts.onRunWorkflowTemplate ??
        (opts.onRunWorkflowScript
          ? (input: RunWorkflowTemplateInput, runSignal?: AbortSignal) =>
              opts.onRunWorkflowScript!(
                workflowTemplateToScriptInput(input),
                runSignal
              )
          : undefined);
      if (!runner) throw new Error("run_workflow_template is not configured");
      const result = await runner(
        {
          templateId: params.templateId,
          params: params.params,
          objective: params.objective,
          rationale: params.rationale,
          capabilities: params.capabilities,
          maxAgents: params.maxAgents,
          maxConcurrency: params.maxConcurrency,
          timeoutMs: params.timeoutMs,
        },
        signal
      );
      return {
        content: [{ type: "text", text: scriptResultSummary(result) }],
        details: result,
      };
    },
  });
}

export function createWorkflowsExtension(
  opts: WorkflowsExtensionOptions
): ExtensionFactory {
  return (pi) => {
    pi.registerTool(createDynamicWorkflowTool(opts));
    if (opts.onRunWorkflowScript) {
      pi.registerTool(createWorkflowScriptTool(opts));
      pi.registerTool(createWorkflowTemplateTool(opts));
    }
  };
}

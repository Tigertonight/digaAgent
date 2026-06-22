import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { callAgentTeamCoordinationTool } from "./coordination-bridge";

const EmptyParams = Type.Object({});

const ClaimTaskParams = Type.Object({
  taskId: Type.String({ description: "ID of the runnable task to claim." }),
  writePaths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Optional file paths expected to be written by this task.",
    })
  ),
});

const SubmitResultParams = Type.Object({
  taskId: Type.String({ description: "ID of the task being completed." }),
  rawText: Type.String({
    description:
      "Structured teammate result. Include a TEAM_RESULT_JSON block with summary, findings, challenges, and evidenceRefs.",
  }),
});

const SendMessageParams = Type.Object({
  body: Type.String({ description: "Message body to send to the Team board or a teammate." }),
  toAgentId: Type.Optional(Type.String({ description: "Optional target member id." })),
  taskId: Type.Optional(Type.String({ description: "Optional related task id." })),
  findingId: Type.Optional(Type.String({ description: "Optional related finding id." })),
  challengeId: Type.Optional(Type.String({ description: "Optional related challenge id." })),
});

const CreateChallengeParams = Type.Object({
  targetFindingId: Type.String({ description: "Finding id to challenge." }),
  reason: Type.String({ description: "Why this finding may be wrong, incomplete, or risky." }),
  severity: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
  ),
  requiredEvidenceRefs: Type.Optional(Type.Array(Type.String())),
});

const RequestPlanApprovalParams = Type.Object({
  taskId: Type.String({ description: "Task id that needs plan approval." }),
  body: Type.String({ description: "Plan body for Lead/user approval." }),
  criteria: Type.Optional(Type.Array(Type.String())),
});

const ResolveChallengeParams = Type.Object({
  challengeId: Type.String({ description: "Challenge id to resolve." }),
  resolution: Type.String({ description: "Resolution summary and evidence." }),
  resolutionFindingIds: Type.Optional(Type.Array(Type.String())),
});

const RecordDecisionParams = Type.Object({
  title: Type.String({ description: "Decision title." }),
  rationale: Type.String({ description: "Why this decision is supported." }),
  acceptedFindingIds: Type.Array(Type.String()),
  rejectedFindingIds: Type.Optional(Type.Array(Type.String())),
  challengeIds: Type.Optional(Type.Array(Type.String())),
  evidenceRefs: Type.Optional(Type.Array(Type.String())),
  sourceResultIds: Type.Optional(Type.Array(Type.String())),
  confidence: Type.Optional(
    Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])
  ),
});

type CoordinationDetails = {
  ok: boolean;
  teamId?: string;
  memberId?: string;
  toolName: string;
  error?: string;
};

function resultText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function createCoordinationTool(
  opts: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    getAgentId: () => string;
  }
): ToolDefinition {
  return defineTool<typeof EmptyParams, CoordinationDetails>({
    name: opts.name,
    label: opts.label,
    description: opts.description,
    promptSnippet: `${opts.name}: coordinate with the Agent Team board.`,
    parameters: opts.parameters as typeof EmptyParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = await callAgentTeamCoordinationTool(
        opts.getAgentId(),
        opts.name,
        params
      );
      if (!result.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Agent Team coordination rejected: ${result.error}`,
            },
          ],
          details: {
            ok: false,
            teamId: result.teamId,
            memberId: result.memberId,
            toolName: opts.name,
            error: result.error,
          },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: resultText(result.value),
          },
        ],
        details: {
          ok: true,
          teamId: result.teamId,
          memberId: result.memberId,
          toolName: opts.name,
        },
      };
    },
  }) as unknown as ToolDefinition;
}

export function createAgentTeamCoordinationTools(opts: {
  getAgentId: () => string;
}): ToolDefinition[] {
  return [
    createCoordinationTool({
      name: "team_get_board",
      label: "Team Get Board",
      description:
        "Read the compact Agent Team board for this teammate: self info, runnable tasks, open challenges, recent messages, and proposed findings.",
      parameters: EmptyParams,
      getAgentId: opts.getAgentId,
    }),
    createCoordinationTool({
      name: "team_claim_task",
      label: "Team Claim Task",
      description:
        "Claim a runnable Agent Team task for this teammate. Only claim tasks shown by team_get_board.",
      parameters: ClaimTaskParams,
      getAgentId: opts.getAgentId,
    }),
    createCoordinationTool({
      name: "team_submit_result",
      label: "Team Submit Result",
      description:
        "Submit the structured result for the currently owned task. This is the only way teammate work counts as completed.",
      parameters: SubmitResultParams,
      getAgentId: opts.getAgentId,
    }),
    createCoordinationTool({
      name: "team_send_message",
      label: "Team Send Message",
      description:
        "Send a message to the Team board or to a specific teammate mailbox.",
      parameters: SendMessageParams,
      getAgentId: opts.getAgentId,
    }),
    createCoordinationTool({
      name: "team_create_challenge",
      label: "Team Create Challenge",
      description:
        "Challenge a proposed finding when it is incomplete, risky, or contradicted by evidence.",
      parameters: CreateChallengeParams,
      getAgentId: opts.getAgentId,
    }),
    createCoordinationTool({
      name: "team_request_plan_approval",
      label: "Team Request Plan Approval",
      description:
        "Request approval for a plan before write-sensitive Agent Team work.",
      parameters: RequestPlanApprovalParams,
      getAgentId: opts.getAgentId,
    }),
    createCoordinationTool({
      name: "team_resolve_challenge",
      label: "Team Resolve Challenge",
      description:
        "Resolve an open challenge. Requires coordinationProfile=full.",
      parameters: ResolveChallengeParams,
      getAgentId: opts.getAgentId,
    }),
    createCoordinationTool({
      name: "team_record_decision",
      label: "Team Record Decision",
      description:
        "Record a traceable Team decision. Requires coordinationProfile=full and Lead identity.",
      parameters: RecordDecisionParams,
      getAgentId: opts.getAgentId,
    }),
  ] as unknown as ToolDefinition[];
}

export function createAgentTeamCoordinationExtension(opts: {
  getAgentId: () => string;
}): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", async (event) => ({
      systemPrompt: `${event.systemPrompt}

## Agent Team Coordination

You are a teammate inside an Agent Team. Use the team_* tools to coordinate through the shared board.

Preferred flow:
1. Call team_get_board to refresh state.
2. If you have a runnable task, call team_claim_task before doing the work.
3. Do the task using normal read/search/shell tools as allowed.
4. Call team_submit_result with a structured TEAM_RESULT_JSON block. Local notes do not count as completion.

You may call team_send_message for mailbox updates, team_create_challenge for risky findings, and team_request_plan_approval before write-sensitive work. Governance tools team_resolve_challenge and team_record_decision are rejected unless this run explicitly enables full coordination and the caller has the right role. If any team_* tool is rejected, stop and surface the rejection reason instead of pretending the task completed.
`,
    }));
    for (const tool of createAgentTeamCoordinationTools(opts)) {
      pi.registerTool(tool);
    }
  };
}

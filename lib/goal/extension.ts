import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { AgentGoal, GoalUpdateInput, GoalUpdateResult } from "./types";

const GoalUpdateParams = Type.Object({
  status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
    description: "Set complete only when the active goal is fully achieved.",
  }),
  blockedReason: Type.Optional(
    Type.String({
      description: "Short blocker description when status is blocked.",
    })
  ),
});

export interface GoalExtensionOptions {
  getAgentId: () => string;
  getGoal: (agentId: string) => AgentGoal | null;
  onGoalUpdate: (
    agentId: string,
    input: GoalUpdateInput
  ) => Promise<GoalUpdateResult> | GoalUpdateResult;
}

export function createGoalExtension(opts: GoalExtensionOptions): ExtensionFactory {
  return (pi) => {
    pi.registerTool(
      defineTool<typeof GoalUpdateParams, { goal: AgentGoal | null }>({
        name: "goal_update",
        label: "Goal Update",
        description:
          "Update the active long-running goal status. Use when the goal is complete or truly blocked.",
        promptSnippet:
          "goal_update: mark the active goal complete or blocked with structured status.",
        promptGuidelines: [
          "When an active goal is fully achieved, call goal_update with status=complete before your final summary.",
          "Use status=blocked only when you cannot make meaningful progress without user input or an external change.",
          "Do not mark a goal complete only because one subtask finished; check the full objective.",
        ],
        parameters: GoalUpdateParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const agentId = opts.getAgentId();
          const current = opts.getGoal(agentId);
          if (!current) {
            return {
              content: [{ type: "text", text: "No active goal is set." }],
              details: { goal: null },
            };
          }

          const result = await opts.onGoalUpdate(agentId, {
            status: params.status,
            blockedReason: params.blockedReason,
          });

          let text: string;
          if (params.status === "complete") {
            text = result.accepted
              ? "Goal marked complete."
              : result.rejectionNote ??
                "Goal completion was not accepted yet; keep working and record evidence.";
          } else {
            text = `Goal marked blocked${params.blockedReason ? `: ${params.blockedReason}` : "."}`;
          }

          return {
            content: [{ type: "text", text }],
            details: { goal: result.goal },
          };
        },
      })
    );
  };
}

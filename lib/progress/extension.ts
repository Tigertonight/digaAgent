import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { AgentProgress, ProgressUpdateInput } from "./types";

const StepStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
]);

const ArtifactKind = Type.Union([
  Type.Literal("file"),
  Type.Literal("url"),
  Type.Literal("screenshot"),
  Type.Literal("test"),
  Type.Literal("diff"),
  Type.Literal("log"),
  Type.Literal("browser"),
  Type.Literal("other"),
]);

const UpdateProgressParams = Type.Object({
  replaceSteps: Type.Optional(
    Type.Boolean({
      description: "Replace all progress steps instead of merging by id.",
    })
  ),
  replaceArtifacts: Type.Optional(
    Type.Boolean({
      description: "Replace all artifacts instead of merging by id.",
    })
  ),
  steps: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Optional(Type.String()),
        title: Type.String(),
        status: StepStatus,
        summary: Type.Optional(Type.String()),
        evidenceIds: Type.Optional(Type.Array(Type.String())),
      })
    )
  ),
  artifacts: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Optional(Type.String()),
        kind: ArtifactKind,
        title: Type.String(),
        href: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
      })
    )
  ),
});

export interface ProgressExtensionOptions {
  getAgentId: () => string;
  onProgressUpdate: (
    agentId: string,
    input: ProgressUpdateInput
  ) => Promise<AgentProgress> | AgentProgress;
}

export function createProgressExtension(
  opts: ProgressExtensionOptions
): ExtensionFactory {
  return (pi) => {
    pi.registerTool(
      defineTool<typeof UpdateProgressParams, { progress: AgentProgress }>({
        name: "update_progress",
        label: "Update Progress",
        description:
          "Update structured progress steps and evidence artifacts for the current goal.",
        promptSnippet:
          "update_progress: publish concise progress steps and evidence artifacts for the user-visible progress panel.",
        promptGuidelines: [
          "Use update_progress for multi-step work so the user can see current plan nodes.",
          "Keep steps concrete and verifiable; at most one step should be running.",
          "Attach artifacts for meaningful evidence such as files, URLs, screenshots, test results, logs, or browser observations.",
          "Update progress before long tool work, after completing a milestone, and before marking a goal complete.",
        ],
        parameters: UpdateProgressParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const progress = await opts.onProgressUpdate(opts.getAgentId(), params);
          return {
            content: [
              {
                type: "text",
                text: `Progress updated: ${progress.steps.length} steps, ${progress.artifacts.length} artifacts.`,
              },
            ],
            details: { progress },
          };
        },
      })
    );
  };
}

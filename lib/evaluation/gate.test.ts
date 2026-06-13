import { describe, expect, it } from "vitest";
import { evaluateRubric } from "./evaluator";
import {
  buildIndependentEvaluatorInput,
  findForbiddenEvaluatorContextKeys,
  toEvaluateRubricInput,
} from "./gate";
import type { RubricSpec } from "./types";

function rubric(): RubricSpec {
  return {
    id: "rubric-gate-test",
    version: "1",
    title: "Gate test",
    profileId: "workflow.default",
    targetScore: 0.8,
    dimensions: [{ id: "evidence", name: "Evidence", weight: 1 }],
    criteria: [
      {
        id: "artifact-linked",
        dimensionId: "evidence",
        importance: "essential",
        description: "Criterion must be linked to a real artifact.",
        evidenceRequired: ["workflow_artifact"],
        minEvidenceTrust: "artifact_reference",
        hardFail: true,
      },
    ],
    importanceWeights: {
      essential: 3,
      important: 2,
      optional: 1,
      pitfall: 2,
    },
    exitPolicy: {
      maxIterations: 2,
      blockedRepeatLimit: 2,
      scoreCapWithoutEvidence: 0.6,
    },
    createdAt: 1,
  };
}

describe("independent evaluator gate", () => {
  it("keeps process trace and conversation context out of evaluator input", () => {
    const input = buildIndependentEvaluatorInput({
      objective: "Evaluate a workflow result.",
      rubric: rubric(),
      scores: [
        {
          criterionId: "artifact-linked",
          status: "pass",
          evidenceIds: ["artifact-1"],
          reason: "Artifact is present.",
        },
      ],
      evidence: [
        {
          id: "artifact-1",
          kind: "workflow_artifact",
          title: "artifact",
          summary: "bounded summary",
          trustLevel: "artifact_reference",
          source: "workflow.artifact",
          verifiable: true,
          createdAt: 1,
          script: "should not pass through",
          traceEvents: [{ type: "agent_start" }],
          messages: [{ role: "assistant" }],
        } as never,
      ],
      finalOutput: {
        messages: [{ role: "assistant", content: "raw conversation" }],
      },
      createdAt: 2,
    });

    expect(findForbiddenEvaluatorContextKeys(input)).toEqual([]);
    expect(input.evidence?.[0]).toMatchObject({
      id: "artifact-1",
      kind: "workflow_artifact",
      title: "artifact",
      summary: "bounded summary",
      trustLevel: "artifact_reference",
      source: "workflow.artifact",
      verifiable: true,
      createdAt: 1,
    });
    expect("script" in input.evidence![0]).toBe(false);
    expect("traceEvents" in input.evidence![0]).toBe(false);
    expect("messages" in input.evidence![0]).toBe(false);
    expect(input.gate.excludedContext).toContain("script");
  });

  it("produces a valid bounded evaluator input", () => {
    const gateInput = buildIndependentEvaluatorInput({
      contract: {
        objective: "Evaluate a workflow result.",
        scope: ["artifact review"],
        nonGoals: ["process trace review"],
        requiredEvidence: ["workflow_artifact"],
        rubricProfile: "workflow.default",
      },
      rubric: rubric(),
      scores: [
        {
          criterionId: "artifact-linked",
          status: "pass",
          evidenceIds: ["artifact-1"],
        },
      ],
      evidence: [
        {
          id: "artifact-1",
          kind: "workflow_artifact",
          title: "artifact",
          trustLevel: "artifact_reference",
          verifiable: true,
        },
      ],
      createdAt: 3,
    });

    const evaluation = evaluateRubric(toEvaluateRubricInput(gateInput));

    expect(evaluation.status).toBe("passed");
    expect(evaluation.subject).toEqual({});
    expect(evaluation.evidence?.[0]?.id).toBe("artifact-1");
  });
});

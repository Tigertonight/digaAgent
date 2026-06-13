import { describe, expect, it } from "vitest";
import { evaluateRubric } from "./evaluator";
import { CODING_DEFAULT_PROFILE, createRubricSpecFromProfile } from "./profiles";
import type { RubricCriterion, RubricSpec } from "./types";

const criteria: RubricCriterion[] = [
  {
    id: "core-flow",
    dimensionId: "functional_correctness",
    importance: "essential",
    description: "Core flow works.",
    evidenceRequired: ["test_result"],
    hardFail: true,
  },
  {
    id: "minimal-change",
    dimensionId: "codebase_fit",
    importance: "important",
    description: "Change stays inside the existing architecture.",
  },
  {
    id: "build-pass",
    dimensionId: "verification_evidence",
    importance: "essential",
    description: "Relevant test or build passes.",
    evidenceRequired: ["command_output"],
    hardFail: true,
  },
  {
    id: "nice-copy",
    dimensionId: "ux_operability",
    importance: "optional",
    description: "Copy is polished.",
  },
  {
    id: "secret-leak",
    dimensionId: "robustness_safety",
    importance: "pitfall",
    description: "No secret is leaked.",
    hardFail: true,
  },
];

function rubric(over: Partial<RubricSpec> = {}): RubricSpec {
  return {
    ...createRubricSpecFromProfile(CODING_DEFAULT_PROFILE, {
      id: "coding-rubric",
      title: "Coding rubric",
      criteria,
      createdAt: 1000,
    }),
    ...over,
  };
}

describe("evaluateRubric", () => {
  it("passes when required criteria, min scores, and evidence are satisfied", () => {
    const result = evaluateRubric({
      rubric: rubric(),
      criteria: [
        { criterionId: "core-flow", status: "pass", evidenceIds: ["test-1"] },
        { criterionId: "minimal-change", status: "pass" },
        { criterionId: "build-pass", status: "pass", evidenceIds: ["cmd-1"] },
        {
          criterionId: "nice-copy",
          status: "accepted_skip",
          reason: "Out of scope for this task; copy unchanged.",
        },
        { criterionId: "secret-leak", status: "pass" },
      ],
      createdAt: 1234,
    });

    expect(result.status).toBe("passed");
    expect(result.recommendation).toBe("pass");
    expect(result.totalScore).toBeGreaterThanOrEqual(0.88);
    expect(result.missingEvidence).toHaveLength(0);
  });

  it("fails and iterates when an essential criterion is not satisfied", () => {
    const result = evaluateRubric({
      rubric: rubric(),
      criteria: [
        { criterionId: "core-flow", status: "partial", evidenceIds: ["manual-1"] },
        { criterionId: "minimal-change", status: "pass" },
        { criterionId: "build-pass", status: "pass", evidenceIds: ["cmd-1"] },
        { criterionId: "nice-copy", status: "pass" },
        { criterionId: "secret-leak", status: "pass" },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.recommendation).toBe("iterate");
    expect(result.hardFails).toContain("core-flow");
    expect(result.failedCriteria).toContain("core-flow");
  });

  it("hard-fails when a pitfall is triggered", () => {
    const result = evaluateRubric({
      rubric: rubric(),
      criteria: [
        { criterionId: "core-flow", status: "pass", evidenceIds: ["test-1"] },
        { criterionId: "minimal-change", status: "pass" },
        { criterionId: "build-pass", status: "pass", evidenceIds: ["cmd-1"] },
        { criterionId: "nice-copy", status: "pass" },
        { criterionId: "secret-leak", status: "fail" },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.hardFails).toContain("secret-leak");
    expect(result.triggeredPitfalls).toContain("secret-leak");
  });

  it("caps the score when required evidence is missing", () => {
    const result = evaluateRubric({
      rubric: rubric(),
      criteria: [
        { criterionId: "core-flow", status: "pass" },
        { criterionId: "minimal-change", status: "pass" },
        { criterionId: "build-pass", status: "pass" },
        { criterionId: "nice-copy", status: "pass" },
        { criterionId: "secret-leak", status: "pass" },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.totalScore).toBe(0.7);
    expect(result.missingEvidence.join(" ")).toContain("core-flow");
    expect(result.nextAction).toMatch(/missing evidence/i);
  });

  it("treats unknown evidence ids as missing when a catalog is supplied", () => {
    const result = evaluateRubric({
      rubric: rubric(),
      evidence: [{ id: "cmd-1", kind: "workflow_log", title: "command output" }],
      criteria: [
        { criterionId: "core-flow", status: "pass", evidenceIds: ["unknown"] },
        { criterionId: "minimal-change", status: "pass" },
        { criterionId: "build-pass", status: "pass", evidenceIds: ["cmd-1"] },
        { criterionId: "nice-copy", status: "pass" },
        { criterionId: "secret-leak", status: "pass" },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.missingEvidence.join(" ")).toContain("unknown");
  });

  it("treats weak evidence as missing for essential criteria", () => {
    const result = evaluateRubric({
      rubric: rubric(),
      evidence: [
        {
          id: "agent-note",
          kind: "other",
          title: "Agent note",
          trustLevel: "agent_reported",
        },
        {
          id: "cmd-1",
          kind: "test_result",
          title: "Test result",
        },
      ],
      criteria: [
        { criterionId: "core-flow", status: "pass", evidenceIds: ["agent-note"] },
        { criterionId: "minimal-change", status: "pass" },
        { criterionId: "build-pass", status: "pass", evidenceIds: ["cmd-1"] },
        { criterionId: "nice-copy", status: "pass" },
        { criterionId: "secret-leak", status: "pass" },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.missingEvidence.join(" ")).toContain("evidence trust below");
    expect(result.totalScore).toBe(0.7);
  });

  it("excludes accepted skips from the denominator", () => {
    const result = evaluateRubric({
      rubric: rubric({
        targetScore: 0.85,
        dimensions: [
          { id: "functional_correctness", name: "Functional", weight: 1, minScore: 0.85 },
        ],
        criteria: [
          {
            id: "must-have",
            dimensionId: "functional_correctness",
            importance: "essential",
            description: "Must work.",
          },
          {
            id: "not-applicable",
            dimensionId: "functional_correctness",
            importance: "optional",
            description: "Skipped by explicit decision.",
          },
        ],
      }),
      criteria: [
        { criterionId: "must-have", status: "pass" },
        {
          criterionId: "not-applicable",
          status: "accepted_skip",
          reason: "Feature flag disables this path in the target environment.",
        },
      ],
    });

    expect(result.dimensionScores[0]?.score).toBe(1);
    expect(result.status).toBe("passed");
  });

  it("downgrades accepted_skip on essential/hardFail criteria to a fail", () => {
    const result = evaluateRubric({
      rubric: rubric(),
      criteria: [
        // core-flow is essential + hardFail; an executor must not be able to
        // waive it by reporting accepted_skip — even with a reason.
        {
          criterionId: "core-flow",
          status: "accepted_skip",
          reason: "Too hard to verify right now.",
          evidenceIds: ["test-1"],
        },
        { criterionId: "minimal-change", status: "pass" },
        { criterionId: "build-pass", status: "pass", evidenceIds: ["cmd-1"] },
        { criterionId: "nice-copy", status: "pass" },
        { criterionId: "secret-leak", status: "pass" },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.hardFails).toContain("core-flow");
    expect(result.failedCriteria).toContain("core-flow");
  });

  it("downgrades accepted_skip without a reason even on optional criteria", () => {
    const result = evaluateRubric({
      rubric: rubric(),
      criteria: [
        { criterionId: "core-flow", status: "pass", evidenceIds: ["test-1"] },
        { criterionId: "minimal-change", status: "pass" },
        { criterionId: "build-pass", status: "pass", evidenceIds: ["cmd-1"] },
        // optional, but no skip reason -> a silent skip is treated as a fail.
        { criterionId: "nice-copy", status: "accepted_skip" },
        { criterionId: "secret-leak", status: "pass" },
      ],
    });

    expect(result.failedCriteria).toContain("nice-copy");
  });

  it("iterates when a required dimension minimum is not met", () => {
    const result = evaluateRubric({
      rubric: rubric(),
      criteria: [
        { criterionId: "core-flow", status: "pass", evidenceIds: ["test-1"] },
        { criterionId: "minimal-change", status: "partial" },
        { criterionId: "build-pass", status: "pass", evidenceIds: ["cmd-1"] },
        { criterionId: "nice-copy", status: "pass" },
        { criterionId: "secret-leak", status: "pass" },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.recommendation).toBe("iterate");
    expect(result.minScoreFailures).toContain("codebase_fit");
  });

  it("stops on low delta when only optional work remains", () => {
    const result = evaluateRubric({
      rubric: rubric({
        targetScore: 0.99,
        dimensions: [
          { id: "functional_correctness", name: "Functional", weight: 0.9 },
          { id: "ux_operability", name: "UX", weight: 0.1 },
        ],
        criteria: [
          {
            id: "must-have",
            dimensionId: "functional_correctness",
            importance: "essential",
            description: "Must work.",
          },
          {
            id: "optional-copy",
            dimensionId: "ux_operability",
            importance: "optional",
            description: "Copy polish.",
          },
        ],
      }),
      criteria: [
        { criterionId: "must-have", status: "pass" },
        { criterionId: "optional-copy", status: "partial" },
      ],
      previousEvaluations: [
        { totalScore: 0.94, status: "warning", recommendation: "iterate" },
        { totalScore: 0.95, status: "warning", recommendation: "iterate" },
      ],
    });

    expect(result.recommendation).toBe("stop_low_delta");
    expect(result.status).toBe("warning");
  });

  it("blocks when the same blocker repeats too many times", () => {
    const result = evaluateRubric({
      rubric: rubric(),
      repeatedBlockerCount: 3,
      criteria: [
        { criterionId: "core-flow", status: "fail" },
        { criterionId: "minimal-change", status: "pass" },
        { criterionId: "build-pass", status: "fail" },
        { criterionId: "nice-copy", status: "pass" },
        { criterionId: "secret-leak", status: "pass" },
      ],
    });

    expect(result.status).toBe("blocked");
    expect(result.recommendation).toBe("blocked");
  });
});

describe("evaluateRubric — gate hardening", () => {
  function passingScores() {
    return [
      { criterionId: "core-flow", status: "pass" as const, evidenceIds: ["test-1"] },
      { criterionId: "minimal-change", status: "pass" as const },
      { criterionId: "build-pass", status: "pass" as const, evidenceIds: ["cmd-1"] },
      { criterionId: "nice-copy", status: "pass" as const },
      { criterionId: "secret-leak", status: "pass" as const },
    ];
  }

  function consecutiveRubric(requireConsecutivePasses: number): RubricSpec {
    const base = rubric();
    return {
      ...base,
      exitPolicy: { ...base.exitPolicy, requireConsecutivePasses },
    };
  }

  it("does not accept on a single round when consecutive passes are required", () => {
    const result = evaluateRubric({
      rubric: consecutiveRubric(2),
      criteria: passingScores(),
      iteration: 1,
    });

    // The round content passes, but the profile demands two passing rounds.
    expect(result.status).not.toBe("passed");
    expect(result.recommendation).toBe("iterate");
  });

  it("accepts once the previous round also passed", () => {
    const result = evaluateRubric({
      rubric: consecutiveRubric(2),
      criteria: passingScores(),
      iteration: 2,
      previousEvaluations: [
        { totalScore: 0.95, status: "passed", recommendation: "pass" },
      ],
    });

    expect(result.status).toBe("passed");
    expect(result.recommendation).toBe("pass");
  });

  it("does not accept when the previous round did not pass", () => {
    const result = evaluateRubric({
      rubric: consecutiveRubric(2),
      criteria: passingScores(),
      iteration: 2,
      previousEvaluations: [
        { totalScore: 0.6, status: "warning", recommendation: "iterate" },
      ],
    });

    expect(result.status).not.toBe("passed");
    expect(result.recommendation).toBe("iterate");
  });

  it("caps the score when an essential criterion fails without evidence requirement", () => {
    const safetyRubric = rubric({
      targetScore: 0.85,
      dimensions: [
        { id: "functional_correctness", name: "Functional", weight: 0.9, minScore: 0 },
        { id: "robustness_safety", name: "Safety", weight: 0.1, minScore: 0 },
      ],
      criteria: [
        {
          id: "feature",
          dimensionId: "functional_correctness",
          importance: "important",
          description: "Feature behaves.",
        },
        {
          id: "safe-boundary",
          dimensionId: "robustness_safety",
          importance: "essential",
          description: "Stays inside the authorization boundary.",
        },
      ],
      exitPolicy: {
        ...CODING_DEFAULT_PROFILE.exitPolicy,
        scoreCapWithoutEvidence: 0.6,
      },
    });

    const result = evaluateRubric({
      rubric: safetyRubric,
      criteria: [
        { criterionId: "feature", status: "pass" },
        { criterionId: "safe-boundary", status: "fail" },
      ],
    });

    expect(result.status).toBe("failed");
    // Without the cap this would surface ~0.5+ next to a failed status.
    expect(result.totalScore).toBeLessThanOrEqual(0.6);
  });

  it("treats a screenshot as an artifact reference, not a deterministic check", () => {
    const result = evaluateRubric({
      rubric: rubric(),
      evidence: [
        { id: "shot-1", kind: "screenshot", title: "UI screenshot" },
        { id: "cmd-1", kind: "test_result", title: "Test result" },
      ],
      criteria: [
        // core-flow requires deterministic_check trust; a screenshot must not satisfy it.
        { criterionId: "core-flow", status: "pass", evidenceIds: ["shot-1"] },
        { criterionId: "minimal-change", status: "pass" },
        { criterionId: "build-pass", status: "pass", evidenceIds: ["cmd-1"] },
        { criterionId: "nice-copy", status: "pass" },
        { criterionId: "secret-leak", status: "pass" },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.missingEvidence.join(" ")).toContain("evidence trust below");
  });

  it("never auto-passes a rubric with no criteria", () => {
    const result = evaluateRubric({
      rubric: rubric({ criteria: [] }),
      criteria: [],
    });

    expect(result.status).not.toBe("passed");
    expect(result.recommendation).not.toBe("pass");
  });
});

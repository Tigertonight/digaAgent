import { describe, expect, it } from "vitest";
import {
  CODING_DEFAULT_PROFILE,
  mergeProfileWithDynamicCriteria,
} from "./profiles";

describe("mergeProfileWithDynamicCriteria", () => {
  it("preserves fixed profile criteria and appends dynamic criteria", () => {
    const rubric = mergeProfileWithDynamicCriteria(CODING_DEFAULT_PROFILE, {
      id: "merged",
      title: "Merged rubric",
      criteria: [
        {
          id: "custom-ui-fit",
          dimensionId: "ux_operability",
          importance: "important",
          description: "UI copy is usable.",
        },
      ],
    });

    expect(rubric.criteria.map((criterion) => criterion.id)).toContain(
      "coding-verification-present"
    );
    expect(rubric.criteria.map((criterion) => criterion.id)).toContain(
      "custom-ui-fit"
    );
    expect(rubric.targetScore).toBe(CODING_DEFAULT_PROFILE.targetScore);
  });

  it("rejects dynamic criteria outside profile dimensions", () => {
    expect(() =>
      mergeProfileWithDynamicCriteria(CODING_DEFAULT_PROFILE, {
        id: "bad",
        title: "Bad rubric",
        criteria: [
          {
            id: "rogue",
            dimensionId: "made_up",
            importance: "important",
            description: "Invalid dimension.",
          },
        ],
      })
    ).toThrow(/unknown profile dimension/);
  });

  it("rejects attempts to override fixed criteria", () => {
    expect(() =>
      mergeProfileWithDynamicCriteria(CODING_DEFAULT_PROFILE, {
        id: "override",
        title: "Override rubric",
        criteria: [
          {
            id: "coding-verification-present",
            dimensionId: "verification_evidence",
            importance: "optional",
            description: "Try to weaken verification.",
          },
        ],
      })
    ).toThrow(/cannot override fixed profile criterion/);
  });
});


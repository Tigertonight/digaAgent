import { describe, expect, it } from "vitest";
import {
  createAgentTeamResultPrompt,
  parseAgentTeamResultText,
} from "./result-ingestion";

describe("agent team result ingestion", () => {
  it("parses TEAM_RESULT_JSON fenced output", () => {
    const parsed = parseAgentTeamResultText([
      "Done.",
      "```TEAM_RESULT_JSON",
      JSON.stringify({
        summary: "Evidence gathered.",
        findings: [
          {
            claim: "The board needs accepted findings.",
            evidenceRefs: ["session:/tmp/team.jsonl"],
            confidence: "high",
          },
        ],
        challenges: [
          {
            reason: "Check whether evidence is sufficient.",
            severity: "low",
            requiredEvidenceRefs: ["session:/tmp/team.jsonl"],
          },
        ],
        needsFollowUp: false,
      }),
      "```",
    ].join("\n"));

    expect(parsed.summary).toBe("Evidence gathered.");
    expect(parsed.findings[0]?.claim).toBe("The board needs accepted findings.");
    expect(parsed.challenges[0]?.severity).toBe("low");
    expect(parsed.warnings).toEqual([]);
  });

  it("warns when structured findings are missing evidence", () => {
    const parsed = parseAgentTeamResultText(JSON.stringify({
      summary: "Weak result.",
      findings: [{ claim: "No evidence here." }],
    }));

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.warnings.some((warning) => warning.includes("evidence"))).toBe(true);
  });

  it("adds the team result contract to dispatch prompts", () => {
    const prompt = createAgentTeamResultPrompt("Do the task.");

    expect(prompt).toContain("Do the task.");
    expect(prompt).toContain("TEAM_RESULT_JSON");
    expect(prompt).toContain("evidenceRefs");
  });
});

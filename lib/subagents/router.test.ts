import { describe, expect, it } from "vitest";
import type { SubagentDefinition } from "./definition";
import {
  buildAgentMentionDirective,
  parseAgentMentions,
  stripAgentMentions,
  suggestAgentForGoal,
} from "./router";

const KNOWN = ["reviewer", "researcher"];

function def(id: string, title: string, description: string): SubagentDefinition {
  return {
    id,
    title,
    description,
    prompt: "p",
    source: "project",
    versionHash: "h",
  };
}

describe("parseAgentMentions", () => {
  it("parses a known mention", () => {
    expect(parseAgentMentions("@reviewer please look", KNOWN)).toEqual([
      { agentId: "reviewer", raw: "@reviewer" },
    ]);
  });

  it("ignores unknown mentions", () => {
    expect(parseAgentMentions("@nobody hi", KNOWN)).toEqual([]);
  });

  it("does not treat emails as mentions", () => {
    expect(parseAgentMentions("mail me at bob@reviewer", KNOWN)).toEqual([]);
  });

  it("dedupes repeated mentions", () => {
    expect(
      parseAgentMentions("@reviewer and @reviewer again", KNOWN)
    ).toHaveLength(1);
  });

  it("returns empty when no known ids", () => {
    expect(parseAgentMentions("@reviewer", [])).toEqual([]);
  });

  it("parses multiple distinct mentions", () => {
    const res = parseAgentMentions("@reviewer @researcher go", KNOWN);
    expect(res.map((m) => m.agentId)).toEqual(["reviewer", "researcher"]);
  });
});

describe("stripAgentMentions", () => {
  it("removes recognized mentions and trims", () => {
    expect(stripAgentMentions("@reviewer review this diff", KNOWN)).toBe(
      "review this diff"
    );
  });

  it("keeps unknown mentions intact", () => {
    expect(stripAgentMentions("@nobody do x", KNOWN)).toBe("@nobody do x");
  });
});

describe("suggestAgentForGoal", () => {
  const defs = [
    def("reviewer", "Code Reviewer", "review diffs regressions security risks"),
    def("researcher", "Researcher", "competitor research market analysis"),
  ];

  it("matches the relevant specialist", () => {
    const s = suggestAgentForGoal("please review this security diff", defs);
    expect(s?.agentId).toBe("reviewer");
  });

  it("returns null when nothing meaningfully matches", () => {
    expect(suggestAgentForGoal("xyzzy", defs)).toBeNull();
  });

  it("returns null with no definitions", () => {
    expect(suggestAgentForGoal("review security", [])).toBeNull();
  });
});

describe("buildAgentMentionDirective", () => {
  it("builds a directive for a recognized mention", () => {
    const res = buildAgentMentionDirective(
      "@reviewer review this diff",
      KNOWN
    );
    expect(res).not.toBeNull();
    expect(res!.agentIds).toEqual(["reviewer"]);
    expect(res!.directive).toContain("specialistId");
    expect(res!.directive).toContain("@reviewer");
    expect(res!.directive).toContain("review this diff");
  });

  it("returns null when there is no recognized mention", () => {
    expect(buildAgentMentionDirective("just review this", KNOWN)).toBeNull();
    expect(buildAgentMentionDirective("@nobody hi", KNOWN)).toBeNull();
  });

  it("handles multiple mentions", () => {
    const res = buildAgentMentionDirective(
      "@reviewer @researcher do both",
      KNOWN
    );
    expect(res!.agentIds).toEqual(["reviewer", "researcher"]);
  });
});

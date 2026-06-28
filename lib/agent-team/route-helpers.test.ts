import { describe, expect, it } from "vitest";
import { createInitialAgentTeamRun } from "./initial-run";
import {
  extractSimpleFileExistenceTarget,
  mergeAgentTeamSettings,
  messageContentToText,
  parseTransitionStatus,
  safeProjectRelativePath,
  teamErrorMessage,
  teamObjectivePreview,
  teamRoleToSubagentRole,
} from "./route-helpers";

const baseSettings = () => createInitialAgentTeamRun("base").settings;

describe("teamObjectivePreview", () => {
  it("collapses whitespace and truncates to 160 chars", () => {
    expect(teamObjectivePreview("  a\n\n b   c ")).toBe("a b c");
    expect(teamObjectivePreview("x".repeat(200))).toHaveLength(160);
  });
});

describe("teamErrorMessage", () => {
  it("extracts Error.message and stringifies non-errors", () => {
    expect(teamErrorMessage(new Error("boom"))).toBe("boom");
    expect(teamErrorMessage("plain")).toBe("plain");
    expect(teamErrorMessage(42)).toBe("42");
  });
});

describe("messageContentToText", () => {
  it("handles string, parts array, and junk", () => {
    expect(messageContentToText("hi")).toBe("hi");
    expect(
      messageContentToText([{ text: "a" }, { foo: 1 }, { text: "b" }])
    ).toBe("a\nb");
    expect(messageContentToText(null)).toBe("");
    expect(messageContentToText(123)).toBe("");
  });
});

describe("extractSimpleFileExistenceTarget", () => {
  it("extracts a project file from Chinese existence checks", () => {
    expect(
      extractSimpleFileExistenceTarget("只读确认 app/page.tsx 是否存在，最后一句话回答")
    ).toBe("app/page.tsx");
    expect(
      extractSimpleFileExistenceTarget("帮我确认 lib/agent-team/runtime.ts 是否存在")
    ).toBe("lib/agent-team/runtime.ts");
    expect(
      extractSimpleFileExistenceTarget("只读确认 package.json 是否存在")
    ).toBe("package.json");
  });

  it("extracts a project file from English existence checks", () => {
    expect(extractSimpleFileExistenceTarget("check if app/page.tsx exists")).toBe(
      "app/page.tsx"
    );
  });

  it("ignores broad analysis requests and unsafe paths", () => {
    expect(extractSimpleFileExistenceTarget("检查 app/page.tsx 的实现是否合理")).toBeNull();
    expect(
      extractSimpleFileExistenceTarget(
        "请确认 lib/agent-team/final-summary.ts 是否存在，并判断最终回答 adapter 是否能区分整体评估类问题。"
      )
    ).toBeNull();
    expect(extractSimpleFileExistenceTarget("确认 ../secret.txt 是否存在")).toBeNull();
  });
});

describe("safeProjectRelativePath", () => {
  it("normalizes safe project-relative paths", () => {
    expect(safeProjectRelativePath("/app/page.tsx")).toBe("app/page.tsx");
    expect(safeProjectRelativePath("lib\\agent-team\\runtime.ts")).toBe(
      "lib/agent-team/runtime.ts"
    );
  });

  it("rejects empty, parent traversal, and malformed paths", () => {
    expect(safeProjectRelativePath("")).toBeNull();
    expect(safeProjectRelativePath("../secret.txt")).toBeNull();
    expect(safeProjectRelativePath("app//page.tsx")).toBeNull();
  });
});

describe("teamRoleToSubagentRole", () => {
  it("maps research / critic roles, defaults to general", () => {
    expect(teamRoleToSubagentRole("资料收集")).toBe("research");
    expect(teamRoleToSubagentRole("Researcher")).toBe("research");
    expect(teamRoleToSubagentRole("挑战者")).toBe("code-review");
    expect(teamRoleToSubagentRole("critic")).toBe("code-review");
    expect(teamRoleToSubagentRole("协调者")).toBe("general");
  });
});

describe("parseTransitionStatus", () => {
  it("accepts valid statuses, rejects others", () => {
    expect(parseTransitionStatus("running")).toBe("running");
    expect(parseTransitionStatus("completed")).toBe("completed");
    expect(parseTransitionStatus("finalizing")).toBeNull();
    expect(parseTransitionStatus("bogus")).toBeNull();
    expect(parseTransitionStatus(undefined)).toBeNull();
  });
});

describe("mergeAgentTeamSettings", () => {
  it("returns base unchanged for non-object input", () => {
    const base = baseSettings();
    expect(mergeAgentTeamSettings(base, null)).toBe(base);
    expect(mergeAgentTeamSettings(base, "nope")).toBe(base);
  });

  it("forces read_only / disabled / none when capabilities are off", () => {
    const merged = mergeAgentTeamSettings(baseSettings(), {
      allowWrite: false,
      allowNetwork: false,
      allowWorktree: false,
      // even if explicit policies request more, capability gates win:
      writePolicy: "write_allowed",
      networkPolicy: "teammates_allowed",
      worktreePolicy: "per_task",
    });
    expect(merged.writePolicy).toBe("read_only");
    expect(merged.networkPolicy).toBe("disabled");
    expect(merged.worktreePolicy).toBe("none");
  });

  it("derives plan_approval when write allowed but plan approval required", () => {
    const merged = mergeAgentTeamSettings(baseSettings(), {
      allowWrite: true,
      requirePlanApproval: true,
    });
    expect(merged.writePolicy).toBe("plan_approval");
  });

  it("derives write_allowed when write allowed and no plan approval", () => {
    const merged = mergeAgentTeamSettings(baseSettings(), {
      allowWrite: true,
      requirePlanApproval: false,
    });
    expect(merged.writePolicy).toBe("write_allowed");
  });

  it("honors an explicit non-default network policy when network is on", () => {
    const merged = mergeAgentTeamSettings(baseSettings(), {
      allowNetwork: true,
      networkPolicy: "teammates_allowed",
    });
    expect(merged.networkPolicy).toBe("teammates_allowed");
  });

  it("defaults worktree to per_member when allowed without explicit policy", () => {
    const merged = mergeAgentTeamSettings(baseSettings(), {
      allowWorktree: true,
    });
    expect(merged.worktreePolicy).toBe("per_member");
  });

  it("validates enum fields and ignores invalid values", () => {
    const base = baseSettings();
    const merged = mergeAgentTeamSettings(base, {
      mode: "bogus",
      memberScale: "huge",
      displayMode: "nope",
    });
    expect(merged.mode).toBe(base.mode ?? "collaboration");
    expect(merged.memberScale).toBe(base.memberScale);
    expect(merged.displayMode).toBe(base.displayMode);
  });
});

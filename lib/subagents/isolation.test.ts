import { describe, expect, it } from "vitest";
import type { SubagentDefinition } from "./definition";
import type { SubagentTask } from "./types";
import { resolveIsolationBaseRef, resolveIsolationMode } from "./isolation";

function def(over: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    id: "impl",
    title: "Implementer",
    description: "d",
    prompt: "p",
    source: "project",
    versionHash: "h",
    ...over,
  };
}

function task(over: Partial<SubagentTask> = {}): SubagentTask {
  return { id: "t1", title: "T", prompt: "do", ...over };
}

describe("resolveIsolationMode", () => {
  it("defaults to none (backward compatible)", () => {
    expect(resolveIsolationMode(null, task())).toBe("none");
    expect(resolveIsolationMode(def(), task())).toBe("none");
  });

  it("honors definition.isolation worktree", () => {
    expect(
      resolveIsolationMode(def({ isolation: { mode: "worktree" } }), task())
    ).toBe("worktree");
  });

  it("honors permissionMode worktree", () => {
    expect(
      resolveIsolationMode(def({ permissionMode: "worktree" }), task())
    ).toBe("worktree");
  });

  it("honors task-requested worktree", () => {
    expect(resolveIsolationMode(null, task({ isolation: "worktree" }))).toBe(
      "worktree"
    );
    expect(
      resolveIsolationMode(def(), task({ isolation: "worktree" }))
    ).toBe("worktree");
  });

  it("definition isolation:none overrides task request", () => {
    expect(
      resolveIsolationMode(
        def({ isolation: { mode: "none" } }),
        task({ isolation: "worktree" })
      )
    ).toBe("none");
  });
});

describe("resolveIsolationBaseRef", () => {
  it("returns the definition base ref when set", () => {
    expect(
      resolveIsolationBaseRef(
        def({ isolation: { mode: "worktree", baseRef: "main" } })
      )
    ).toBe("main");
  });

  it("returns undefined when not set", () => {
    expect(resolveIsolationBaseRef(def())).toBeUndefined();
    expect(resolveIsolationBaseRef(null)).toBeUndefined();
  });
});

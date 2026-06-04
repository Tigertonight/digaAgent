import { describe, expect, it } from "vitest";
import type { SubagentDefinition } from "./definition";
import { resolveSubagentModel, resolveSubagentPermission } from "./policy";

const ROLE_DEFAULT = ["read", "grep", "find", "ls"];

function def(over: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    id: "x",
    title: "X",
    description: "d",
    prompt: "p",
    source: "project",
    versionHash: "h",
    ...over,
  };
}

describe("resolveSubagentPermission", () => {
  it("returns role defaults when there is no definition (backward compat)", () => {
    const res = resolveSubagentPermission(null, {}, ROLE_DEFAULT);
    expect(res.allowedTools).toEqual(ROLE_DEFAULT);
    expect(res.appliedMode).toBe("role-default");
  });

  it("uses requested tools over role defaults when no definition", () => {
    const res = resolveSubagentPermission(
      null,
      { requestedTools: ["read"] },
      ROLE_DEFAULT
    );
    expect(res.allowedTools).toEqual(["read"]);
  });

  it("readOnly strips write-capable tools", () => {
    const res = resolveSubagentPermission(
      def({ permissionMode: "readOnly" }),
      { requestedTools: ["read", "write", "apply_patch", "grep"] },
      ROLE_DEFAULT
    );
    expect(res.allowedTools).toEqual(["read", "grep"]);
    expect(res.appliedMode).toBe("readOnly");
    expect(res.notes.join(" ")).toMatch(/stripped/);
  });

  it("denyAll yields no tools", () => {
    const res = resolveSubagentPermission(
      def({ permissionMode: "denyAll" }),
      { requestedTools: ["read", "write"] },
      ROLE_DEFAULT
    );
    expect(res.allowedTools).toEqual([]);
    expect(res.appliedMode).toBe("denyAll");
  });

  it("boundedWrite keeps write tools only with writePaths", () => {
    const withPaths = resolveSubagentPermission(
      def({ permissionMode: "boundedWrite" }),
      { requestedTools: ["read", "write"], writePaths: ["src/"] },
      ROLE_DEFAULT
    );
    expect(withPaths.allowedTools).toContain("write");
    expect(withPaths.writePaths).toEqual(["src/"]);

    const noPaths = resolveSubagentPermission(
      def({ permissionMode: "boundedWrite" }),
      { requestedTools: ["read", "write"] },
      ROLE_DEFAULT
    );
    expect(noPaths.allowedTools).not.toContain("write");
    expect(noPaths.writePaths).toBeUndefined();
  });

  it("cannot escalate beyond the definition's pinned defaultTools", () => {
    const res = resolveSubagentPermission(
      def({ defaultTools: ["read", "grep"] }),
      { requestedTools: ["read", "grep", "shell", "write"] },
      ROLE_DEFAULT
    );
    // shell + write are not in the ceiling -> dropped.
    expect(res.allowedTools).toEqual(["read", "grep"]);
    expect(res.notes.join(" ")).toMatch(/intersected/);
  });

  it("falls back to definition.defaultTools when nothing requested", () => {
    const res = resolveSubagentPermission(
      def({ defaultTools: ["read"] }),
      {},
      ROLE_DEFAULT
    );
    expect(res.allowedTools).toEqual(["read"]);
  });

  it("dedupes and trims tools", () => {
    const res = resolveSubagentPermission(
      null,
      { requestedTools: [" read ", "read", "grep"] },
      ROLE_DEFAULT
    );
    expect(res.allowedTools).toEqual(["read", "grep"]);
  });
});

describe("resolveSubagentModel", () => {
  const parent = { provider: "anthropic", modelId: "claude-sonnet" };

  it("keeps parent model when no definition", () => {
    const res = resolveSubagentModel(null, parent);
    expect(res).toMatchObject({ ...parent, overridden: false });
  });

  it("overrides when definition specifies provider + id", () => {
    const res = resolveSubagentModel(
      def({ model: { provider: "openai-completions", id: "gpt-5" } }),
      parent
    );
    expect(res.overridden).toBe(true);
    expect(res.provider).toBe("openai-completions");
    expect(res.modelId).toBe("gpt-5");
  });

  it("falls back to parent when only id is given (no provider)", () => {
    const res = resolveSubagentModel(def({ model: { id: "gpt-5" } }), parent);
    expect(res.overridden).toBe(false);
    expect(res.provider).toBe("anthropic");
    expect(res.note).toMatch(/lacks a provider/);
  });

  it("keeps parent model when definition has no model policy", () => {
    const res = resolveSubagentModel(def({}), parent);
    expect(res.overridden).toBe(false);
    expect(res.modelId).toBe("claude-sonnet");
  });
});

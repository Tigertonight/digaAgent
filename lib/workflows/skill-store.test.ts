import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetWorkflowSkillStoreForTest,
  __setWorkflowSkillStoreRootForTest,
  deleteWorkflowSkill,
  getWorkflowSkill,
  listWorkflowSkills,
  putWorkflowSkill,
} from "./skill-store";

describe("workflow skill store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "workflow-skill-test-"));
    __setWorkflowSkillStoreRootForTest(root);
  });

  afterEach(async () => {
    __resetWorkflowSkillStoreForTest();
    __setWorkflowSkillStoreRootForTest(null);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("stores, reads, lists, updates, and deletes skills round-trip", () => {
    const created = putWorkflowSkill({
      name: "Module Review",
      description: 'Fan out review agents over modules, then synthesize.',
      instructions: "Use when reviewing many modules in parallel.\n\nInputs: modules[]",
      harness: "const r = await workflow.parallel([]); return r;",
      capabilities: ["spawn_agent", "read_files", "shell"],
      tags: ["review", "fan-out"],
    });

    // Name is slugified/lowercased.
    expect(created.name).toBe("module-review");

    const loaded = getWorkflowSkill("module-review");
    expect(loaded).toMatchObject({
      name: "module-review",
      description: "Fan out review agents over modules, then synthesize.",
      harness: "const r = await workflow.parallel([]); return r;",
      capabilities: ["spawn_agent", "read_files", "shell"],
      tags: ["review", "fan-out"],
    });
    expect(loaded?.instructions).toContain("Use when reviewing many modules");

    // Summary listing must NOT include the harness body (progressive disclosure).
    const summaries = listWorkflowSkills();
    expect(summaries).toEqual([
      expect.objectContaining({
        name: "module-review",
        description: "Fan out review agents over modules, then synthesize.",
        tags: ["review", "fan-out"],
      }),
    ]);
    expect(summaries[0]).not.toHaveProperty("harness");

    const updated = putWorkflowSkill({
      name: "module-review",
      description: "v2",
      harness: "return 'v2';",
    });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.createdAt);
    expect(getWorkflowSkill("module-review")?.harness).toBe("return 'v2';");

    expect(deleteWorkflowSkill("module-review")).toBe(true);
    expect(getWorkflowSkill("module-review")).toBeUndefined();
  });

  it("writes a human-readable SKILL.md with frontmatter and a separate harness.js", async () => {
    putWorkflowSkill({
      name: "demo",
      description: "demo skill",
      harness: "return 1;",
      tags: ["x"],
    });
    const md = await readFile(
      path.join(root, "workflows", "skills", "demo", "SKILL.md"),
      "utf8"
    );
    expect(md).toContain("---");
    expect(md).toContain("name: demo");
    expect(md).toContain('description: "demo skill"');
    const harness = await readFile(
      path.join(root, "workflows", "skills", "demo", "harness.js"),
      "utf8"
    );
    expect(harness).toBe("return 1;");
  });

  it("rejects unsafe skill names", () => {
    expect(() =>
      putWorkflowSkill({ name: "../bad", harness: "return 1;" })
    ).toThrow("invalid workflow skill name");
  });

  it("requires a harness body", () => {
    expect(() => putWorkflowSkill({ name: "empty", harness: "" })).toThrow(
      "harness is required"
    );
  });
});

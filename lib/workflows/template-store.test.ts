import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetWorkflowTemplateStoreForTest,
  __setWorkflowTemplateStoreRootForTest,
  deleteWorkflowTemplate,
  getWorkflowTemplate,
  listWorkflowTemplates,
  putWorkflowTemplate,
} from "./template-store";

describe("workflow template store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "workflow-template-test-"));
    __setWorkflowTemplateStoreRootForTest(root);
  });

  afterEach(async () => {
    __resetWorkflowTemplateStoreForTest();
    __setWorkflowTemplateStoreRootForTest(null);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("stores, lists, updates, and deletes workflow templates", () => {
    const first = putWorkflowTemplate({
      id: "triage",
      name: "Bug triage",
      description: "Classify and route bugs.",
      version: "1.0.0",
      script: "return workflow.params;",
      paramsSchema: {
        type: "object",
        properties: { queue: { type: "string" } },
      },
      defaultParams: { queue: "support" },
      capabilities: ["spawn_agent", "read_files"],
      tags: ["triage"],
    });

    expect(first.id).toBe("triage");
    expect(getWorkflowTemplate("triage")).toMatchObject({
      name: "Bug triage",
      defaultParams: { queue: "support" },
    });
    expect(listWorkflowTemplates()).toEqual([
      expect.objectContaining({ id: "triage", tags: ["triage"] }),
    ]);

    const updated = putWorkflowTemplate({
      id: "triage",
      name: "Bug triage v2",
      version: "1.1.0",
      script: "return workflow.template;",
    });

    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(getWorkflowTemplate("triage")).toMatchObject({
      name: "Bug triage v2",
      version: "1.1.0",
    });
    expect(deleteWorkflowTemplate("triage")).toBe(true);
    expect(getWorkflowTemplate("triage")).toBeUndefined();
  });

  it("rejects unsafe template ids", () => {
    expect(() =>
      putWorkflowTemplate({
        id: "../bad",
        script: "return null;",
      })
    ).toThrow("invalid workflow template id");
  });

  it("loads documented example templates", async () => {
    const examplesDir = path.join(
      process.cwd(),
      "docs",
      "examples",
      "workflow-templates"
    );
    const files = (await readdir(examplesDir)).filter((file) =>
      file.endsWith(".json")
    );

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const raw = JSON.parse(
        await readFile(path.join(examplesDir, file), "utf8")
      ) as {
        id: string;
        script: string;
      };
      const template = putWorkflowTemplate(raw);
      expect(template.id).toBeTruthy();
      expect(template.script).toContain("workflow.");
    }
    expect(listWorkflowTemplates()).toHaveLength(files.length);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkflowScriptTool,
  createWorkflowTemplateTool,
} from "./extension";
import {
  __resetWorkflowTemplateStoreForTest,
  __setWorkflowTemplateStoreRootForTest,
  putWorkflowTemplate,
} from "./template-store";
import {
  __resetWorkflowSkillStoreForTest,
  __setWorkflowSkillStoreRootForTest,
  putWorkflowSkill,
} from "./skill-store";
import type { RunWorkflowScriptInput } from "./types";

describe("workflow template tool", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "workflow-template-tool-test-"));
    __setWorkflowTemplateStoreRootForTest(root);
  });

  afterEach(async () => {
    __resetWorkflowTemplateStoreForTest();
    __setWorkflowTemplateStoreRootForTest(null);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("validates merged template params before running the script", async () => {
    putWorkflowTemplate({
      id: "triage",
      name: "Triage",
      script: "return workflow.params;",
      defaultParams: { priority: "high" },
      paramsSchema: {
        type: "object",
        required: ["queue", "priority"],
        properties: {
          queue: { type: "string" },
          priority: { enum: ["low", "high"] },
        },
      },
    });
    const tool = createWorkflowTemplateTool({
      onRunWorkflow: async () => {
        throw new Error("not used");
      },
      onRunWorkflowScript: async () => {
        throw new Error("should not run invalid template params");
      },
    });

    await expect(
      tool.execute(
        "call-1",
        { templateId: "triage", params: { priority: "urgent" } },
        new AbortController().signal,
        undefined,
        {} as never
      )
    ).rejects.toThrow(
      "workflow template params validation failed: $.queue is required; $.priority must be one of schema.enum"
    );
  });

  it("passes validated params and template metadata into the script runner", async () => {
    putWorkflowTemplate({
      id: "research",
      name: "Research",
      version: "2.1.0",
      script: "return workflow.params;",
      defaultParams: { depth: 2, topic: "workflow" },
      paramsSchema: {
        type: "object",
        required: ["topic", "depth"],
        properties: {
          topic: { type: "string" },
          depth: { type: "integer" },
        },
      },
    });
    const tool = createWorkflowTemplateTool({
      onRunWorkflow: async () => {
        throw new Error("not used");
      },
      onRunWorkflowScript: async (input) => ({
        workflowId: "wf-template",
        objective: input.objective,
        status: "completed",
        manifest: {
          capabilities: input.capabilities ?? ["spawn_agent", "read_files"],
          maxAgents: input.maxAgents ?? 8,
          maxConcurrency: input.maxConcurrency ?? 4,
          timeoutMs: input.timeoutMs ?? 60000,
          runtime: "process",
        },
        returnValue: {
          params: input.templateParams,
          template: input.templateRef,
        },
        artifacts: [],
        checkpoints: [],
        logs: [],
        traceEvents: [],
        startedAt: 1,
        endedAt: 2,
      }),
    });

    const result = await tool.execute(
      "call-2",
      { templateId: "research", params: { topic: "dynamic workflows" } },
      new AbortController().signal,
      undefined,
      {} as never
    );

    expect(result.details.returnValue).toEqual({
      params: { depth: 2, topic: "dynamic workflows" },
      template: { id: "research", name: "Research", version: "2.1.0" },
    });
  });
});

describe("workflow script tool contract", () => {
  it("makes script optional (script or skillRef) and documents spawnAgent answer aliases", () => {
    const tool = createWorkflowScriptTool({
      onRunWorkflow: async () => {
        throw new Error("not used");
      },
      onRunWorkflowScript: async () => {
        throw new Error("not used");
      },
    });
    const schema = tool.parameters as unknown as {
      required?: string[];
      properties?: Record<string, { description?: string }>;
    };

    expect(schema.required).toContain("objective");
    expect(schema.required).toContain("rationale");
    // script is now optional: it may be supplied inline OR via skillRef (reuse).
    expect(schema.required ?? []).not.toContain("script");
    expect(schema.properties?.script?.description).toContain(
      "JavaScript body"
    );
    expect(schema.properties?.skillRef?.description).toContain("saved workflow skill");
    expect((tool.promptGuidelines ?? []).join("\n")).toContain(
      "workflow.spawnAgent returns a subagent result with answer plus compatibility aliases text/output/summary"
    );
    // Reuse-first guidance is present (progressive disclosure).
    expect((tool.promptGuidelines ?? []).join("\n")).toContain("REUSE FIRST");
  });
});

describe("workflow script tool skillRef resolution", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "workflow-skillref-tool-test-"));
    __setWorkflowSkillStoreRootForTest(root);
  });

  afterEach(async () => {
    __resetWorkflowSkillStoreForTest();
    __setWorkflowSkillStoreRootForTest(null);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("resolves skillRef to the saved harness and its capabilities", async () => {
    putWorkflowSkill({
      name: "module-review",
      description: "review modules",
      harness: "return 'from-skill';",
      capabilities: ["spawn_agent", "read_files", "shell"],
    });

    let received: RunWorkflowScriptInput | undefined;
    const tool = createWorkflowScriptTool({
      onRunWorkflow: async () => {
        throw new Error("not used");
      },
      onRunWorkflowScript: async (input) => {
        received = input;
        return {
          workflowId: "wf-skill",
          objective: input.objective,
          status: "completed",
          manifest: {
            capabilities: input.capabilities ?? ["spawn_agent", "read_files"],
            maxAgents: 8,
            maxConcurrency: 4,
            timeoutMs: 60000,
            runtime: "process",
          },
          artifacts: [],
          checkpoints: [],
          logs: [],
          traceEvents: [],
          startedAt: 1,
          endedAt: 2,
        };
      },
    });

    await tool.execute(
      "call-skill",
      {
        objective: "Run saved skill.",
        rationale: "reuse",
        skillRef: "module-review",
      } as never,
      new AbortController().signal,
      undefined,
      {} as never
    );

    expect(received?.script).toBe("return 'from-skill';");
    expect(received?.capabilities).toEqual(["spawn_agent", "read_files", "shell"]);
  });

  it("throws a helpful error when skillRef does not exist", async () => {
    const tool = createWorkflowScriptTool({
      onRunWorkflow: async () => {
        throw new Error("not used");
      },
      onRunWorkflowScript: async () => {
        throw new Error("should not run");
      },
    });

    await expect(
      tool.execute(
        "call-missing",
        {
          objective: "Run missing skill.",
          rationale: "reuse",
          skillRef: "does-not-exist",
        } as never,
        new AbortController().signal,
        undefined,
        {} as never
      )
    ).rejects.toThrow("workflow skill not found: does-not-exist");
  });
});

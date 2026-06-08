import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkflowTemplateTool } from "./extension";
import {
  __resetWorkflowTemplateStoreForTest,
  __setWorkflowTemplateStoreRootForTest,
  putWorkflowTemplate,
} from "./template-store";

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

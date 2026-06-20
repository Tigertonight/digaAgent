import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkflowScriptTool,
  createWorkflowTemplateTool,
  createListWorkflowScriptDraftsTool,
  createReadWorkflowScriptDraftTool,
  createSaveWorkflowScriptDraftTool,
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
import { __setWorkflowScriptDraftRootForTest } from "./script-draft-store";
import type { RunWorkflowScriptInput } from "./types";
import type { WorkflowCapability } from "./types";

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
  let draftRoot: string;

  beforeEach(async () => {
    draftRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-draft-tool-test-"));
    __setWorkflowScriptDraftRootForTest(draftRoot);
  });

  afterEach(async () => {
    __setWorkflowScriptDraftRootForTest(null);
    if (draftRoot) await rm(draftRoot, { recursive: true, force: true });
  });

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
    expect((tool.promptGuidelines ?? []).join("\n")).toContain(
      "Child agent tool names must be canonical"
    );
    expect((tool.promptGuidelines ?? []).join("\n")).toContain(
      "Do not use glob; use find for file discovery and grep for content search"
    );
    expect((tool.promptGuidelines ?? []).join("\n")).toContain(
      "Child agent task timeouts are normalized to 1800000 ms"
    );
    expect((tool.promptGuidelines ?? []).join("\n")).toContain(
      "Workflow harness timeout defaults to 86400000 ms"
    );
    expect((tool.promptGuidelines ?? []).join("\n")).toContain(
      "save_workflow_script_draft"
    );
    expect((tool.promptGuidelines ?? []).join("\n")).toContain(
      "SPLIT LONG WORKFLOWS"
    );
    expect((tool.promptGuidelines ?? []).join("\n")).toContain(
      "partial_markdown_fence"
    );
    expect((tool.promptGuidelines ?? []).join("\n")).toContain(
      "REPORT TEMPLATES"
    );
    // Reuse-first guidance is present (progressive disclosure).
    expect((tool.promptGuidelines ?? []).join("\n")).toContain("REUSE FIRST");
  });

  it("does not label non-blocking quality warnings as substantively incomplete", async () => {
    const tool = createWorkflowScriptTool({
      onRunWorkflow: async () => {
        throw new Error("not used");
      },
      onRunWorkflowScript: async () => ({
        workflowId: "wf-quality-warning",
        objective: "Audit browser use.",
        status: "completed_with_warnings",
        manifest: {
          capabilities: ["spawn_agent", "read_files"],
          maxAgents: 8,
          maxConcurrency: 4,
          timeoutMs: 60000,
          runtime: "process",
        },
        returnValue: "done",
        artifacts: [],
        checkpoints: [],
        logs: [],
        traceEvents: [],
        warnings: ["报告产物「browser-use-audit-report」约 1489 字符，期望约 1500 字符"],
        startedAt: 1,
        endedAt: 2,
      }),
    });

    const result = await tool.execute(
      "call-quality-warning",
      {
        objective: "Audit browser use.",
        rationale: "quality gate",
        script: "return 'done';",
      },
      new AbortController().signal,
      undefined,
      {} as never
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).not.toContain("substantively incomplete");
    expect(text).toContain("quality warnings");
    expect(text).toContain("offer to refine or extend the artifact");
  });

  it("still treats missing required workflow outputs as incomplete", async () => {
    const tool = createWorkflowScriptTool({
      onRunWorkflow: async () => {
        throw new Error("not used");
      },
      onRunWorkflowScript: async () => ({
        workflowId: "wf-missing-report",
        objective: "Audit browser use.",
        status: "completed_with_warnings",
        manifest: {
          capabilities: ["spawn_agent", "read_files"],
          maxAgents: 8,
          maxConcurrency: 4,
          timeoutMs: 60000,
          runtime: "process",
        },
        returnValue: "done",
        artifacts: [],
        checkpoints: [],
        logs: [],
        traceEvents: [],
        warnings: ["必需产物「browser-use-audit-report」缺失"],
        startedAt: 1,
        endedAt: 2,
      }),
    });

    const result = await tool.execute(
      "call-missing-warning",
      {
        objective: "Audit browser use.",
        rationale: "quality gate",
        script: "return 'done';",
      },
      new AbortController().signal,
      undefined,
      {} as never
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("missing or empty");
    expect(text).toContain("incomplete");
  });

  it("persists script drafts in chunks and runs them by draftRef", async () => {
    const opts = {
      parentAgentId: () => "agent-draft-test",
      onRunWorkflow: async () => {
        throw new Error("not used");
      },
      onRunWorkflowScript: async (input: RunWorkflowScriptInput) => ({
        workflowId: "wf-draft",
        objective: input.objective,
        status: "completed" as const,
        manifest: {
          capabilities: ["spawn_agent", "read_files"] as WorkflowCapability[],
          maxAgents: 8,
          maxConcurrency: 4,
          timeoutMs: 60000,
          runtime: "process" as const,
        },
        returnValue: input.script,
        artifacts: [],
        checkpoints: [],
        logs: [],
        traceEvents: [],
        startedAt: 1,
        endedAt: 2,
      }),
    };
    const saveTool = createSaveWorkflowScriptDraftTool(opts);
    const listTool = createListWorkflowScriptDraftsTool(opts);
    const readTool = createReadWorkflowScriptDraftTool(opts);
    const runTool = createWorkflowScriptTool(opts);

    await saveTool.execute(
      "save-1",
      { id: "audit", title: "Audit", script: "workflow.checkpoint('a', 1);" },
      new AbortController().signal,
      undefined,
      {} as never
    );
    await saveTool.execute(
      "save-2",
      { id: "audit", append: "\nreturn 'done';" },
      new AbortController().signal,
      undefined,
      {} as never
    );

    const listed = await listTool.execute(
      "list",
      {},
      new AbortController().signal,
      undefined,
      {} as never
    );
    expect(JSON.stringify(listed.details)).toContain("audit");
    const read = await readTool.execute(
      "read",
      { id: "audit" },
      new AbortController().signal,
      undefined,
      {} as never
    );
    const readText =
      read.content[0]?.type === "text" ? read.content[0].text : "";
    expect(readText).toContain("return 'done';");

    const result = await runTool.execute(
      "run",
      {
        objective: "Run draft.",
        rationale: "Verify draftRef.",
        draftRef: "audit",
      },
      new AbortController().signal,
      undefined,
      {} as never
    );

    expect(result.details.returnValue).toContain("workflow.checkpoint");
    expect(result.details.returnValue).toContain("return 'done';");
  });

  it("rejects generated script calls that omit script, skillRef, and draftRef before running", async () => {
    let ran = false;
    const tool = createWorkflowScriptTool({
      onRunWorkflow: async () => {
        throw new Error("not used");
      },
      onRunWorkflowScript: async () => {
        ran = true;
        throw new Error("should not run without a script");
      },
    });

    await expect(
      tool.execute(
        "call-no-script",
        {
          objective: "Review workflow generation failure.",
          rationale: "Regression for truncated or missing generated script.",
        } as never,
        new AbortController().signal,
        undefined,
        {} as never
      )
    ).rejects.toThrow(
      "received neither a script, a valid draftRef, nor a valid skillRef",
    );
    expect(ran).toBe(false);
  });

  it("rejects oversized inline scripts and asks for draftRef", async () => {
    let ran = false;
    const tool = createWorkflowScriptTool({
      onRunWorkflow: async () => {
        throw new Error("not used");
      },
      onRunWorkflowScript: async () => {
        ran = true;
        throw new Error("should not run oversized inline script");
      },
    });

    await expect(
      tool.execute(
        "call-huge-script",
        {
          objective: "Review workflow generation failure.",
          rationale: "Regression for oversized generated script.",
          script: `const x = "${"x".repeat(19_000)}";\nreturn x.length;`,
        },
        new AbortController().signal,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/draft|draftRef|too|above|参数疑似被截断/i);
    expect(ran).toBe(false);
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

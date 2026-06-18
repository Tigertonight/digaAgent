import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWorkflowWorkerSpawnConfig,
  runWorkflowScript,
  validateWorkflowScript,
} from "./script-runtime";
import { __setWorkflowNetworkPolicyRootForTest } from "./network-policy";
import {
  __clearWorkflowMemoryForTest,
  __setWorkflowStoreRootForTest,
  getWorkflowRun,
  listRunningWorkflowRuns,
  workflowResumeSnapshot,
} from "./server-store";
import type { WorkflowEvent } from "./types";

describe("runWorkflowScript", () => {
  let workflowRoot: string;

  beforeEach(async () => {
    workflowRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-store-test-"));
    __setWorkflowStoreRootForTest(workflowRoot);
    __setWorkflowNetworkPolicyRootForTest(workflowRoot);
  });

  afterEach(async () => {
    __setWorkflowStoreRootForTest(null);
    __setWorkflowNetworkPolicyRootForTest(null);
    if (workflowRoot) {
      await rm(workflowRoot, { recursive: true, force: true });
    }
  });

  it("wraps workflow workers with a POSIX CPU limit when supported", () => {
    const config = buildWorkflowWorkerSpawnConfig({
      platform: "darwin",
      execPath: "/node",
      workerPath: "/worker.cjs",
      memoryMb: 96,
      cpuSeconds: 12,
    });

    expect(config.usesPosixCpuLimit).toBe(true);
    expect(config.command).toBe("/bin/sh");
    expect(config.args).toContain("12");
    expect(config.args).toContain("/node");
    expect(config.args).toContain("--max-old-space-size=96");
    expect(config.args).toContain("/worker.cjs");
    expect(config.usesExternalSandbox).toBe(false);
  });

  it("falls back to direct node worker spawn on Windows", () => {
    const config = buildWorkflowWorkerSpawnConfig({
      platform: "win32",
      execPath: "node.exe",
      workerPath: "worker.cjs",
      memoryMb: 96,
      cpuSeconds: 12,
    });

    expect(config.usesPosixCpuLimit).toBe(false);
    expect(config.usesExternalSandbox).toBe(false);
    expect(config.command).toBe("node.exe");
    expect(config.args).toEqual(["--max-old-space-size=96", "worker.cjs"]);
  });

  it("wraps workflow workers with an external sandbox argv when configured", () => {
    const config = buildWorkflowWorkerSpawnConfig({
      platform: "linux",
      execPath: "/node",
      workerPath: "/worker.cjs",
      memoryMb: 96,
      cpuSeconds: 12,
      sandboxArgv: [
        "bwrap",
        "--unshare-net",
        "--die-with-parent",
        "{command}",
        "{args}",
      ],
    });

    expect(config.usesExternalSandbox).toBe(true);
    expect(config.usesPosixCpuLimit).toBe(true);
    expect(config.command).toBe("bwrap");
    expect(config.args).toContain("--unshare-net");
    expect(config.args).toContain("/bin/sh");
    expect(config.args).toContain("--max-old-space-size=96");
    expect(config.args).toContain("/worker.cjs");
  });

  it("runs a generated harness through the workflow SDK", async () => {
    const prompts: string[] = [];
    const events: WorkflowEvent[] = [];

    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-1",
        onEvent: (event) => events.push(event),
        runSubagents: async (input) => {
          prompts.push(input.tasks[0]?.prompt ?? "");
          return {
            batchId: `batch-${prompts.length}`,
            results: [
              {
                taskId: input.tasks[0]?.id ?? "missing",
                agentId: `agent-${prompts.length}`,
                status: "completed",
                answer: `answer-${prompts.length}`,
                startedAt: Date.now(),
                endedAt: Date.now(),
              },
            ],
          };
        },
      },
      {
        objective: "Review modules.",
        rationale: "Parallel module review.",
        script: `
          const results = await workflow.parallel([
            () => workflow.spawnAgent({ id: "a", title: "A", prompt: "Review A." }),
            () => workflow.spawnAgent({ id: "b", title: "B", prompt: "Review B." }),
          ]);
          workflow.checkpoint("reviews", results.map((result) => result.answer));
          workflow.artifact("summary", { count: results.length });
          return {
            answers: results.map((result) => result.answer),
            texts: results.map((result) => result.text),
            outputs: results.map((result) => result.output),
            summaries: results.map((result) => result.summary),
          };
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(result.checkpoints[0]?.name).toBe("reviews");
    expect(result.artifacts[0]?.name).toBe("summary");
    expect(result.returnValue).toEqual({
      answers: ["answer-1", "answer-2"],
      texts: ["answer-1", "answer-2"],
      outputs: ["answer-1", "answer-2"],
      summaries: ["answer-1", "answer-2"],
    });
    expect(result.manifest.capabilities).toEqual(["spawn_agent", "read_files"]);
    expect(result.manifest.maxAgents).toBe(8);
    expect(result.manifest.maxConcurrency).toBe(4);
    expect(events.map((event) => event.type)).toEqual([
      "workflow_start",
      "workflow_checkpoint",
      "workflow_artifact",
      "workflow_end",
    ]);
    expect(getWorkflowRun(result.workflowId)?.status).toBe("completed");
    expect(listRunningWorkflowRuns("parent-1")).toHaveLength(0);
  });

  it("keeps subagent answers available to scripts that write text artifacts", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-recon",
        runSubagents: async (input) => ({
          batchId: "batch-recon",
          results: [
            {
              taskId: input.tasks[0]?.id ?? "recon",
              agentId: "agent-recon",
              status: "completed",
              answer: "RECON: workflow and goal session routes inspected.",
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          ],
        }),
      },
      {
        objective: "Audit session workflow behavior.",
        rationale: "Reproduce the latest-session recon artifact path.",
        script: `
          const recon = await workflow.spawnAgent({
            id: "recon",
            title: "Recon latest session logs",
            prompt: "Inspect workflow/goal session behavior."
          });
          workflow.checkpoint("recon-done", { length: recon.text.length });
          workflow.artifact("recon.md", recon.text || "");
          return { answer: recon.answer, text: recon.text };
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(result.returnValue).toEqual({
      answer: "RECON: workflow and goal session routes inspected.",
      text: "RECON: workflow and goal session routes inspected.",
    });
    expect(result.checkpoints[0]?.value).toEqual({ length: 50 });
    expect(result.artifacts[0]).toMatchObject({
      name: "recon.md",
      value: "RECON: workflow and goal session routes inspected.",
    });
  });

  it("runs workflow.agent with schema validation and structured data", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-agent-schema",
        runSubagents: async (input) => ({
          batchId: "batch-agent-schema",
          results: [
            {
              taskId: input.tasks[0]?.id ?? "schema-agent",
              agentId: "agent-schema",
              status: "completed",
              answer: JSON.stringify({ bugs: ["missing auth check"], count: 1 }),
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          ],
        }),
      },
      {
        objective: "Audit auth.",
        rationale: "Verify schema output.",
        script: `
          return await workflow.agent("Audit auth.ts", {
            id: "auth-audit",
            title: "Auth audit",
            agentType: "reviewer",
            schema: {
              type: "object",
              required: ["bugs", "count"],
              properties: {
                bugs: { type: "array", items: { type: "string" } },
                count: { type: "number" }
              }
            }
          });
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(result.returnValue).toMatchObject({
      title: "Auth audit",
      data: { bugs: ["missing auth check"], count: 1 },
      taskId: "auth-audit",
    });
    expect(result.artifacts[0]).toMatchObject({
      name: "schema-output:auth-audit",
      kind: "schema_output",
      value: { valid: true },
    });
    expect(result.traceEvents.map((event) => event.type)).toEqual([
      "agent_start",
      "schema_validation",
      "agent_end",
    ]);
    expect(getWorkflowRun(result.workflowId)?.traceEvents?.length).toBe(3);
  });

  it("fails workflow.agent when schema validation fails", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-agent-schema-fail",
        runSubagents: async (input) => ({
          batchId: "batch-agent-schema-fail",
          results: [
            {
              taskId: input.tasks[0]?.id ?? "schema-agent",
              agentId: "agent-schema-fail",
              status: "completed",
              answer: JSON.stringify({ bugs: "not-an-array" }),
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          ],
        }),
      },
      {
        objective: "Audit auth.",
        rationale: "Verify schema failure.",
        script: `
          await workflow.agent("Audit auth.ts", {
            id: "auth-audit-fail",
            title: "Auth audit",
            schema: {
              type: "object",
              required: ["bugs", "count"],
              properties: {
                bugs: { type: "array", items: { type: "string" } },
                count: { type: "number" }
              }
            }
          });
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("workflow.agent schema validation failed");
    expect(result.artifacts[0]).toMatchObject({
      name: "schema-output:auth-audit-fail",
      kind: "schema_output",
      value: { valid: false },
    });
    expect(result.traceEvents.some(
      (event) => event.type === "schema_validation" && event.valid === false
    )).toBe(true);
  });

  it("runs workflow.agent inside an automatically-created worktree", async () => {
    const approvals: string[] = [];
    const cwdSeen: Array<string | undefined> = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-agent-worktree",
        approveCapability: async (request) => {
          approvals.push(request.capability);
          return { decision: "allow" };
        },
        worktrees: {
          async create(input) {
            return {
              id: `${input.workflowId.slice(0, 4)}-agent`,
              path: "/tmp/workflow-agent",
              branchName: "diga-agent-workflow/test/agent",
              baseRef: input.baseRef ?? "HEAD",
              createdAt: Date.now(),
            };
          },
        },
        runSubagents: async (input) => {
          cwdSeen.push(input.tasks[0]?.cwd);
          return {
            batchId: "batch-agent-worktree",
            results: [
              {
                taskId: input.tasks[0]?.id ?? "agent-worktree",
                agentId: "agent-worktree",
                status: "completed",
                answer: "done",
                startedAt: Date.now(),
                endedAt: Date.now(),
              },
            ],
          };
        },
      },
      {
        objective: "Implement isolated change.",
        rationale: "Verify agent isolation option.",
        capabilities: ["spawn_agent", "read_files", "worktree"],
        script: `
          return await workflow.agent("Inspect inside worktree", {
            id: "isolated-agent",
            title: "Isolated agent",
            isolation: "worktree"
          });
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(approvals).toEqual(["worktree"]);
    expect(cwdSeen).toEqual(["/tmp/workflow-agent"]);
    expect(result.returnValue).toMatchObject({
      title: "Isolated agent",
      text: "done",
      worktree: { path: "/tmp/workflow-agent" },
    });
    expect(result.artifacts.some((artifact) => artifact.name.startsWith("worktree:"))).toBe(true);
  });

  it("supports fan-out and synthesis through workflow.patterns", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-pattern-fanout",
        runSubagents: async (input) => ({
          batchId: "batch-pattern-fanout",
          results: [
            {
              taskId: input.tasks[0]?.id ?? "task",
              agentId: `agent-${input.tasks[0]?.id ?? "task"}`,
              status: "completed",
              answer: JSON.stringify({ item: input.tasks[0]?.id, ok: true }),
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          ],
        }),
      },
      {
        objective: "Review modules.",
        rationale: "Verify fan-out pattern.",
        script: `
          return await workflow.patterns.fanOutAndSynthesize({
            items: ["auth", "billing"],
            worker: (item) => workflow.agent("Review " + item, {
              id: item,
              title: "Review " + item,
              schema: {
                type: "object",
                required: ["item", "ok"],
                properties: {
                  item: { type: "string" },
                  ok: { type: "boolean" }
                }
              }
            }),
            synthesizer: (results) => ({
              count: results.length,
              items: results.map((result) => result.data.item)
            })
          });
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(result.returnValue).toEqual({ count: 2, items: ["auth", "billing"] });
    expect(result.artifacts.filter((artifact) => artifact.kind === "schema_output")).toHaveLength(2);
  });

  it("supports adversarial verification through workflow.patterns", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-pattern-verify",
        runSubagents: async (input) => ({
          batchId: "batch-pattern-verify",
          results: [
            {
              taskId: input.tasks[0]?.id ?? "verifier",
              agentId: "agent-verifier",
              status: "completed",
              answer: JSON.stringify({ pass: true, issues: [] }),
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          ],
        }),
      },
      {
        objective: "Verify report.",
        rationale: "Verify adversarial pattern.",
        script: `
          return await workflow.patterns.adversarialVerify({
            draft: "All auth paths enforce login.",
            criteria: "Find unsupported security claims.",
            verifierCount: 2,
            requirePass: true
          });
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(result.returnValue).toMatchObject({ passed: true });
    expect(result.artifacts.some((artifact) => artifact.name === "adversarial-verification")).toBe(true);
  });

  it("supports loop-until-done through workflow.patterns", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-pattern-loop",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Iterate until complete.",
        rationale: "Verify loop pattern.",
        script: `
          return await workflow.patterns.loopUntilDone({
            state: { count: 0 },
            maxIterations: 5,
            step: (state) => ({ count: state.count + 1 }),
            verifier: (state) => ({ done: state.count >= 3 }),
            stopWhen: (_state, verification) => verification.done
          });
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(result.returnValue).toMatchObject({
      state: { count: 3 },
      iterations: 3,
    });
    expect(result.checkpoints).toHaveLength(3);
  });

  it("exposes template params and metadata inside the workflow worker", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-template-params",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Run template.",
        rationale: "Verify template init data.",
        script: "return { params: workflow.params, template: workflow.template };",
        templateParams: { topic: "dynamic workflows", depth: 2 },
        templateRef: {
          id: "deep-research",
          name: "Deep research",
          version: "1.0.0",
        },
      }
    );

    expect(result.status).toBe("completed");
    expect(result.returnValue).toEqual({
      params: { topic: "dynamic workflows", depth: 2 },
      template: {
        id: "deep-research",
        name: "Deep research",
        version: "1.0.0",
      },
    });
  });

  it("does not expose Node process or require", async () => {
    const result = await runWorkflowScript(
      {
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Probe sandbox.",
        rationale: "Verify script boundary.",
        script: `
          return {
            processType: typeof process,
            requireType: typeof require,
          };
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(result.returnValue).toEqual({
      processType: "undefined",
      requireType: "undefined",
    });
  });

  it("aborts through the external signal and persists the aborted state", async () => {
    const controller = new AbortController();

    const resultPromise = runWorkflowScript(
      {
        parentAgentId: "parent-2",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Abort workflow.",
        rationale: "Verify abort persistence.",
        script: "await workflow.sleep(1000); return 'done';",
      },
      controller.signal
    );
    controller.abort();
    const result = await resultPromise;

    expect(result.status).toBe("aborted");
    expect(getWorkflowRun(result.workflowId)?.status).toBe("aborted");
  });

  it("blocks unsafe child-agent tools when no approval broker exists", async () => {
    // P0-4(a): bash in allowedTools is now inferred to the shell capability at
    // startup, so an undeclared/unapproved shell tool fails BEFORE spawning the
    // agent (via the approval broker) rather than failing the child at runtime.
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-3",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Try unsafe tool.",
        rationale: "Verify capability boundary.",
        script: `
          await workflow.spawnAgent({
            title: "Unsafe",
            prompt: "Run a command",
            allowedTools: ["read", "bash"]
          });
        `,
      }
    );

    expect(result.status).toBe("failed");
    // Inferred shell capability requires approval; with no broker it fails early.
    expect(result.error).toContain("approval broker is not implemented for: shell");
    expect(result.manifest.capabilities).toContain("shell");
  });

  it("allows inferred shell capability through the approval broker", async () => {
    const approvals: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-3b",
        approveCapability: async (request) => {
          approvals.push(request.capability);
          return { decision: "allow" };
        },
        runSubagents: async (input) => ({
          batchId: "batch",
          results: [
            {
              taskId: input.tasks[0]?.id ?? "missing",
              agentId: "agent",
              status: "completed",
              answer: "ok",
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          ],
        }),
      },
      {
        objective: "Try unsafe tool with approval.",
        rationale: "Verify capability boundary.",
        script: `
          await workflow.spawnAgent({
            title: "Unsafe",
            prompt: "Run a command",
            allowedTools: ["read", "bash"]
          });
          return "done";
        `,
      }
    );

    expect(approvals).toContain("shell");
    expect(result.status).toBe("completed");
  });

  it("fails early when manifest capabilities need approval but no broker exists", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-4",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Write code.",
        rationale: "Verify capability broker.",
        capabilities: ["spawn_agent", "read_files", "write_files"],
        script: "return 'unreachable';",
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("approval broker is not implemented for: write_files");
    expect(result.manifest.capabilities).toEqual([
      "spawn_agent",
      "read_files",
      "write_files",
    ]);
    expect(getWorkflowRun(result.workflowId)?.status).toBe("failed");
  });

  it("uses the broker to approve write_files before passing edit tools to subagents", async () => {
    const allowedTools: Array<string[] | undefined> = [];
    const approvals: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-7",
        approveCapability: async (request) => {
          approvals.push(request.capability);
          return { decision: "allow" };
        },
        runSubagents: async (input) => {
          allowedTools.push(input.tasks[0]?.allowedTools);
          return {
            batchId: "batch-write",
            results: [
              {
                taskId: input.tasks[0]?.id ?? "task",
                agentId: "agent-write",
                status: "completed",
                answer: "edited",
                startedAt: Date.now(),
              },
            ],
          };
        },
      },
      {
        objective: "Edit a file.",
        rationale: "Verify write capability approval.",
        capabilities: ["spawn_agent", "read_files", "write_files"],
        script: `
          return await workflow.spawnAgent({
            title: "Edit",
            prompt: "Edit safely",
            allowedTools: ["read", "edit"]
          });
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(approvals).toEqual(["write_files"]);
    expect(allowedTools).toEqual([["read", "edit"]]);
  });

  it("stops when the broker denies a requested capability", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-8",
        approveCapability: async () => ({
          decision: "deny",
          denyReason: "User denied writes.",
        }),
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Edit a file.",
        rationale: "Verify denied broker path.",
        capabilities: ["spawn_agent", "read_files", "write_files"],
        script: "return 'unreachable';",
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("User denied writes.");
  });

  it("passes approved shell tools through to child agents", async () => {
    const allowedTools: Array<string[] | undefined> = [];
    const approvals: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-shell",
        approveCapability: async (request) => {
          approvals.push(request.capability);
          return { decision: "allow" };
        },
        runSubagents: async (input) => {
          allowedTools.push(input.tasks[0]?.allowedTools);
          return {
            batchId: "batch-shell",
            results: [
              {
                taskId: input.tasks[0]?.id ?? "task",
                agentId: "agent-shell",
                status: "completed",
                answer: "shell ok",
                startedAt: Date.now(),
              },
            ],
          };
        },
      },
      {
        objective: "Run a checked command.",
        rationale: "Verify shell capability approval.",
        capabilities: ["spawn_agent", "read_files", "shell"],
        script: `
          return await workflow.spawnAgent({
            title: "Shell check",
            prompt: "Run a non-destructive command",
            allowedTools: ["read", "bash"]
          });
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(approvals).toEqual(["shell"]);
    expect(allowedTools).toEqual([["read", "bash"]]);
  });

  it("passes approved browser tools through to child agents", async () => {
    const allowedTools: Array<string[] | undefined> = [];
    const approvals: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-browser",
        approveCapability: async (request) => {
          approvals.push(request.capability);
          return { decision: "allow" };
        },
        runSubagents: async (input) => {
          allowedTools.push(input.tasks[0]?.allowedTools);
          return {
            batchId: "batch-browser",
            results: [
              {
                taskId: input.tasks[0]?.id ?? "task",
                agentId: "agent-browser",
                status: "completed",
                answer: "browser ok",
                startedAt: Date.now(),
              },
            ],
          };
        },
      },
      {
        objective: "Verify a page.",
        rationale: "Verify browser capability approval.",
        capabilities: ["spawn_agent", "read_files", "browser"],
        script: `
          return await workflow.spawnAgent({
            title: "Browser check",
            prompt: "Open and verify a local page",
            allowedTools: ["browser_open", "browser_extract", "browser_verify"]
          });
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(approvals).toEqual(["browser"]);
    expect(allowedTools).toEqual([
      ["browser_open", "browser_extract", "browser_verify"],
    ]);
  });

  it("asks the user through the host clarification runtime after approval", async () => {
    const approvals: string[] = [];
    const questions: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-ask",
        approveCapability: async (request) => {
          approvals.push(request.capability);
          return { decision: "allow" };
        },
        askUser: async (request) => {
          questions.push(request.input.question);
          return {
            requestId: "ask-1",
            selectedOptionId: "fast",
            answer: "Use the fast path.",
          };
        },
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Choose a path.",
        rationale: "Verify ask_user runtime.",
        capabilities: ["spawn_agent", "read_files", "ask_user"],
        script: `
          const answer = await workflow.askUser({
            title: "Choose path",
            question: "Which implementation path should we use?",
            options: [
              { id: "fast", label: "Fast", value: "Use the fast path." },
              { id: "safe", label: "Safe", value: "Use the safe path." }
            ],
            recommendedOptionId: "fast"
          });
          workflow.checkpoint("user-choice", answer);
          return answer;
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(approvals).toEqual(["ask_user"]);
    expect(questions).toEqual(["Which implementation path should we use?"]);
    expect(result.returnValue).toEqual({
      requestId: "ask-1",
      selectedOptionId: "fast",
      answer: "Use the fast path.",
    });
    expect(result.checkpoints[0]?.name).toBe("user-choice");
  });

  it("blocks workflow.askUser until ask_user is declared", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-ask-block",
        askUser: async () => ({
          requestId: "unreachable",
          answer: "unreachable",
        }),
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Ask without capability.",
        rationale: "Verify ask_user capability boundary.",
        script: `
          await workflow.askUser({
            question: "Continue?",
            options: [{ id: "yes", label: "Yes" }]
          });
        `,
      }
    );

    expect(result.status).toBe("failed");
    // P0-4(a): workflow.askUser is inferred -> ask_user requires approval; with
    // no broker the workflow fails before reaching the call.
    expect(result.error).toContain("ask_user");
    expect(result.manifest.capabilities).toContain("ask_user");
  });

  it("fetches URLs through the host network runtime after approval", async () => {
    const approvals: string[] = [];
    const urls: string[] = [];
    const requestApprovals: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-network",
        approveCapability: async (request) => {
          approvals.push(request.capability);
          return { decision: "allow" };
        },
        approveNetworkRequest: async (request) => {
          requestApprovals.push(request.input.url);
          return { decision: "allow" };
        },
        fetchUrl: async (input) => {
          urls.push(input.url);
          return {
            url: input.url,
            status: 200,
            ok: true,
            statusText: "OK",
            contentType: "application/json",
            text: '{"ok":true}',
            truncated: false,
          };
        },
        resolveFetchHost: async () => ["93.184.216.34"],
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Fetch public data.",
        rationale: "Verify network capability runtime.",
        capabilities: ["spawn_agent", "read_files", "network"],
        script: `
          const response = await workflow.fetchUrl({
            url: "https://example.com/data.json",
            maxBytes: 1024
          });
          workflow.artifact("fetched", response);
          return response;
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(approvals).toEqual(["network"]);
    expect(requestApprovals).toEqual(["https://example.com/data.json"]);
    expect(urls).toEqual(["https://example.com/data.json"]);
    expect(result.returnValue).toMatchObject({
      status: 200,
      ok: true,
      text: '{"ok":true}',
    });
    expect(result.artifacts[0]?.name).toBe("fetched");
    expect(result.logs.some((log) => log.message.includes("[network] fetched"))).toBe(true);
  });

  it("blocks workflow.fetchUrl until network is declared", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-network-block",
        fetchUrl: async () => ({
          url: "https://example.com",
          status: 200,
          ok: true,
          statusText: "OK",
          text: "unreachable",
          truncated: false,
        }),
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Fetch without capability.",
        rationale: "Verify network boundary.",
        script: `
          await workflow.fetchUrl({ url: "https://example.com" });
        `,
      }
    );

    expect(result.status).toBe("failed");
    // P0-4(a): workflow.fetchUrl is inferred -> network requires approval.
    expect(result.error).toContain("network");
    expect(result.manifest.capabilities).toContain("network");
  });

  it("blocks private-network URLs in the default network runtime", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-network-private",
        approveCapability: async () => ({ decision: "allow" }),
        approveNetworkRequest: async () => ({ decision: "allow" }),
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Fetch private URL.",
        rationale: "Verify default network policy.",
        capabilities: ["spawn_agent", "read_files", "network"],
        script: `
          await workflow.fetchUrl({ url: "http://127.0.0.1:3000" });
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("does not allow localhost or private-network URLs");
  });

  it("blocks public-looking URLs when DNS resolves to a private address", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-network-dns",
        approveCapability: async () => ({ decision: "allow" }),
        approveNetworkRequest: async () => ({ decision: "allow" }),
        resolveFetchHost: async () => ["10.0.0.2"],
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Fetch DNS-rebound URL.",
        rationale: "Verify DNS-level network policy.",
        capabilities: ["spawn_agent", "read_files", "network"],
        script: `
          await workflow.fetchUrl({ url: "https://example.com" });
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain(
      "does not allow URLs that resolve to localhost or private-network addresses"
    );
  });

  it("denies individual network requests before calling the host fetch runtime", async () => {
    const urls: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-network-deny",
        approveCapability: async () => ({ decision: "allow" }),
        approveNetworkRequest: async () => ({
          decision: "deny",
          denyReason: "Do not fetch this URL.",
        }),
        fetchUrl: async (input) => {
          urls.push(input.url);
          return {
            url: input.url,
            status: 200,
            ok: true,
            statusText: "OK",
            text: "unreachable",
            truncated: false,
          };
        },
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Deny network request.",
        rationale: "Verify per-request approval.",
        capabilities: ["spawn_agent", "read_files", "network"],
        script: `
          await workflow.fetchUrl({ url: "https://example.com/private" });
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Do not fetch this URL.");
    expect(urls).toEqual([]);
    expect(result.logs.some((log) => log.message.includes("[network] denied by user"))).toBe(true);
  });

  it("enforces workflow network allowlist before custom fetch hooks", async () => {
    const urls: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-network-allowlist",
        approveCapability: async () => ({ decision: "allow" }),
        approveNetworkRequest: async () => ({ decision: "allow" }),
        networkPolicy: {
          allowedOrigins: ["https://api.example.com"],
        },
        resolveFetchHost: async () => ["93.184.216.34"],
        fetchUrl: async (input) => {
          urls.push(input.url);
          return {
            url: input.url,
            status: 200,
            ok: true,
            statusText: "OK",
            text: "unreachable",
            truncated: false,
          };
        },
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Fetch outside allowlist.",
        rationale: "Verify configurable network policy.",
        capabilities: ["spawn_agent", "read_files", "network"],
        script: `
          await workflow.fetchUrl({ url: "https://other.example.com/data" });
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("network policy does not allow URL");
    expect(urls).toEqual([]);
    expect(result.logs.some((log) => log.message.includes("[network] blocked or failed"))).toBe(true);
  });

  it("gives workflow network deny patterns precedence over allow rules", async () => {
    const urls: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-network-deny-pattern",
        approveCapability: async () => ({ decision: "allow" }),
        approveNetworkRequest: async () => ({ decision: "allow" }),
        networkPolicy: {
          allowedOrigins: ["https://api.example.com"],
          deniedUrlPatterns: ["https://api.example.com/private/*"],
        },
        resolveFetchHost: async () => ["93.184.216.34"],
        fetchUrl: async (input) => {
          urls.push(input.url);
          return {
            url: input.url,
            status: 200,
            ok: true,
            statusText: "OK",
            text: "unreachable",
            truncated: false,
          };
        },
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Fetch denied path.",
        rationale: "Verify deny precedence.",
        capabilities: ["spawn_agent", "read_files", "network"],
        script: `
          await workflow.fetchUrl({ url: "https://api.example.com/private/token" });
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("network policy denies URL");
    expect(urls).toEqual([]);
  });

  it("creates an approved worktree and lets agents run inside it", async () => {
    const approvals: string[] = [];
    const cwdSeen: Array<string | undefined> = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-10",
        approveCapability: async (request) => {
          approvals.push(request.capability);
          return { decision: "allow" };
        },
        worktrees: {
          async create(input) {
            return {
              id: `${input.workflowId.slice(0, 4)}-ui`,
              path: "/tmp/workflow-ui",
              branchName: "diga-agent-workflow/test/ui",
              baseRef: input.baseRef ?? "HEAD",
              createdAt: Date.now(),
            };
          },
        },
        runSubagents: async (input) => {
          cwdSeen.push(input.tasks[0]?.cwd);
          return {
            batchId: "batch-worktree",
            results: [
              {
                taskId: input.tasks[0]?.id ?? "task",
                agentId: "agent-worktree",
                status: "completed",
                answer: "changed",
                startedAt: Date.now(),
              },
            ],
          };
        },
      },
      {
        objective: "Implement in isolation.",
        rationale: "Verify worktree runtime.",
        capabilities: ["spawn_agent", "read_files", "write_files", "worktree"],
        script: `
          const wt = await workflow.createWorktree({ name: "ui" });
          await workflow.spawnAgent({
            title: "Implementation",
            prompt: "Change files in the isolated worktree",
            cwd: wt.path,
            allowedTools: ["read", "edit"]
          });
          return wt;
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(approvals).toEqual(["write_files", "worktree"]);
    expect(cwdSeen).toEqual(["/tmp/workflow-ui"]);
    expect(result.artifacts.some((artifact) => artifact.name.startsWith("worktree:"))).toBe(true);
    expect(result.returnValue).toMatchObject({
      path: "/tmp/workflow-ui",
      branchName: "diga-agent-workflow/test/ui",
    });
  });

  it("requires a worktree runtime after worktree approval", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-11",
        approveCapability: async () => ({ decision: "allow" }),
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Create worktree.",
        rationale: "Verify missing runtime.",
        capabilities: ["spawn_agent", "read_files", "worktree"],
        script: "await workflow.createWorktree({ name: 'missing' });",
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("requires a worktree runtime");
  });

  it("diffs and merges a workflow-created worktree through the manager", async () => {
    const calls: string[] = [];
    const mergeApprovals: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-12",
        approveCapability: async () => ({ decision: "allow" }),
        approveWorktreeMerge: async (request) => {
          mergeApprovals.push(request.diff.stat);
          return { decision: "allow" };
        },
        worktrees: {
          async create(input) {
            calls.push("create");
            return {
              id: `${input.workflowId.slice(0, 4)}-feature`,
              path: "/tmp/workflow-feature",
              branchName: "diga-agent-workflow/test/feature",
              baseRef: "HEAD",
              createdAt: Date.now(),
            };
          },
          async diff(worktree) {
            calls.push(`diff:${worktree.id}`);
            return {
              worktreeId: worktree.id,
              path: worktree.path,
              branchName: worktree.branchName,
              baseRef: worktree.baseRef,
              diff: "diff --git a/a.txt b/a.txt\n",
              stat: " a.txt | 1 +",
              createdAt: Date.now(),
            };
          },
          async merge(worktree) {
            calls.push(`merge:${worktree.id}`);
            return {
              worktreeId: worktree.id,
              path: worktree.path,
              branchName: worktree.branchName,
              mergedAt: Date.now(),
              applied: true,
              summary: " a.txt | 1 +",
            };
          },
        },
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Merge isolated changes.",
        rationale: "Verify worktree diff and merge.",
        capabilities: ["spawn_agent", "read_files", "write_files", "worktree"],
        script: `
          const wt = await workflow.createWorktree({ name: "feature" });
          const diff = await workflow.diffWorktree(wt);
          const merge = await workflow.mergeWorktree(wt);
          return { diffStat: diff.stat, merged: merge.applied };
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(calls).toEqual([
      "create",
      `diff:${result.returnValue ? result.workflowId.slice(0, 4) : ""}-feature`,
      `diff:${result.returnValue ? result.workflowId.slice(0, 4) : ""}-feature`,
      `merge:${result.returnValue ? result.workflowId.slice(0, 4) : ""}-feature`,
    ]);
    expect(mergeApprovals).toEqual([" a.txt | 1 +"]);
    expect(result.artifacts.some((artifact) => artifact.name.startsWith("worktree-diff:"))).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.name.startsWith("worktree-merge:"))).toBe(true);
    expect(result.returnValue).toEqual({
      diffStat: " a.txt | 1 +",
      merged: true,
    });
  });

  it("requires write_files before merging a worktree", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-13",
        approveCapability: async () => ({ decision: "allow" }),
        worktrees: {
          async create(input) {
            return {
              id: `${input.workflowId.slice(0, 4)}-feature`,
              path: "/tmp/workflow-feature",
              branchName: "diga-agent-workflow/test/feature",
              baseRef: "HEAD",
              createdAt: Date.now(),
            };
          },
          async merge(worktree) {
            return {
              worktreeId: worktree.id,
              path: worktree.path,
              branchName: worktree.branchName,
              mergedAt: Date.now(),
              applied: true,
            };
          },
        },
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Merge without write capability.",
        rationale: "Verify merge guard.",
        capabilities: ["spawn_agent", "read_files", "worktree"],
        script: `
          const wt = await workflow.createWorktree({ name: "feature" });
          await workflow.mergeWorktree(wt);
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("workflow capability required: write_files");
  });

  it("denies worktree merge after diff preview without applying the patch", async () => {
    const calls: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-14",
        approveCapability: async () => ({ decision: "allow" }),
        approveWorktreeMerge: async (request) => {
          calls.push(`approval:${request.diff.stat}`);
          return {
            decision: "deny",
            denyReason: "Review the diff manually first.",
          };
        },
        worktrees: {
          async create(input) {
            calls.push("create");
            return {
              id: `${input.workflowId.slice(0, 4)}-feature`,
              path: "/tmp/workflow-feature",
              branchName: "diga-agent-workflow/test/feature",
              baseRef: "HEAD",
              createdAt: Date.now(),
            };
          },
          async diff(worktree) {
            calls.push(`diff:${worktree.id}`);
            return {
              worktreeId: worktree.id,
              path: worktree.path,
              branchName: worktree.branchName,
              baseRef: worktree.baseRef,
              diff: "diff --git a/a.txt b/a.txt\n",
              stat: " a.txt | 1 +",
              createdAt: Date.now(),
            };
          },
          async merge(worktree) {
            calls.push(`merge:${worktree.id}`);
            return {
              worktreeId: worktree.id,
              path: worktree.path,
              branchName: worktree.branchName,
              mergedAt: Date.now(),
              applied: true,
            };
          },
        },
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Reject isolated changes.",
        rationale: "Verify merge-specific approval.",
        capabilities: ["spawn_agent", "read_files", "write_files", "worktree"],
        script: `
          const wt = await workflow.createWorktree({ name: "feature" });
          await workflow.mergeWorktree(wt);
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("Review the diff manually first.");
    expect(calls).toEqual([
      "create",
      `diff:${result.workflowId.slice(0, 4)}-feature`,
      "approval: a.txt | 1 +",
    ]);
    expect(result.artifacts.some((artifact) => artifact.name.startsWith("worktree-diff:"))).toBe(true);
  });

  it("records a merge failure artifact when applying a worktree patch fails", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-merge-failure",
        approveCapability: async () => ({ decision: "allow" }),
        approveWorktreeMerge: async () => ({ decision: "allow" }),
        worktrees: {
          async create(input) {
            return {
              id: `${input.workflowId.slice(0, 4)}-feature`,
              path: "/tmp/workflow-feature",
              branchName: "diga-agent-workflow/test/feature",
              baseRef: "HEAD",
              createdAt: Date.now(),
            };
          },
          async diff(worktree) {
            return {
              worktreeId: worktree.id,
              path: worktree.path,
              branchName: worktree.branchName,
              baseRef: worktree.baseRef,
              diff: "diff --git a/a.txt b/a.txt\n",
              stat: " a.txt | 1 +",
              createdAt: Date.now(),
            };
          },
          async merge() {
            throw new Error("patch does not apply cleanly");
          },
        },
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Apply isolated changes with conflicts.",
        rationale: "Verify merge failure artifact.",
        capabilities: ["spawn_agent", "read_files", "write_files", "worktree"],
        script: `
          const wt = await workflow.createWorktree({ name: "feature" });
          await workflow.mergeWorktree(wt);
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("patch does not apply cleanly");
    const failure = result.artifacts.find((artifact) =>
      artifact.name.startsWith("worktree-merge-failed:")
    );
    expect(failure?.value).toMatchObject({
      error: "patch does not apply cleanly",
      branchName: "diga-agent-workflow/test/feature",
      stat: " a.txt | 1 +",
      truncated: false,
    });
  });

  it("enforces maxAgents and maxConcurrency from the manifest", async () => {
    const tooManyAgents = await runWorkflowScript(
      {
        parentAgentId: "parent-5",
        runSubagents: async () => ({
          batchId: "batch",
          results: [
            {
              taskId: "task",
              agentId: "agent",
              status: "completed",
              answer: "ok",
              startedAt: Date.now(),
            },
          ],
        }),
      },
      {
        objective: "Limit agents.",
        rationale: "Verify maxAgents.",
        maxAgents: 1,
        script: `
          await workflow.spawnAgent({ title: "One", prompt: "one" });
          await workflow.spawnAgent({ title: "Two", prompt: "two" });
        `,
      }
    );
    expect(tooManyAgents.status).toBe("failed");
    expect(tooManyAgents.error).toContain("maxAgents=1");

  });

  it("treats maxConcurrency as a budget and queues extra parallel items", async () => {
    // Previously workflow.parallel threw when items.length > maxConcurrency.
    // Now it schedules all items with at most `maxConcurrency` running at once,
    // preserving input order in the results.
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-6",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Schedule more items than the concurrency budget.",
        rationale: "Verify maxConcurrency is a budget, not a hard cap.",
        maxConcurrency: 2,
        script: `
          let active = 0;
          let peak = 0;
          const slow = (value) => async () => {
            active += 1;
            peak = Math.max(peak, active);
            await workflow.sleep(5);
            active -= 1;
            return value;
          };
          // 5 items with a budget of 2 must not fail.
          const out = await workflow.parallel([
            slow(1), slow(2), slow(3), slow(4), slow(5),
          ]);
          workflow.artifact("order", out);
          workflow.artifact("peak", peak);
          return { out, peak };
        `,
      }
    );

    if (result.status !== "completed") {
      throw new Error(`workflow failed: ${result.error}`);
    }
    expect(result.status).toBe("completed");
    expect(result.returnValue).toEqual({ out: [1, 2, 3, 4, 5], peak: 2 });
  });

  it("requireSuccess halts the workflow when too many spawned agents fail", async () => {
    // Reproduces the "5/5 review failed but synthesis continues" trap: the gate
    // must throw so the workflow fails instead of feeding failure text downstream.
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-gate",
        runSubagents: async (input) => {
          const task = input.tasks[0];
          // Only the task titled "ok" completes; the rest fail.
          const completed = task?.title === "ok";
          return {
            batchId: "batch-gate",
            results: [
              {
                taskId: task?.id ?? "missing",
                agentId: "agent",
                status: completed ? "completed" : "failed",
                answer: completed ? "good" : "boom",
                startedAt: Date.now(),
                endedAt: Date.now(),
              },
            ],
          };
        },
      },
      {
        objective: "Gate on review success.",
        rationale: "Verify requireSuccess fails closed.",
        maxAgents: 8,
        script: `
          const reviews = await workflow.parallel([
            () => workflow.spawnAgent({ id: "a", title: "ok", prompt: "p" }),
            () => workflow.spawnAgent({ id: "b", title: "bad1", prompt: "p" }),
            () => workflow.spawnAgent({ id: "c", title: "bad2", prompt: "p" }),
          ]);
          // 1/3 succeeded but we need at least 2 -> must throw.
          workflow.requireSuccess(reviews, { minSuccess: 2, label: "module-reviews" });
          return "should-not-reach";
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("module-reviews");
    expect(result.error).toContain("requireSuccess gate failed");
    expect(result.error).toContain("1/3 succeeded");
  });

  it("requireSuccess passes through and returns only successful results", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-gate-pass",
        runSubagents: async (input) => {
          const task = input.tasks[0];
          const completed = task?.title !== "bad";
          return {
            batchId: "batch-gate-pass",
            results: [
              {
                taskId: task?.id ?? "missing",
                agentId: "agent",
                status: completed ? "completed" : "failed",
                answer: task?.title ?? "",
                startedAt: Date.now(),
                endedAt: Date.now(),
              },
            ],
          };
        },
      },
      {
        objective: "Gate passes.",
        rationale: "Verify requireSuccess returns survivors.",
        script: `
          const reviews = await workflow.parallel([
            () => workflow.spawnAgent({ id: "a", title: "good1", prompt: "p" }),
            () => workflow.spawnAgent({ id: "b", title: "bad", prompt: "p" }),
            () => workflow.spawnAgent({ id: "c", title: "good2", prompt: "p" }),
          ]);
          const ok = workflow.requireSuccess(reviews, { minSuccess: 2 });
          return { survivors: ok.map((r) => r.answer) };
        `,
      }
    );

    if (result.status !== "completed") {
      throw new Error(`workflow failed: ${result.error}`);
    }
    expect(result.returnValue).toEqual({ survivors: ["good1", "good2"] });
  });

  it("validateWorkflowScript flags forbidden APIs, length, emptiness, and truncation", () => {
    expect(validateWorkflowScript("")).toEqual([
      expect.objectContaining({ code: "empty_script" }),
    ]);

    const forbidden = validateWorkflowScript(
      "const x = require('fs'); fetch('http://x'); return x;"
    );
    expect(forbidden.map((i) => i.code)).toContain("forbidden_api");

    const tooLong = validateWorkflowScript("return 1;" + "//x".repeat(60_000), {
      maxChars: 50_000,
    });
    expect(tooLong.map((i) => i.code)).toContain("too_long");

    const truncated = validateWorkflowScript(
      "const r = await workflow.parallel([() => workflow.spawnAgent({ title: 't', prompt: 'p'"
    );
    expect(truncated.map((i) => i.code)).toContain("likely_truncated");

    // A normal harness that only spawns agents (no return) is valid.
    expect(
      validateWorkflowScript("await workflow.spawnAgent({ title: 't', prompt: 'p' });")
    ).toEqual([]);
  });

  it("fails fast with structured guidance when the script uses a forbidden API", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-validate",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Try a forbidden API.",
        rationale: "Verify validate-then-run.",
        script: "const fs = require('fs'); return fs;",
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("validation failed before execution");
    expect(result.error).toContain("require()");
    expect(
      result.logs.some(
        (log) => log.level === "error" && log.message.includes("validation [forbidden_api]")
      )
    ).toBe(true);
  });

  it("marks the run completed_with_warnings when end-state successCriteria are unmet", async () => {
    const events: WorkflowEvent[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-criteria-warn",
        onEvent: (event) => events.push(event),
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Produce a report.",
        rationale: "Verify end-state gate.",
        successCriteria: { requiredArtifacts: ["final-report"], minReportChars: 100 },
        script: `
          // Writes an empty report -> should trip the end-state gate.
          workflow.artifact("final-report", "");
          return "done";
        `,
      }
    );

    expect(result.status).toBe("completed_with_warnings");
    expect(result.warnings?.join(" ")).toContain("final-report");
    const endEvent = events.find((e) => e.type === "workflow_end");
    expect(endEvent && endEvent.type === "workflow_end" && endEvent.status).toBe(
      "completed_with_warnings"
    );
  });

  it("keeps status completed when successCriteria are met", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-criteria-ok",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Produce a report.",
        rationale: "Verify end-state gate passes.",
        successCriteria: { requiredArtifacts: ["final-report"], minReportChars: 5 },
        script: `
          workflow.artifact("final-report", "This is a sufficiently long report body.");
          return "done";
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(result.warnings).toBeUndefined();
  });

  it("auto-derives shell capability from script allowedTools and requests approval before start", async () => {
    const approvals: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-infer",
        approveCapability: async (request) => {
          approvals.push(request.capability);
          return { decision: "allow" };
        },
        runSubagents: async (input) => ({
          batchId: "batch-infer",
          results: [
            {
              taskId: input.tasks[0]?.id ?? "missing",
              agentId: "agent",
              status: "completed",
              answer: "ok",
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          ],
        }),
      },
      {
        objective: "Run a shell-using agent.",
        rationale: "Verify capability inference.",
        // Note: capabilities NOT declared -> safe default (spawn_agent, read_files).
        script: `
          await workflow.spawnAgent({
            title: "scan",
            prompt: "scan repo",
            allowedTools: ["read", "bash"],
          });
          return "done";
        `,
      }
    );

    // The bash tool must have been inferred -> shell approval requested -> workflow
    // completes instead of failing each child with "capability required: shell".
    expect(approvals).toContain("shell");
    expect(result.status).toBe("completed");
    expect(result.manifest.capabilities).toContain("shell");
    expect(
      result.logs.some((log) => log.message.includes("auto-declared capabilities"))
    ).toBe(true);
  });

  it("fails the workflow when an auto-derived capability is denied", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-infer-deny",
        approveCapability: async () => ({ decision: "deny", denyReason: "no shell" }),
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Run a shell-using agent.",
        rationale: "Verify denial blocks startup.",
        script: `
          await workflow.spawnAgent({
            title: "scan",
            prompt: "scan repo",
            allowedTools: ["bash"],
          });
          return "done";
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("no shell");
  });

  it("persists completed runs and exposes resume snapshots after reload", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-persist",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Persist workflow.",
        rationale: "Verify disk store.",
        script: `
          workflow.checkpoint("halfway", { step: 1 });
          workflow.artifact("note", "saved");
          return "done";
        `,
      }
    );

    __clearWorkflowMemoryForTest();
    const reloaded = getWorkflowRun(result.workflowId);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.checkpoints[0]?.name).toBe("halfway");
    expect(reloaded?.artifacts[0]?.name).toBe("note");
    const resume = workflowResumeSnapshot(reloaded!);
    expect(resume.canResume).toBe(true);
    expect(resume.lastCheckpoint?.name).toBe("halfway");
  });

  it("resumes a new harness from a prior workflow checkpoint and artifacts", async () => {
    const first = await runWorkflowScript(
      {
        parentAgentId: "parent-resume",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Collect source state.",
        rationale: "Create resumable state.",
        script: `
          workflow.checkpoint("collected", { nextStep: "synthesize" });
          workflow.artifact("notes", { items: ["a", "b"] });
          return "first";
        `,
      }
    );
    expect(first.status).toBe("completed");

    __clearWorkflowMemoryForTest();

    const resumed = await runWorkflowScript(
      {
        parentAgentId: "parent-resume",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Continue from source state.",
        rationale: "Verify checkpoint/artifact resume.",
        resumeFromWorkflowId: first.workflowId,
        script: `
          const notes = workflow.readArtifact("notes");
          workflow.checkpoint("synthesized", {
            from: workflow.resume.fromWorkflowId,
            previous: workflow.resume.lastCheckpoint.name,
            count: notes.items.length
          });
          return {
            from: workflow.resume.fromWorkflowId,
            artifactNames: workflow.resume.artifactNames,
            previousCheckpoint: workflow.resume.lastCheckpoint.value,
            notes
          };
        `,
      }
    );

    expect(resumed.status).toBe("completed");
    expect(resumed.resumedFromWorkflowId).toBe(first.workflowId);
    expect(resumed.returnValue).toEqual({
      from: first.workflowId,
      artifactNames: ["notes"],
      previousCheckpoint: { nextStep: "synthesize" },
      notes: { items: ["a", "b"] },
    });
    expect(resumed.checkpoints.map((checkpoint) => checkpoint.name)).toEqual([
      "collected",
      "synthesized",
    ]);
    expect(getWorkflowRun(resumed.workflowId)?.resumedFromWorkflowId).toBe(
      first.workflowId
    );
  });

  it("warns at resume when an upstream artifact is empty", async () => {
    const first = await runWorkflowScript(
      {
        parentAgentId: "parent-resume-empty",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Produce recon.",
        rationale: "Create resumable state with an empty artifact.",
        script: `
          workflow.checkpoint("recon-done", { ok: true });
          workflow.artifact("recon", "");
          return "first";
        `,
      }
    );

    __clearWorkflowMemoryForTest();

    const resumed = await runWorkflowScript(
      {
        parentAgentId: "parent-resume-empty",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Continue from recon.",
        rationale: "Verify empty-artifact resume warning.",
        resumeFromWorkflowId: first.workflowId,
        script: `return "second";`,
      }
    );

    expect(
      resumed.logs.some(
        (log) =>
          log.level === "warn" &&
          log.message.includes("resume warning") &&
          log.message.includes("recon")
      )
    ).toBe(true);
  });

  it("resumes from a selected prior checkpoint when requested", async () => {
    const first = await runWorkflowScript(
      {
        parentAgentId: "parent-resume-selected",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Create multiple checkpoints.",
        rationale: "Verify selected checkpoint resume.",
        script: `
          workflow.checkpoint("scan", { phase: "scan", next: "plan" });
          workflow.checkpoint("plan", { phase: "plan", next: "implement" });
          workflow.artifact("notes", { ok: true });
          return "first";
        `,
      }
    );

    const resumed = await runWorkflowScript(
      {
        parentAgentId: "parent-resume-selected",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Continue from selected checkpoint.",
        rationale: "Verify selected checkpoint state.",
        resumeFromWorkflowId: first.workflowId,
        resumeFromCheckpointName: "scan",
        script: `
          return {
            selected: workflow.resume.lastCheckpoint.name,
            value: workflow.resume.lastCheckpoint.value,
            checkpoints: workflow.resume.checkpointNames,
            notes: workflow.readArtifact("notes")
          };
        `,
      }
    );

    expect(resumed.status).toBe("completed");
    expect(resumed.returnValue).toEqual({
      selected: "scan",
      value: { phase: "scan", next: "plan" },
      checkpoints: ["scan", "plan"],
      notes: { ok: true },
    });
  });

  it("does not resume workflows owned by another parent agent", async () => {
    const first = await runWorkflowScript(
      {
        parentAgentId: "parent-a",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Create private state.",
        rationale: "Verify resume ownership.",
        script: `
          workflow.checkpoint("private", true);
          return "done";
        `,
      }
    );

    await expect(
      runWorkflowScript(
        {
          parentAgentId: "parent-b",
          runSubagents: async () => ({ batchId: "unused", results: [] }),
        },
        {
          objective: "Try cross-agent resume.",
          rationale: "Verify resume ownership.",
          resumeFromWorkflowId: first.workflowId,
          script: "return 'unreachable';",
        }
      )
    ).rejects.toThrow("does not belong to this agent");
  });

  it("lists and calls MCP tools under the mcp capability", async () => {
    const approvals: string[] = [];
    const mcpApprovals: string[] = [];
    const calledTools: string[] = [];
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-mcp",
        approveCapability: async (request) => {
          approvals.push(request.capability);
          return { decision: "allow" };
        },
        approveMcpTool: async (request) => {
          mcpApprovals.push(`${request.input.server}/${request.input.tool}`);
          return { decision: "allow" };
        },
        listMcpTools: async (serverId) => {
          const all = [
            { serverId: "fs", name: "read_file", description: "read a file" },
            { serverId: "gh", name: "create_issue" },
          ];
          return serverId ? all.filter((t) => t.serverId === serverId) : all;
        },
        callMcpTool: async (input) => {
          calledTools.push(`${input.server}/${input.tool}`);
          return {
            server: input.server,
            tool: input.tool,
            text: `called ${input.tool}`,
            isError: false,
          };
        },
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Use MCP tools from a workflow.",
        rationale: "Verify mcp capability runtime.",
        capabilities: ["spawn_agent", "read_files", "mcp"],
        script: `
          const tools = await workflow.listTools();
          workflow.artifact("tools", tools);
          const res = await workflow.callTool({
            server: "fs",
            tool: "read_file",
            input: { path: "/tmp/x" }
          });
          return res;
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(approvals).toEqual(["mcp"]);
    expect(mcpApprovals).toEqual(["fs/read_file"]);
    expect(calledTools).toEqual(["fs/read_file"]);
    expect(result.returnValue).toMatchObject({
      server: "fs",
      tool: "read_file",
      text: "called read_file",
      isError: false,
    });
    const toolsArtifact = result.artifacts.find((a) => a.name === "tools");
    expect(Array.isArray(toolsArtifact?.value)).toBe(true);
    expect((toolsArtifact?.value as unknown[]).length).toBe(2);
    expect(
      result.logs.some((log) => log.message.includes("[mcp] called: fs/read_file"))
    ).toBe(true);
  });

  it("searchTools filters by query and trims detail (progressive disclosure)", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-mcp-search",
        approveCapability: async () => ({ decision: "allow" }),
        listMcpTools: async () => [
          { serverId: "fs", name: "read_file", description: "read a file", inputSchema: { type: "object" } },
          { serverId: "fs", name: "write_file", description: "write a file", inputSchema: { type: "object" } },
          { serverId: "gh", name: "create_issue", description: "open a GitHub issue", inputSchema: { type: "object" } },
        ],
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Discover only the MCP tools needed.",
        rationale: "Verify searchTools.",
        capabilities: ["spawn_agent", "read_files", "mcp"],
        script: `
          const summary = await workflow.searchTools({ query: "file", detailLevel: "summary" });
          const namesOnly = await workflow.searchTools({ query: "issue", detailLevel: "name" });
          return {
            summaryCount: summary.length,
            summaryHasSchema: summary.some((t) => t.inputSchema !== undefined),
            summaryHasDescription: summary.every((t) => typeof t.description === "string"),
            issueName: namesOnly[0] && namesOnly[0].name,
            issueHasDescription: namesOnly[0] && namesOnly[0].description !== undefined,
          };
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(result.returnValue).toEqual({
      summaryCount: 2, // read_file + write_file match "file"
      summaryHasSchema: false, // summary detail drops inputSchema
      summaryHasDescription: true,
      issueName: "create_issue",
      issueHasDescription: false, // name detail drops description
    });
  });

  it("blocks workflow.callTool until mcp is declared", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-mcp-block",
        listMcpTools: async () => [],
        callMcpTool: async (input) => ({
          server: input.server,
          tool: input.tool,
          text: "unreachable",
          isError: false,
        }),
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Call MCP without capability.",
        rationale: "Verify mcp boundary.",
        script: `
          await workflow.callTool({ server: "fs", tool: "read_file" });
        `,
      }
    );

    expect(result.status).toBe("failed");
    // P0-4(a): workflow.callTool/listTools is inferred -> mcp requires approval.
    expect(result.error).toContain("mcp");
    expect(result.manifest.capabilities).toContain("mcp");
  });

  it("rejects a denied workflow.callTool approval", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-mcp-deny",
        approveCapability: async () => ({ decision: "allow" }),
        approveMcpTool: async () => ({
          decision: "deny",
          denyReason: "not allowed",
        }),
        listMcpTools: async () => [{ serverId: "fs", name: "read_file" }],
        callMcpTool: async (input) => ({
          server: input.server,
          tool: input.tool,
          text: "unreachable",
          isError: false,
        }),
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Call MCP but get denied.",
        rationale: "Verify mcp approval gate.",
        capabilities: ["spawn_agent", "read_files", "mcp"],
        script: `
          await workflow.callTool({ server: "fs", tool: "read_file" });
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("not allowed");
  });

  it("denies an MCP server outside the workflow scope", async () => {
    const result = await runWorkflowScript(
      {
        parentAgentId: "parent-mcp-scope",
        approveCapability: async () => ({ decision: "allow" }),
        approveMcpTool: async () => ({ decision: "allow" }),
        allowedMcpServers: ["fs"],
        listMcpTools: async () => [{ serverId: "fs", name: "read_file" }],
        callMcpTool: async (input) => ({
          server: input.server,
          tool: input.tool,
          text: "unreachable",
          isError: false,
        }),
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Call an out-of-scope MCP server.",
        rationale: "Verify mcp scope enforcement.",
        capabilities: ["spawn_agent", "read_files", "mcp"],
        script: `
          await workflow.callTool({ server: "gh", tool: "create_issue" });
        `,
      }
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain('MCP server "gh" is not in this workflow');
    expect(result.error).toContain("scope");
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkflowWorkerSpawnConfig, runWorkflowScript } from "./script-runtime";
import { __setWorkflowNetworkPolicyRootForTest } from "./network-policy";
import {
  __clearWorkflowMemoryForTest,
  __resetWorkflowStoreForTest,
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
          return { answers: results.map((result) => result.answer) };
        `,
      }
    );

    expect(result.status).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(result.checkpoints[0]?.name).toBe("reviews");
    expect(result.artifacts[0]?.name).toBe("summary");
    expect(result.returnValue).toEqual({ answers: ["answer-1", "answer-2"] });
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

  it("blocks unsafe child-agent tools until the capability is declared", async () => {
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
    expect(result.error).toContain("workflow capability required: shell");
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
    expect(result.error).toContain("workflow capability required: ask_user");
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
    expect(result.error).toContain("workflow capability required: network");
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
              branchName: "mini-pi-workflow/test/ui",
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
      branchName: "mini-pi-workflow/test/ui",
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
              branchName: "mini-pi-workflow/test/feature",
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
              branchName: "mini-pi-workflow/test/feature",
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
              branchName: "mini-pi-workflow/test/feature",
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
              branchName: "mini-pi-workflow/test/feature",
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
      branchName: "mini-pi-workflow/test/feature",
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

    const tooMuchParallel = await runWorkflowScript(
      {
        parentAgentId: "parent-6",
        runSubagents: async () => ({ batchId: "unused", results: [] }),
      },
      {
        objective: "Limit concurrency.",
        rationale: "Verify maxConcurrency.",
        maxConcurrency: 1,
        script: "await workflow.parallel([() => 1, () => 2]);",
      }
    );
    expect(tooMuchParallel.status).toBe("failed");
    expect(tooMuchParallel.error).toContain("at most 1 item");
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
});

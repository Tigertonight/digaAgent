import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  abortRunningSubagentBatches,
  resumeSubagentBatch,
  retrySubagentTask,
  runSubagentBatch,
  validateDelegateInput,
} from "./orchestrator";
import {
  __resetSubagentStoreForTest,
  __setSubagentStoreRootForTest,
  flushSubagentStore,
  getBatch,
  listBatches,
  listBatchesByParentSessionPath,
  putBatch,
  updateTask,
} from "./server-store";
import type { RunSubagentBatchDeps } from "./orchestrator";

describe("validateDelegateInput", () => {
  it("normalizes tasks and clamps concurrency", () => {
    const out = validateDelegateInput({
      reason: "questions are independent",
      concurrency: 99,
      tasks: [
        {
          id: "q1",
          title: "First question",
          prompt: "Answer Q1",
          role: "rag",
        },
        {
          id: "q2",
          title: "Second question",
          prompt: "Answer Q2",
        },
      ],
    });

    expect(out.reason).toBe("questions are independent");
    expect(out.concurrency).toBe(2);
    expect(out.planning).toMatchObject({
      status: "caution",
      taskCount: 2,
      requestedConcurrency: 99,
      concurrency: 2,
    });
    expect(out.planning.warnings[0]).toContain("clamped");
    expect(out.tasks).toMatchObject([
      { id: "q1", role: "rag", status: "pending" },
      { id: "q2", role: "general", status: "pending" },
    ]);
  });

  it("rejects missing reason and empty task prompts", () => {
    expect(() =>
      validateDelegateInput({
        reason: "",
        tasks: [{ id: "q1", title: "Q1", prompt: "Answer Q1" }],
      })
    ).toThrow(/reason/);

    expect(() =>
      validateDelegateInput({
        reason: "batch",
        tasks: [{ id: "q1", title: "Q1", prompt: "   " }],
      })
    ).toThrow(/non-empty prompts/);
  });

  it("caps large batches at thirty two tasks", () => {
    const tasks = Array.from({ length: 40 }, (_, i) => ({
      id: `q${i + 1}`,
      title: `Question ${i + 1}`,
      prompt: `Answer question ${i + 1}`,
    }));

    const out = validateDelegateInput({
      reason: "large independent batch",
      tasks,
    });

    expect(out.tasks).toHaveLength(32);
    expect(out.concurrency).toBe(4);
  });

  it("honors an explicit shorter task timeout (does not force the max)", () => {
    const out = validateDelegateInput({
      reason: "short task should keep its requested timeout",
      tasks: [
        {
          id: "audit",
          title: "Audit",
          prompt: "Audit lifecycle behavior",
          timeoutMs: 300000,
        },
      ],
    });

    // 修复死代码后：低于上限的 timeout 原样生效，不再被强制改成 30min。
    expect(out.tasks[0]?.timeoutMs).toBe(300000);
    expect(out.planning.warnings).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("timeout"),
      ]),
    );
  });

  it("clamps a task timeout that exceeds the limit and warns", () => {
    const out = validateDelegateInput({
      reason: "over-long timeout should be clamped to the limit",
      tasks: [
        {
          id: "audit",
          title: "Audit",
          prompt: "Audit lifecycle behavior",
          timeoutMs: 99 * 60 * 60 * 1000, // 99h, well over the 30min limit
        },
      ],
    });

    expect(out.tasks[0]?.timeoutMs).toBe(30 * 60 * 1000);
    expect(out.planning.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exceeded the 1800000 ms limit and were clamped"),
      ]),
    );
  });

  it("removes write-capable tools unless a write boundary is declared", () => {
    const out = validateDelegateInput({
      reason: "implementation review",
      tasks: [
        {
          id: "unsafe",
          title: "Unsafe edit",
          prompt: "Edit without a boundary",
          role: "implementation",
          allowedTools: ["read", "edit", "apply_patch"],
        },
        {
          id: "bounded",
          title: "Bounded edit",
          prompt: "Edit inside a boundary",
          role: "implementation",
          allowedTools: ["read", "edit"],
          writePaths: ["app/components/Safe.tsx"],
        },
      ],
    });

    expect(out.tasks[0]).toMatchObject({
      id: "unsafe",
      allowedTools: ["read"],
      writePaths: undefined,
    });
    expect(out.tasks[1]).toMatchObject({
      id: "bounded",
      allowedTools: ["read", "edit"],
      writePaths: ["app/components/Safe.tsx"],
    });
    expect(out.planning.status).toBe("caution");
    expect(out.planning.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("write tools were removed"),
        expect.stringContaining("constrained to declared writePaths"),
      ])
    );
  });

  it("S7：重复 task id 被自动改名，同时在 warnings 里告知", () => {
    const out = validateDelegateInput({
      reason: "two tasks accidentally share an id",
      tasks: [
        { id: "q1", title: "First", prompt: "answer first" },
        { id: "q1", title: "Second", prompt: "answer second" },
        { id: "q1", title: "Third", prompt: "answer third" },
      ],
    });
    const ids = out.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("q1");
    expect(ids.slice(1)).toEqual(
      expect.arrayContaining(["q1-2", "q1-3"])
    );
    expect(out.planning.warnings.join(" | ")).toMatch(/duplicate task id/i);
  });
});

describe("runSubagentBatch lifecycle", () => {
  it("disposes child agents after task completion", async () => {
    __resetSubagentStoreForTest();
    const listeners = new Set<(event: { type: string; message?: unknown }) => void>();
    const disposeChild = vi.fn();
    const session = {
      sessionFile: "/tmp/child.jsonl",
      subscribe: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      prompt: vi.fn(async () => {
        for (const listener of listeners) {
          listener({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "child answer" }],
            },
          });
          listener({ type: "agent_end" });
        }
      }),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
      getSessionStats: () => ({
        userMessages: 1,
        cost: 0,
        tokens: { input: 0, output: 0 },
      }),
    };

    const deps: RunSubagentBatchDeps = {
      parentAgentId: "parent-1",
      provider: "test-provider",
      modelId: "test-model",
      cwd: "/tmp",
      createChild: vi.fn(async () => ({
        id: "child-1",
        sessionId: "session-1",
        sessionFile: "/tmp/child.jsonl",
      })),
      getChild: () => ({ id: "child-1", session }),
      disposeChild,
      pushParentEvent: vi.fn(),
    };

    const out = await runSubagentBatch(deps, {
      reason: "single task",
      tasks: [
        {
          id: "q1",
          title: "Question 1",
          prompt: "Answer Q1",
          allowedTools: [],
        },
      ],
    });

    expect(out.results[0]).toMatchObject({
      taskId: "q1",
      agentId: "child-1",
      status: "completed",
      answer: "child answer",
    });
    const batch = getBatch(out.batchId);
    expect(batch?.auditEvents?.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "batch_created",
        "task_started",
        "task_completed",
        "batch_verified",
        "batch_synthesized",
        "batch_completed",
      ])
    );
    expect(disposeChild).toHaveBeenCalledOnce();
    expect(disposeChild).toHaveBeenCalledWith("child-1");
  });

  it("passes bounded write tools and writes the boundary into the child prompt", async () => {
    __resetSubagentStoreForTest();
    const listeners = new Set<(event: { type: string; message?: unknown }) => void>();
    const session = {
      sessionFile: "/tmp/child-write.jsonl",
      subscribe: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      prompt: vi.fn(async () => {
        for (const listener of listeners) {
          listener({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "bounded edit completed" }],
            },
          });
          listener({ type: "agent_end" });
        }
      }),
      abort: vi.fn(async () => undefined),
      dispose: vi.fn(),
      getSessionStats: () => ({
        userMessages: 1,
        cost: 0,
        tokens: { input: 0, output: 0 },
      }),
    };

    const deps: RunSubagentBatchDeps = {
      parentAgentId: "parent-write",
      provider: "test-provider",
      modelId: "test-model",
      cwd: "/tmp",
      createChild: vi.fn(async () => ({
        id: "child-write",
        sessionId: "session-write",
        sessionFile: "/tmp/child-write.jsonl",
      })),
      getChild: () => ({ id: "child-write", session }),
      disposeChild: vi.fn(),
      pushParentEvent: vi.fn(),
    };

    const result = await runSubagentBatch(deps, {
      reason: "bounded implementation",
      tasks: [
        {
          id: "impl",
          title: "Implementation",
          prompt: "Apply a targeted edit",
          role: "implementation",
          allowedTools: ["read", "edit"],
          writePaths: ["app/components/Safe.tsx"],
        },
      ],
    });

    expect(deps.createChild).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ["read", "edit"],
        writePaths: ["app/components/Safe.tsx"],
      })
    );
    expect(session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("写入边界：")
    );
    expect(session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("app/components/Safe.tsx")
    );
    expect(result.auditEvents?.some((event) => event.type === "write_boundary_applied")).toBe(
      true
    );
  });

  it("warns when duplicate-scope tasks produce conflicting answers", async () => {
    __resetSubagentStoreForTest();
    const sessions = new Map<
      string,
      {
        sessionFile: string;
        subscribe: ReturnType<typeof vi.fn>;
        prompt: ReturnType<typeof vi.fn>;
        abort: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
        getSessionStats: () => {
          userMessages: number;
          cost: number;
          tokens: { input: number; output: number };
        };
      }
    >();
    let childIndex = 0;
    const answers = ["可以下单。依据：合同审批已经通过。", "不可以下单。依据：合同还未生效。"];
    const deps: RunSubagentBatchDeps = {
      parentAgentId: "parent-conflict",
      provider: "test-provider",
      modelId: "test-model",
      cwd: "/tmp",
      createChild: vi.fn(async () => {
        childIndex += 1;
        const id = `child-conflict-${childIndex}`;
        const answer = answers[childIndex - 1];
        const listeners = new Set<(event: { type: string; message?: unknown }) => void>();
        const session = {
          sessionFile: `/tmp/${id}.jsonl`,
          subscribe: vi.fn((listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          }),
          prompt: vi.fn(async () => {
            for (const listener of listeners) {
              listener({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: answer }],
                },
              });
              listener({ type: "agent_end" });
            }
          }),
          abort: vi.fn(async () => undefined),
          dispose: vi.fn(),
          getSessionStats: () => ({
            userMessages: 1,
            cost: 0,
            tokens: { input: 0, output: 0 },
          }),
        };
        sessions.set(id, session);
        return {
          id,
          sessionId: `session-${id}`,
          sessionFile: session.sessionFile,
        };
      }),
      getChild: (agentId) => {
        const session = sessions.get(agentId);
        return session ? { id: agentId, session } : undefined;
      },
      disposeChild: vi.fn(),
      pushParentEvent: vi.fn(),
    };

    const { batchId } = await runSubagentBatch(deps, {
      reason: "conflict check",
      tasks: [
        {
          id: "q1",
          title: "合同审批通过后可以下单吗",
          prompt: "合同审批通过后可以下单吗",
        },
        {
          id: "q2",
          title: "合同审批通过后可以下单吗",
          prompt: "合同审批通过后可以下单吗",
        },
      ],
    });

    const batch = getBatch(batchId);
    expect(batch?.verification).toMatchObject({
      status: "warning",
    });
    expect(batch?.verification?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cross-task-conflicts",
          status: "warning",
        }),
      ])
    );
    expect(batch?.synthesis).toMatchObject({
      status: "partial",
      cautionTaskIds: expect.arrayContaining(["q1", "q2"]),
    });
  });
});

describe("subagent batch metadata persistence", () => {
  it("persists and hydrates batch/task metadata", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "diga-agent-subagents-"));
    try {
      __setSubagentStoreRootForTest(root);
      const listeners = new Set<(event: { type: string; message?: unknown }) => void>();
      const session = {
        sessionFile: "/tmp/child.jsonl",
        subscribe: vi.fn((listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        prompt: vi.fn(async () => {
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "persisted answer" }],
              },
            });
            listener({ type: "agent_end" });
          }
        }),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        getSessionStats: () => ({
          userMessages: 1,
          cost: 0,
          tokens: { input: 0, output: 0 },
        }),
      };
      const deps: RunSubagentBatchDeps = {
        parentAgentId: "parent-persist",
        parentSessionPath: "/tmp/parent.jsonl",
        provider: "test-provider",
        modelId: "test-model",
        cwd: "/tmp",
        createChild: vi.fn(async () => ({
          id: "child-persist",
          sessionId: "session-persist",
          sessionFile: "/tmp/child.jsonl",
        })),
        getChild: () => ({ id: "child-persist", session }),
        disposeChild: vi.fn(),
        pushParentEvent: vi.fn(),
      };

      const { batchId } = await runSubagentBatch(deps, {
        reason: "persist batch",
        tasks: [
          {
            id: "q1",
            title: "Question 1",
            prompt: "Answer Q1",
            allowedTools: [],
          },
        ],
      });
      updateTask(batchId, "q1", { answerPreview: "persisted preview" });
      // task 预览更新是 debounced 合并写，直接读盘断言前需 flush。
      flushSubagentStore();

      const fp = path.join(root, "subagents", "batches", `${batchId}.json`);
      const saved = JSON.parse(readFileSync(fp, "utf8"));
      expect(saved).toMatchObject({
        id: batchId,
        parentAgentId: "parent-persist",
        parentSessionPath: "/tmp/parent.jsonl",
        status: "completed",
        planning: {
          status: "caution",
          taskCount: 1,
          concurrency: 1,
        },
      });
      expect(saved.tasks[0]).toMatchObject({
        id: "q1",
        status: "completed",
        answer: "persisted answer",
        answerPreview: "persisted preview",
      });

      __resetSubagentStoreForTest();
      expect(getBatch(batchId)).toMatchObject({
        id: batchId,
        parentAgentId: "parent-persist",
      });
      expect(listBatches("parent-persist")).toHaveLength(1);
      expect(listBatchesByParentSessionPath("/tmp/parent.jsonl")).toHaveLength(1);
    } finally {
      __setSubagentStoreRootForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("retrySubagentTask", () => {
  it("reruns a single task, preserves the previous attempt, and updates metadata", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "diga-agent-subagents-retry-"));
    try {
      __setSubagentStoreRootForTest(root);
      let answer = "first answer";
      let childIndex = 0;
      const listeners = new Set<(event: { type: string; message?: unknown }) => void>();
      const session = {
        sessionFile: "/tmp/child.jsonl",
        subscribe: vi.fn((listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        prompt: vi.fn(async () => {
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: answer }],
              },
            });
            listener({ type: "agent_end" });
          }
        }),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        getSessionStats: () => ({
          userMessages: 1,
          cost: 0,
          tokens: { input: 0, output: 0 },
        }),
      };
      const deps: RunSubagentBatchDeps = {
        parentAgentId: "parent-retry",
        parentSessionPath: "/tmp/parent.jsonl",
        provider: "test-provider",
        modelId: "test-model",
        cwd: "/tmp",
        createChild: vi.fn(async () => {
          childIndex += 1;
          return {
            id: `child-${childIndex}`,
            sessionId: `session-${childIndex}`,
            sessionFile: `/tmp/child-${childIndex}.jsonl`,
          };
        }),
        getChild: () => ({ id: `child-${childIndex}`, session }),
        disposeChild: vi.fn(),
        pushParentEvent: vi.fn(),
      };

      const { batchId } = await runSubagentBatch(deps, {
        reason: "retry batch",
        tasks: [
          {
            id: "q1",
            title: "Question 1",
            prompt: "Answer Q1",
            allowedTools: [],
          },
        ],
      });

      answer = "second answer";
      const retry = await retrySubagentTask(deps, batchId, "q1");
      expect(retry).toMatchObject({
        taskId: "q1",
        agentId: "child-2",
        status: "completed",
        answer: "second answer",
      });

      const batch = getBatch(batchId);
      expect(batch?.tasks[0]).toMatchObject({
        status: "completed",
        agentId: "child-2",
        answer: "second answer",
        verification: {
          status: "warning",
        },
        attempts: [
          {
            attempt: 1,
            agentId: "child-1",
            status: "completed",
            answer: "first answer",
          },
        ],
      });
      const fp = path.join(root, "subagents", "batches", `${batchId}.json`);
      const saved = JSON.parse(readFileSync(fp, "utf8"));
      expect(saved.tasks[0].attempts[0].answer).toBe("first answer");
      expect(saved.tasks[0].answer).toBe("second answer");
      expect(saved.tasks[0].verification.status).toBe("warning");
      expect(saved.verification.status).toBe("warning");
      expect(saved.synthesis).toMatchObject({
        status: "partial",
        cautionTaskIds: ["q1"],
      });
      expect(saved.auditEvents.map((event: { type: string }) => event.type)).toEqual(
        expect.arrayContaining(["task_retried", "batch_verified", "batch_synthesized"])
      );
    } finally {
      __setSubagentStoreRootForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resumeSubagentBatch", () => {
  it("reruns unfinished tasks by session ownership and preserves interrupted attempts", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "diga-agent-subagents-resume-"));
    try {
      __setSubagentStoreRootForTest(root);
      putBatch({
        id: "batch-resume",
        parentAgentId: "old-parent",
        parentSessionPath: "/tmp/parent.jsonl",
        status: "running",
        reason: "resume unfinished",
        createdAt: 100,
        tasks: [
          {
            id: "q1",
            title: "Question 1",
            prompt: "Answer Q1",
            status: "completed",
            answer: "already done",
            startedAt: 110,
            endedAt: 120,
          },
          {
            id: "q2",
            title: "Question 2",
            prompt: "Answer Q2",
            status: "running",
            agentId: "old-child",
            answerPreview: "partial answer",
            startedAt: 130,
          },
        ],
      });

      const listeners = new Set<(event: { type: string; message?: unknown }) => void>();
      const session = {
        sessionFile: "/tmp/resumed-child.jsonl",
        subscribe: vi.fn((listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        prompt: vi.fn(async () => {
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "resumed answer" }],
              },
            });
            listener({ type: "agent_end" });
          }
        }),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(),
        getSessionStats: () => ({
          userMessages: 1,
          cost: 0,
          tokens: { input: 0, output: 0 },
        }),
      };
      const pushParentEvent = vi.fn();
      const deps: RunSubagentBatchDeps = {
        parentAgentId: "new-parent",
        parentSessionPath: "/tmp/parent.jsonl",
        provider: "test-provider",
        modelId: "test-model",
        cwd: "/tmp",
        createChild: vi.fn(async () => ({
          id: "new-child",
          sessionId: "new-session",
          sessionFile: "/tmp/resumed-child.jsonl",
        })),
        getChild: () => ({ id: "new-child", session }),
        disposeChild: vi.fn(),
        pushParentEvent,
      };

      const out = await resumeSubagentBatch(deps, "batch-resume");

      expect(out.results).toHaveLength(1);
      expect(out.results[0]).toMatchObject({
        taskId: "q2",
        agentId: "new-child",
        status: "completed",
        answer: "resumed answer",
      });
      const batch = getBatch("batch-resume");
      expect(batch).toMatchObject({
        parentAgentId: "new-parent",
        parentSessionPath: "/tmp/parent.jsonl",
        status: "completed",
      });
      expect(batch?.tasks[0]).toMatchObject({
        id: "q1",
        status: "completed",
        answer: "already done",
      });
      expect(batch?.tasks[1]).toMatchObject({
        id: "q2",
        status: "completed",
        agentId: "new-child",
        answer: "resumed answer",
        attempts: [
          {
            attempt: 1,
            agentId: "old-child",
            status: "aborted",
            answerPreview: "partial answer",
          },
        ],
      });
      expect(batch?.auditEvents?.map((event) => event.type)).toEqual(
        expect.arrayContaining(["batch_resumed", "task_started", "task_completed"])
      );
      expect(pushParentEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "subagent_batch_start" })
      );
    } finally {
      __setSubagentStoreRootForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("abortRunningSubagentBatches", () => {
  it("S8：abort 时同步把未终态 task 标 aborted 并 push task_end + batch_end", async () => {
    __resetSubagentStoreForTest();
    const listeners = new Set<
      (event: { type: string; message?: unknown }) => void
    >();
    // SDK 被 abort 后会推一条 agent_end，prompt() 随之返回。
    const session = {
      sessionFile: "/tmp/abort-child.jsonl",
      subscribe: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      prompt: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            // 被 abort 触发后才 resolve
            session._resolvePrompt = resolve;
          })
      ),
      abort: vi.fn(async () => {
        // 模拟 SDK 推 agent_end 让 taskDone resolve
        for (const l of listeners) l({ type: "agent_end" });
        session._resolvePrompt?.();
      }),
      dispose: vi.fn(),
      _resolvePrompt: undefined as undefined | (() => void),
    } as unknown as {
      sessionFile: string;
      subscribe: ReturnType<typeof vi.fn>;
      prompt: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      _resolvePrompt?: () => void;
    };
    const pushParentEvent = vi.fn();
    const deps: RunSubagentBatchDeps = {
      parentAgentId: "abort-parent",
      provider: "test",
      modelId: "test",
      cwd: "/tmp",
      createChild: vi.fn(async () => ({
        id: "abort-child",
        sessionId: "session-abort",
        sessionFile: "/tmp/abort-child.jsonl",
      })),
      getChild: () => ({ id: "abort-child", session }),
      disposeChild: vi.fn(),
      pushParentEvent,
    };

    const runPromise = runSubagentBatch(deps, {
      reason: "long running task",
      tasks: [
        {
          id: "long",
          title: "Long task",
          prompt: "hang here",
          allowedTools: [],
        },
      ],
    });

    // 等 task 进入 running
    await new Promise((r) => setTimeout(r, 50));

    // 触发 abort 并验证同步 push 行为
    await abortRunningSubagentBatches(
      "abort-parent",
      () => ({ id: "abort-child", session }),
      pushParentEvent
    );

    // 等 runPromise 收尾（worker 内部的 finally / catch 会再 push 一次）
    await runPromise;

    const taskEnds = pushParentEvent.mock.calls
      .map((c) => c[0])
      .filter(
        (e) => e.type === "subagent_task_end" && e.taskId === "long"
      );
    const batchEnds = pushParentEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === "subagent_batch_end");
    expect(taskEnds.length).toBeGreaterThanOrEqual(1);
    expect(taskEnds[0].status).toBe("aborted");
    // A2-1：batch_end 仅推一次（abort 路径设上 endedPushed，worker fn finally 跳过）。
    expect(batchEnds).toHaveLength(1);
    expect(batchEnds[0].status).toBe("aborted");

    const batch = getBatch(taskEnds[0].batchId);
    expect(batch?.status).toBe("aborted");
    expect(batch?.tasks[0].status).toBe("aborted");
    expect(batch?.tasks[0].verification?.status).toBeDefined();
  });
});

describe("subagent store hydrate downgrade (C9-1)", () => {
  it("重启后 status===running 的 batch 降级为 detached，未终态 task 转 aborted", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "diga-agent-hydrate-"));
    try {
      const dir = path.join(root, "subagents", "batches");
      mkdirSync(dir, { recursive: true });
      const onDisk = {
        id: "b-running",
        parentAgentId: "p-1",
        parentSessionPath: "/tmp/p.jsonl",
        status: "running",
        reason: "stale running batch",
        tasks: [
          {
            id: "t-running",
            title: "T running",
            prompt: "still running",
            status: "running",
          },
          {
            id: "t-pending",
            title: "T pending",
            prompt: "never started",
            status: "pending",
          },
          {
            id: "t-done",
            title: "T done",
            prompt: "already completed",
            status: "completed",
            answer: "ok",
          },
        ],
        createdAt: 1,
      };
      writeFileSync(
        path.join(dir, `${onDisk.id}.json`),
        JSON.stringify(onDisk),
        "utf8"
      );
      __setSubagentStoreRootForTest(root);
      // 触发 hydrate
      const batch = getBatch(onDisk.id);
      expect(batch?.status).toBe("detached");
      expect(batch?.endedAt).toBeGreaterThan(0);
      const byId = new Map(batch!.tasks.map((t) => [t.id, t]));
      expect(byId.get("t-running")?.status).toBe("aborted");
      expect(byId.get("t-pending")?.status).toBe("aborted");
      expect(byId.get("t-done")?.status).toBe("completed");
      expect(byId.get("t-running")?.error ?? "").toMatch(/restart/i);
    } finally {
      __setSubagentStoreRootForTest(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

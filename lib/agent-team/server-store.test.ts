import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInitialAgentTeamRun } from "./initial-run";
import {
  claimStoredAgentTeamTask,
  completeStoredAgentTeamTask,
  failStoredAgentTeamTask,
  followUpStoredAgentTeamMember,
  getAgentTeamRun,
  listAgentTeamRuns,
  listAgentTeamRunsByParentSessionPath,
  planStoredAgentTeamDispatch,
  planStoredAgentTeamDispatches,
  promoteStoredAgentTeamMember,
  putAgentTeamRun,
  recordStoredAgentTeamToolWrite,
  replaceStoredAgentTeamMember,
  retryStoredAgentTeamTask,
  runAgentTeamStartupRecovery,
  sendStoredAgentTeamMessage,
  setAgentTeamStoreRootForTests,
  submitStoredAgentTeamPlan,
  approveStoredAgentTeamPlan,
  updateStoredAgentTeamHook,
  validateStoredAgentTeamToolPolicy,
} from "./server-store";

describe("agent team server store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "agent-team-store-"));
    setAgentTeamStoreRootForTests(root);
  });

  afterEach(async () => {
    setAgentTeamStoreRootForTests(null);
    await rm(root, { recursive: true, force: true });
  });

  it("persists and rehydrates Team runs by parent agent and session path", () => {
    const run = {
      ...createInitialAgentTeamRun("persist team"),
      parentAgentId: "agent-1",
      parentSessionPath: "/tmp/session.jsonl",
    };

    putAgentTeamRun(run);
    setAgentTeamStoreRootForTests(root);

    expect(getAgentTeamRun(run.id)?.objective).toBe("persist team");
    expect(listAgentTeamRuns("agent-1")).toHaveLength(1);
    expect(listAgentTeamRunsByParentSessionPath("/tmp/session.jsonl")).toHaveLength(1);
  });

  it("normalizes completed Team runs so no task remains active on hydrate", () => {
    const base = createInitialAgentTeamRun("completed restore");
    const run = {
      ...base,
      status: "completed" as const,
      leadState: "finalized" as const,
      parentAgentId: "agent-1",
      board: {
        ...base.board,
        tasks: [
          ...base.board.tasks.map((task) => ({ ...task, status: "completed" as const })),
          {
            id: "optional-review",
            title: "Optional review",
            description: "Optional task that should not remain active after hydrate.",
            status: "claimed" as const,
            ownerAgentId: base.members[1]?.id,
            priority: "normal" as const,
            required: false,
            findingIds: [],
            dependsOnTaskIds: ["synthesis"],
            expectedOutput: "review" as const,
            evidenceRequired: false,
          },
        ],
      },
      members: base.members.map((member, index) =>
        index === 1 ? { ...member, status: "working" as const, currentTaskId: "optional-review" } : member
      ),
    };

    putAgentTeamRun(run);
    setAgentTeamStoreRootForTests(root);
    const restored = getAgentTeamRun(run.id);

    expect(
      restored?.board.tasks.every(
        (task) => task.status === "completed" || task.status === "skipped"
      )
    ).toBe(true);
    expect(restored?.board.tasks.find((task) => task.id === "optional-review")?.status).toBe("skipped");
    expect(restored?.members.find((member) => member.currentTaskId === "optional-review")).toBeUndefined();
  });

  it("does not let stale non-aborted snapshots overwrite a stopped Team run", () => {
    const base = createInitialAgentTeamRun("stopped team");
    const stopped = {
      ...base,
      status: "aborted" as const,
      endedAt: Date.now(),
    };
    putAgentTeamRun(stopped);

    const staleCompleted = {
      ...base,
      status: "completed" as const,
      leadState: "finalized" as const,
      endedAt: Date.now() + 1,
      board: {
        ...base.board,
        tasks: base.board.tasks.map((task) => ({
          ...task,
          status: "completed" as const,
        })),
      },
    };

    const stored = putAgentTeamRun(staleCompleted);

    expect(stored.status).toBe("aborted");
    expect(getAgentTeamRun(base.id)?.status).toBe("aborted");
  });

  it("pauses an interrupted running Team run on hydrate", () => {
    const run = {
      ...createInitialAgentTeamRun("restart team"),
      parentAgentId: "agent-1",
      status: "running" as const,
    };

    putAgentTeamRun(run);
    setAgentTeamStoreRootForTests(root);

    const restored = getAgentTeamRun(run.id);
    expect(restored?.status).toBe("paused");
    expect(restored?.board.events.at(-1)?.message).toContain("process restart");
  });

  it("persists task claims, completions, and mailbox messages", () => {
    const run = {
      ...createInitialAgentTeamRun("task runtime"),
      parentAgentId: "agent-1",
    };
    putAgentTeamRun(run);

    const claimed = claimStoredAgentTeamTask(run.id, "frame", run.leadAgentId);
    expect(claimed.error).toBeUndefined();
    expect(claimed.run?.board.tasks.find((task) => task.id === "frame")?.status).toBe("claimed");

    const completed = completeStoredAgentTeamTask(run.id, "frame", run.leadAgentId, {
      findingClaim: "Frame complete.",
      evidenceRefs: ["store:test"],
      confidence: "high",
    });
    expect(completed.error).toBeUndefined();
    expect(completed.run?.board.findings.some((finding) => finding.claim === "Frame complete.")).toBe(true);

    const messaged = sendStoredAgentTeamMessage(run.id, {
      fromAgentId: run.leadAgentId,
      body: "Broadcast from store.",
    });
    expect(messaged.error).toBeUndefined();
    expect(getAgentTeamRun(run.id)?.board.messages.at(-1)?.body).toBe("Broadcast from store.");
  });

  it("persists direct teammate follow-ups", () => {
    const run = {
      ...createInitialAgentTeamRun("follow-up store"),
      parentAgentId: "agent-1",
    };
    const memberId = run.members[1].id;
    putAgentTeamRun(run);

    const followed = followUpStoredAgentTeamMember(run.id, {
      fromAgentId: run.leadAgentId,
      toAgentId: memberId,
      body: "Please expand your evidence.",
    });

    expect(followed.error).toBeUndefined();
    expect(getAgentTeamRun(run.id)?.board.messages.at(-1)?.toAgentId).toBe(memberId);
    expect(getAgentTeamRun(run.id)?.members.find((member) => member.id === memberId)?.latestOutput).toContain("follow-up");
  });

  it("persists file locks across claim and completion", () => {
    const run = {
      ...createInitialAgentTeamRun("lock store"),
      parentAgentId: "agent-1",
    };
    putAgentTeamRun(run);

    const claimed = claimStoredAgentTeamTask(run.id, "frame", run.leadAgentId, {
      writePaths: ["src/app.ts"],
    });
    expect(claimed.error).toBeUndefined();
    expect(getAgentTeamRun(run.id)?.board.fileLocks.some((lock) => lock.status === "active")).toBe(true);

    const completed = completeStoredAgentTeamTask(run.id, "frame", run.leadAgentId, {
      findingClaim: "Frame complete.",
    });
    expect(completed.error).toBeUndefined();
    expect(getAgentTeamRun(run.id)?.board.fileLocks.every((lock) => lock.status === "released")).toBe(true);
  });

  it("records write tool targets by teammate agent id", () => {
    const base = createInitialAgentTeamRun("tool lock store", {
      allowWrite: true,
      requirePlanApproval: false,
      writePolicy: "write_allowed",
    });
    const memberId = base.members[1].id;
    const run = {
      ...base,
      parentAgentId: "agent-1",
      members: base.members.map((member) =>
        member.id === memberId ? { ...member, agentId: "child-agent" } : member
      ),
    };
    putAgentTeamRun(run);
    const claimed = claimStoredAgentTeamTask(run.id, "frame", memberId);
    expect(claimed.error).toBeUndefined();

    const recorded = recordStoredAgentTeamToolWrite("child-agent", ["src/app.ts"]);

    expect(recorded.error).toBeUndefined();
    expect(recorded.teamId).toBe(run.id);
    expect(getAgentTeamRun(run.id)?.board.fileLocks.some((lock) => lock.path === "src/app.ts")).toBe(true);
  });

  it("enforces Team write and network policy for teammate tools", () => {
    const base = createInitialAgentTeamRun("policy store", {
      allowWrite: false,
      allowNetwork: false,
      writePolicy: "read_only",
      networkPolicy: "disabled",
    });
    const memberId = base.members[1].id;
    const run = {
      ...base,
      parentAgentId: "agent-1",
      members: base.members.map((member) =>
        member.id === memberId ? { ...member, agentId: "child-agent" } : member
      ),
    };
    putAgentTeamRun(run);

    const write = validateStoredAgentTeamToolPolicy("child-agent", {
      toolName: "write_file",
      isWrite: true,
    });
    const network = validateStoredAgentTeamToolPolicy("child-agent", {
      toolName: "web_search",
      isNetwork: true,
    });

    expect(write.error).toContain("write policy");
    expect(network.error).toContain("network policy");
  });

  it("requires approved plans before write tools when plan approval is enabled", () => {
    const base = createInitialAgentTeamRun("plan approval store", {
      allowWrite: true,
      requirePlanApproval: true,
      writePolicy: "plan_approval",
    });
    const memberId = base.members[1].id;
    const run = {
      ...base,
      parentAgentId: "agent-1",
      members: base.members.map((member) =>
        member.id === memberId ? { ...member, agentId: "child-agent" } : member
      ),
    };
    putAgentTeamRun(run);
    expect(claimStoredAgentTeamTask(run.id, "frame", memberId).error).toBeUndefined();

    const blocked = recordStoredAgentTeamToolWrite("child-agent", ["src/app.ts"]);
    expect(blocked.error).toContain("approved plan");

    const plan = submitStoredAgentTeamPlan(run.id, {
      taskId: "frame",
      authorAgentId: memberId,
      body: "Edit src/app.ts after lead approval.",
    });
    expect(plan.error).toBeUndefined();
    const planId = plan.run?.board.plans.at(-1)?.id ?? "";
    expect(approveStoredAgentTeamPlan(run.id, planId, run.leadAgentId).error).toBeUndefined();
    expect(claimStoredAgentTeamTask(run.id, "frame", memberId).error).toBeUndefined();

    const allowed = recordStoredAgentTeamToolWrite("child-agent", ["src/app.ts"]);
    expect(allowed.error).toBeUndefined();
  });

  it("plans the next dispatch from persisted task and teammate state", () => {
    const base = createInitialAgentTeamRun("dispatch store");
    const run = {
      ...base,
      parentAgentId: "agent-1",
      members: base.members.map((member, index) =>
        index === 1 ? { ...member, agentId: "child-agent" } : member
      ),
    };
    putAgentTeamRun({
      ...run,
      board: {
        ...run.board,
        tasks: run.board.tasks.map((task) =>
          task.id === "frame" ? { ...task, status: "completed" as const } : task
        ),
      },
    });

    const planned = planStoredAgentTeamDispatch(run.id);

    expect(planned.error).toBeUndefined();
    expect(planned.plan?.task.id).toBe("evidence");
    expect(planned.plan?.memberId).toBe(run.members[1].id);
  });

  it("plans multiple persisted dispatches without duplicate members", () => {
    const base = createInitialAgentTeamRun("batch store");
    const run = {
      ...base,
      parentAgentId: "agent-1",
      members: base.members.map((member, index) =>
        index > 0 ? { ...member, agentId: `child-${index}` } : member
      ),
      board: {
        ...base.board,
        tasks: base.board.tasks.map((task, index) => ({
          ...task,
          id: `task-${index}`,
          dependsOnTaskIds: [],
          status: "pending" as const,
        })),
      },
    };
    putAgentTeamRun(run);

    const planned = planStoredAgentTeamDispatches(run.id, 3);

    expect(planned.error).toBeUndefined();
    expect(planned.plans).toHaveLength(3);
    expect(new Set(planned.plans?.map((plan) => plan.memberId)).size).toBe(3);
  });

  it("persists promoted teammate visibility", () => {
    const base = createInitialAgentTeamRun("promote store");
    const memberId = base.members[1].id;
    const run = {
      ...base,
      parentAgentId: "agent-1",
      members: base.members.map((member) =>
        member.id === memberId
          ? { ...member, agentId: "child-agent", sessionFile: "/tmp/child.jsonl" }
          : member
      ),
    };
    putAgentTeamRun(run);

    const promoted = promoteStoredAgentTeamMember(run.id, memberId);

    expect(promoted.error).toBeUndefined();
    expect(getAgentTeamRun(run.id)?.members.find((member) => member.id === memberId)?.sidebarVisible).toBe(true);
  });

  it("persists hook configuration changes", () => {
    const run = {
      ...createInitialAgentTeamRun("hook store"),
      parentAgentId: "agent-1",
    };
    putAgentTeamRun(run);

    const updated = updateStoredAgentTeamHook(run.id, "hook-task-completed-evidence", {
      enabled: false,
    });

    expect(updated.error).toBeUndefined();
    expect(getAgentTeamRun(run.id)?.board.hooks.find((hook) => hook.id === "hook-task-completed-evidence")?.enabled).toBe(false);
  });

  it("persists task failure, retry, and teammate replacement", () => {
    const base = createInitialAgentTeamRun("failure store");
    const memberId = base.members[1].id;
    const run = {
      ...base,
      parentAgentId: "agent-1",
      members: base.members.map((member) =>
        member.id === memberId ? { ...member, agentId: "old-agent" } : member
      ),
    };
    putAgentTeamRun(run);

    const failed = failStoredAgentTeamTask(run.id, "frame", memberId, "bad run");
    expect(failed.error).toBeUndefined();
    expect(getAgentTeamRun(run.id)?.board.tasks.find((task) => task.id === "frame")?.status).toBe("blocked");

    const retried = retryStoredAgentTeamTask(run.id, "frame");
    expect(retried.error).toBeUndefined();
    expect(getAgentTeamRun(run.id)?.board.tasks.find((task) => task.id === "frame")?.status).toBe("pending");

    const replaced = replaceStoredAgentTeamMember(run.id, memberId, {
      agentId: "new-agent",
      sessionFile: "/tmp/new.jsonl",
    });
    expect(replaced.error).toBeUndefined();
    expect(getAgentTeamRun(run.id)?.members.find((member) => member.id === memberId)?.agentId).toBe("new-agent");
  });

  it("startup recovery recovers stale running tasks across non-terminal runs", () => {
    const base = createInitialAgentTeamRun("startup recovery team");
    const memberId = base.members[1].id;
    const run = {
      ...base,
      parentAgentId: "agent-1",
      status: "running" as const,
      members: base.members.map((member) =>
        member.id === memberId ? { ...member, agentId: "child-agent" } : member
      ),
    };
    putAgentTeamRun(run);
    // claim 后任务进入进行中（claimed），是 stale recovery 的目标状态之一。
    expect(claimStoredAgentTeamTask(run.id, "frame", memberId).error).toBeUndefined();
    expect(
      getAgentTeamRun(run.id)?.board.tasks.find((task) => task.id === "frame")?.status
    ).toBe("claimed");

    // now 推后一秒，确保 claimedAt 落在 staleMs 窗口之外。
    const result = runAgentTeamStartupRecovery({ now: Date.now() + 60_000, staleMs: 1 });
    expect(result.scannedRuns).toBeGreaterThanOrEqual(1);
    expect(result.recoveredTaskIds).toContain("frame");
    // 恢复后该 task 交回队列（pending/blocked），不再停留在 claimed/running。
    const recoveredStatus = getAgentTeamRun(run.id)?.board.tasks.find(
      (task) => task.id === "frame"
    )?.status;
    expect(["pending", "blocked"]).toContain(recoveredStatus);
  });

  it("startup recovery ignores terminal runs", () => {
    const base = createInitialAgentTeamRun("completed team");
    putAgentTeamRun({
      ...base,
      parentAgentId: "agent-1",
      status: "completed" as const,
    });
    const result = runAgentTeamStartupRecovery({ staleMs: 1 });
    expect(result.recoveredTaskIds).toHaveLength(0);
  });
});

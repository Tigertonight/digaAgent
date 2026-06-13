import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubagentDefinition } from "./definition";
import type { SubagentResult, SubagentTaskRuntime } from "./types";
import {
  __resetSubagentMemoryForTest,
  __setSubagentMemoryRootForTest,
  getSubagentMemory,
} from "./memory";
import {
  extractMemoryFromResult,
  isDangerousShellCommand,
  runAfterToolUseHook,
  runBeforeToolUseHook,
  runSubagentStartHook,
  runSubagentStopHook,
} from "./hooks";

function def(over: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    id: "reviewer",
    title: "Reviewer",
    description: "d",
    prompt: "p",
    source: "project",
    versionHash: "h",
    ...over,
  };
}

function runtimeTask(): SubagentTaskRuntime {
  return { id: "t1", title: "Review payments", prompt: "p", status: "completed" };
}

function result(answer: string): SubagentResult {
  return {
    taskId: "t1",
    agentId: "a1",
    status: "completed",
    answer,
    startedAt: 0,
    endedAt: 1,
  };
}

describe("isDangerousShellCommand", () => {
  it.each([
    ["rm -rf /", true],
    ["git reset --hard", true],
    ["dd if=/dev/zero", true],
    ["ls -la", false],
    [undefined, false],
  ])("classifies %p as dangerous=%s", (cmd, expected) => {
    expect(isDangerousShellCommand(cmd as string | undefined)).toBe(expected);
  });
});

describe("runBeforeToolUseHook", () => {
  it("denies dangerous shell when hook enabled", () => {
    const res = runBeforeToolUseHook(["deny-dangerous-shell"], {
      toolName: "bash",
      command: "rm -rf /tmp/x",
    });
    expect(res.decision).toBe("deny");
    expect(res.hook).toBe("deny-dangerous-shell");
  });

  it("allows safe shell", () => {
    expect(
      runBeforeToolUseHook(["deny-dangerous-shell"], {
        toolName: "bash",
        command: "ls",
      }).decision
    ).toBe("allow");
  });

  it("no-op when hook not enabled", () => {
    expect(
      runBeforeToolUseHook([], { toolName: "bash", command: "rm -rf /" })
        .decision
    ).toBe("allow");
    expect(
      runBeforeToolUseHook(undefined, { toolName: "bash", command: "rm -rf /" })
        .decision
    ).toBe("allow");
  });
});

describe("extractMemoryFromResult", () => {
  it("extracts risk lines from the answer", () => {
    const { recurringRisks } = extractMemoryFromResult(
      runtimeTask(),
      result("Found a security risk in auth.\nAlso missing test for refund.")
    );
    expect(recurringRisks.length).toBeGreaterThanOrEqual(2);
    expect(recurringRisks.join(" ")).toMatch(/security/i);
  });

  it("extracts verification warnings", () => {
    const { recurringRisks } = extractMemoryFromResult(
      runtimeTask(),
      result("ok"),
      {
        status: "warning",
        checks: [
          { id: "c", status: "warning", message: "answer too short" },
        ],
        verifiedAt: 0,
      }
    );
    expect(recurringRisks.join(" ")).toMatch(/too short/);
  });

  it("returns empty when nothing risky", () => {
    expect(
      extractMemoryFromResult(runtimeTask(), result("all good")).recurringRisks
    ).toEqual([]);
  });
});

describe("runSubagentStartHook", () => {
  it("no-op when no hooks declared", () => {
    expect(
      runSubagentStartHook(def(), {
        taskId: "t1",
        agentId: "a1",
        role: "code-review",
      }).fired
    ).toBe(false);
  });

  it("fires log-start hook", () => {
    const res = runSubagentStartHook(
      def({ hooks: { subagentStart: ["log-start"] } }),
      { taskId: "t1", agentId: "a1", role: "code-review" }
    );
    expect(res.fired).toBe(true);
    expect(res.notes.join(" ")).toMatch(/started/);
  });

  it("no-op when definition is null", () => {
    expect(
      runSubagentStartHook(null, { taskId: "t1", agentId: "a1", role: "general" })
        .fired
    ).toBe(false);
  });
});

describe("runAfterToolUseHook (placeholder)", () => {
  it("is a no-op in M1", () => {
    expect(
      runAfterToolUseHook(["record-evidence"], { toolName: "read", ok: true })
        .recorded
    ).toBe(false);
  });
});

describe("runSubagentStopHook", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "diga-agent-hooks-"));
    __setSubagentMemoryRootForTest(root);
  });

  afterEach(() => {
    __setSubagentMemoryRootForTest(null);
    rmSync(root, { recursive: true, force: true });
  });

  it("no-op when hook not declared", () => {
    const res = runSubagentStopHook(
      def(),
      runtimeTask(),
      result("security risk here")
    );
    expect(res.updatedMemory).toBe(false);
  });

  it("updates memory when hook declared and risks found", () => {
    const res = runSubagentStopHook(
      def({ hooks: { subagentStop: ["update-memory-from-result"] } }),
      runtimeTask(),
      result("security risk in payment module")
    );
    expect(res.updatedMemory).toBe(true);
    expect(res.addedRisks.length).toBeGreaterThan(0);
    __resetSubagentMemoryForTest();
    const mem = getSubagentMemory("reviewer", "project");
    expect(mem?.recurringRisks.join(" ")).toMatch(/payment/i);
  });

  it("no-op when no risks even if hook declared", () => {
    const res = runSubagentStopHook(
      def({ hooks: { subagentStop: ["update-memory-from-result"] } }),
      runtimeTask(),
      result("looks great, nothing to flag")
    );
    expect(res.updatedMemory).toBe(false);
  });
});

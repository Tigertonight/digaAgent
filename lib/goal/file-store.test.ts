import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetGoalStoreForTest,
  __setGoalStoreRootForTest,
  addGoalEvidence,
  addGoalTurn,
  buildGoalRecap,
  clearGoal,
  finishGoalTurn,
  getGoal,
  listGoalEvidence,
  listGoalTurns,
  noteGoalContinuation,
  patchGoal,
  setGoal,
  setGoalStatus,
  startGoalTurn,
  type GoalStoreEnvelope,
} from "./file-store";

describe("goal file store", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "mini-pi-goals-"));
    __setGoalStoreRootForTest(root);
  });

  afterEach(() => {
    __setGoalStoreRootForTest(null);
    rmSync(root, { recursive: true, force: true });
  });

  function goalFile(agentId: string): string {
    return path.join(root, "goals", `${agentId}.json`);
  }

  function readEnvelope(agentId: string): GoalStoreEnvelope {
    return JSON.parse(readFileSync(goalFile(agentId), "utf8"));
  }

  // 1. Basic persistence round-trip.
  it("persists a goal to disk in envelope shape", () => {
    const goal = setGoal("agent-1", " Finish the migration ");

    expect(goal.objective).toBe("Finish the migration");
    expect(existsSync(goalFile("agent-1"))).toBe(true);

    const envelope = readEnvelope("agent-1");
    expect(envelope.version).toBe(1);
    expect(envelope.goal.objective).toBe("Finish the migration");
    expect(envelope.goal.status).toBe("active");
  });

  it("stores multiple agents in separate files", () => {
    setGoal("agent-1", "Goal A");
    setGoal("agent-2", "Goal B");

    expect(existsSync(goalFile("agent-1"))).toBe(true);
    expect(existsSync(goalFile("agent-2"))).toBe(true);
    expect(readEnvelope("agent-1").goal.objective).toBe("Goal A");
    expect(readEnvelope("agent-2").goal.objective).toBe("Goal B");
  });

  // 2. Restart recovery: clear memory only, re-hydrate from disk.
  it("recovers a goal from disk after an in-memory reset", () => {
    setGoal("agent-1", "Survive restart");
    noteGoalContinuation("agent-1");

    __resetGoalStoreForTest();

    const recovered = getGoal("agent-1");
    expect(recovered).not.toBeNull();
    expect(recovered?.objective).toBe("Survive restart");
    expect(recovered?.turns).toBe(1);
  });

  // 3. Updates are reflected on disk.
  it("persists patch / status / continuation updates", () => {
    setGoal("agent-1", "Ship goal mode");

    patchGoal("agent-1", { tokenBudget: 1000 });
    expect(readEnvelope("agent-1").goal.tokenBudget).toBe(1000);

    setGoalStatus("agent-1", "complete");
    const completed = readEnvelope("agent-1").goal;
    expect(completed.status).toBe("complete");
    expect(completed.completedAt).toBeTypeOf("number");

    setGoal("agent-2", "Continue");
    noteGoalContinuation("agent-2");
    expect(readEnvelope("agent-2").goal.turns).toBe(1);
  });

  // 4. Deletion removes both memory and the disk file.
  it("clears a goal and deletes its file", () => {
    setGoal("agent-1", "Temporary goal");
    expect(existsSync(goalFile("agent-1"))).toBe(true);

    clearGoal("agent-1");
    expect(getGoal("agent-1")).toBeNull();
    expect(existsSync(goalFile("agent-1"))).toBe(false);
  });

  // 5. Corrupt files are skipped without blocking other goals.
  it("ignores a corrupt file during hydration", () => {
    setGoal("agent-good", "Valid goal");
    __resetGoalStoreForTest();

    // Write a corrupt file directly into the goals dir.
    mkdirSync(path.join(root, "goals"), { recursive: true });
    writeFileSync(goalFile("agent-bad"), "{ not valid json", "utf8");

    expect(getGoal("agent-bad")).toBeNull();
    expect(getGoal("agent-good")?.objective).toBe("Valid goal");
  });

  it("skips an envelope missing required goal fields", () => {
    mkdirSync(path.join(root, "goals"), { recursive: true });
    writeFileSync(
      goalFile("agent-x"),
      JSON.stringify({ version: 1, goal: { status: "active" } }),
      "utf8"
    );
    expect(getGoal("agent-x")).toBeNull();
  });

  // 6. Forward schema versions still read the goal field.
  it("reads goal data from a future schema version", () => {
    mkdirSync(path.join(root, "goals"), { recursive: true });
    const envelope = {
      version: 99,
      goal: {
        objective: "From the future",
        status: "active",
        turns: 0,
        blockedStreak: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    };
    writeFileSync(goalFile("agent-future"), JSON.stringify(envelope), "utf8");

    expect(getGoal("agent-future")?.objective).toBe("From the future");
  });

  // 7. turn / evidence are stored at the envelope top level, not nested in goal.
  it("stores turns and evidence at the envelope top level", () => {
    setGoal("agent-1", "With history");

    addGoalTurn("agent-1", {
      turnNumber: 1,
      startedAt: Date.now(),
      status: "running",
    });
    addGoalEvidence("agent-1", {
      id: "ev-1",
      kind: "test",
      title: "unit tests pass",
      createdAt: Date.now(),
    });

    const envelope = readEnvelope("agent-1");
    expect(envelope.turns).toHaveLength(1);
    expect(envelope.evidence).toHaveLength(1);
    // Must NOT be nested inside the goal object.
    expect(
      (envelope.goal as unknown as Record<string, unknown>).turnHistory
    ).toBeUndefined();
    expect(
      (envelope.goal as unknown as Record<string, unknown>).evidence
    ).toBeUndefined();

    __resetGoalStoreForTest();
    expect(listGoalTurns("agent-1")).toHaveLength(1);
    expect(listGoalEvidence("agent-1")).toHaveLength(1);
  });

  // 8. Path traversal protection.
  it("rejects unsafe agent ids", () => {
    expect(() => setGoal("../escape", "bad")).toThrow();
    expect(() => setGoal("nested/id", "bad")).toThrow();
  });

  // --- M2: turn lifecycle ---

  it("starts turns with monotonic numbers and finishes the open one", () => {
    setGoal("agent-1", "With turns");

    const t1 = startGoalTurn("agent-1");
    expect(t1?.turnNumber).toBe(1);
    expect(t1?.status).toBe("running");

    const finished = finishGoalTurn("agent-1", {
      status: "completed",
      summary: "did step one",
    });
    expect(finished?.turnNumber).toBe(1);
    expect(finished?.status).toBe("completed");
    expect(finished?.endedAt).toBeTypeOf("number");

    const t2 = startGoalTurn("agent-1");
    expect(t2?.turnNumber).toBe(2);
  });

  it("keeps turn numbers monotonic across an in-memory reset", () => {
    setGoal("agent-1", "Persist turns");
    startGoalTurn("agent-1");
    finishGoalTurn("agent-1", { status: "completed" });

    __resetGoalStoreForTest();

    const t2 = startGoalTurn("agent-1");
    expect(t2?.turnNumber).toBe(2);
    expect(listGoalTurns("agent-1")).toHaveLength(2);
  });

  it("finishGoalTurn no-ops when there is no open turn", () => {
    setGoal("agent-1", "No open turn");
    expect(finishGoalTurn("agent-1")).toBeNull();
  });

  it("returns null lifecycle ops when no goal exists", () => {
    expect(startGoalTurn("missing")).toBeNull();
    expect(finishGoalTurn("missing")).toBeNull();
    expect(addGoalTurn("missing", {
      turnNumber: 1,
      startedAt: Date.now(),
      status: "running",
    })).toBeNull();
    expect(addGoalEvidence("missing", {
      id: "e",
      kind: "file",
      title: "x",
      createdAt: Date.now(),
    })).toBeNull();
  });

  // --- M2: evidence de-duplication ---

  it("de-duplicates evidence by id", () => {
    setGoal("agent-1", "Evidence dedupe");
    const ev = {
      id: "ev-1",
      kind: "test" as const,
      title: "tests pass",
      createdAt: Date.now(),
    };
    addGoalEvidence("agent-1", ev);
    addGoalEvidence("agent-1", { ...ev, title: "tests pass (updated)" });

    const list = listGoalEvidence("agent-1");
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("tests pass (updated)");
  });

  // --- M2: recap ---

  it("builds a compact recap of recent turns and evidence", () => {
    setGoal("agent-1", "Recap goal");
    startGoalTurn("agent-1");
    finishGoalTurn("agent-1", { status: "completed", summary: "wrote module" });
    addGoalEvidence("agent-1", {
      id: "ev-1",
      kind: "file",
      title: "module.ts",
      href: "/src/module.ts",
      createdAt: Date.now(),
    });

    const recap = buildGoalRecap("agent-1");
    expect(recap).toContain("Recent turns:");
    expect(recap).toContain("#1 completed");
    expect(recap).toContain("wrote module");
    expect(recap).toContain("Evidence so far:");
    expect(recap).toContain("[file] module.ts");
  });

  it("returns an empty recap when no goal exists", () => {
    expect(buildGoalRecap("missing")).toBe("");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProgress } from "../progress/types";
import {
  __setGoalStoreRootForTest,
  listGoalEvidence,
  setGoal,
  setGoalStatus,
} from "./file-store";
import {
  bridgeProgressEvidence,
  progressArtifactToEvidence,
} from "./evidence-bridge";

function progress(artifacts: AgentProgress["artifacts"]): AgentProgress {
  return { steps: [], groups: [], artifacts, updatedAt: Date.now() };
}

describe("goal evidence bridge", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "diga-agent-goals-"));
    __setGoalStoreRootForTest(root);
  });

  afterEach(() => {
    __setGoalStoreRootForTest(null);
    rmSync(root, { recursive: true, force: true });
  });

  it("maps an artifact to evidence 1:1", () => {
    const ev = progressArtifactToEvidence(
      {
        id: "a1",
        kind: "test",
        title: "tests pass",
        href: "npm test",
        summary: "42 passed",
        createdAt: 123,
      },
      7
    );
    expect(ev).toEqual({
      id: "a1",
      kind: "test",
      title: "tests pass",
      href: "npm test",
      summary: "42 passed",
      createdAt: 123,
      turnNumber: 7,
    });
  });

  it("writes evidence when the goal is active", () => {
    setGoal("agent-1", "Active goal");
    const written = bridgeProgressEvidence(
      "agent-1",
      progress([
        { id: "a1", kind: "file", title: "x.ts", createdAt: Date.now() },
        { id: "a2", kind: "log", title: "build.log", createdAt: Date.now() },
      ])
    );
    expect(written).toBe(2);
    expect(listGoalEvidence("agent-1")).toHaveLength(2);
  });

  it("does NOT write evidence when there is no goal", () => {
    const written = bridgeProgressEvidence(
      "agent-1",
      progress([{ id: "a1", kind: "file", title: "x.ts", createdAt: Date.now() }])
    );
    expect(written).toBe(0);
    expect(listGoalEvidence("agent-1")).toHaveLength(0);
  });

  it("does NOT write evidence when the goal is paused or complete", () => {
    setGoal("agent-1", "Will pause");
    setGoalStatus("agent-1", "paused");
    expect(
      bridgeProgressEvidence(
        "agent-1",
        progress([{ id: "a1", kind: "file", title: "x.ts", createdAt: Date.now() }])
      )
    ).toBe(0);

    setGoalStatus("agent-1", "complete");
    expect(
      bridgeProgressEvidence(
        "agent-1",
        progress([{ id: "a2", kind: "file", title: "y.ts", createdAt: Date.now() }])
      )
    ).toBe(0);

    expect(listGoalEvidence("agent-1")).toHaveLength(0);
  });
});

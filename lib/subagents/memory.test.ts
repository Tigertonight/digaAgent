import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetSubagentMemoryForTest,
  __setSubagentMemoryRootForTest,
  clearSubagentMemory,
  getSubagentMemory,
  renderMemoryForPrompt,
  updateSubagentMemory,
} from "./memory";

describe("subagent memory", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "diga-agent-mem-"));
    __setSubagentMemoryRootForTest(root);
  });

  afterEach(() => {
    __setSubagentMemoryRootForTest(null);
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when no memory exists", () => {
    expect(getSubagentMemory("reviewer", "project")).toBeNull();
  });

  it("persists and reloads memory", () => {
    updateSubagentMemory("reviewer", "project", {
      recurringRisks: ["missing tests in payment module"],
    });
    __resetSubagentMemoryForTest();
    const mem = getSubagentMemory("reviewer", "project");
    expect(mem?.recurringRisks).toEqual(["missing tests in payment module"]);
  });

  it("merges patches across updates", () => {
    updateSubagentMemory("reviewer", "project", { facts: ["uses pnpm"] });
    updateSubagentMemory("reviewer", "project", {
      decisions: ["prefer integration tests"],
    });
    const mem = getSubagentMemory("reviewer", "project");
    expect(mem?.facts).toEqual(["uses pnpm"]);
    expect(mem?.decisions).toEqual(["prefer integration tests"]);
  });

  it("isolates by scope", () => {
    updateSubagentMemory("reviewer", "project", { facts: ["p"] });
    updateSubagentMemory("reviewer", "user", { facts: ["u"] });
    expect(getSubagentMemory("reviewer", "project")?.facts).toEqual(["p"]);
    expect(getSubagentMemory("reviewer", "user")?.facts).toEqual(["u"]);
  });

  it("caps list length", () => {
    const many = Array.from({ length: 50 }, (_, i) => `fact ${i}`);
    const mem = updateSubagentMemory("reviewer", "project", { facts: many });
    expect(mem.facts.length).toBe(20);
  });

  it("clears memory", () => {
    updateSubagentMemory("reviewer", "project", { facts: ["x"] });
    clearSubagentMemory("reviewer", "project");
    expect(getSubagentMemory("reviewer", "project")?.facts).toEqual([]);
  });

  it("rejects unsafe ids", () => {
    expect(() =>
      updateSubagentMemory("../escape", "project", { facts: ["x"] })
    ).toThrow();
  });

  it("renders a compact prompt block", () => {
    const mem = updateSubagentMemory("reviewer", "project", {
      recurringRisks: ["race conditions"],
      facts: ["uses pnpm"],
    });
    const block = renderMemoryForPrompt(mem);
    expect(block).toContain("Known facts:");
    expect(block).toContain("uses pnpm");
    expect(block).toContain("Recurring risks:");
    expect(block).toContain("race conditions");
  });

  it("renders empty string for null memory", () => {
    expect(renderMemoryForPrompt(null)).toBe("");
  });
});

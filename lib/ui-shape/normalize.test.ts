import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  normalizeAgentProgress,
  normalizeMessageParts,
  normalizeSubagentBatchPayload,
  normalizeWorkflowUiPayload,
  safeArray,
} from "./normalize";
import { resetUiShapeDiagnosticsForTests } from "./diagnostics";

describe("ui shape normalization", () => {
  beforeEach(() => {
    resetUiShapeDiagnosticsForTests();
  });

  it("safeArray returns arrays unchanged and converts non-arrays to empty arrays", () => {
    const arr = ["a"];
    expect(safeArray(arr)).toBe(arr);
    expect(safeArray(null)).toEqual([]);
    expect(safeArray({})).toEqual([]);
    expect(safeArray("x")).toEqual([]);
  });

  it("normalizes malformed progress without throwing", () => {
    const progress = normalizeAgentProgress(
      {
        groups: [{ id: "g1", index: 1 }],
        steps: undefined,
        artifacts: undefined,
      },
      { surface: "test.progress" }
    );

    expect(progress).toMatchObject({
      groups: [{ id: "g1", steps: [] }],
      steps: [],
      artifacts: [],
    });
  });

  it("returns null for missing progress and records object shape violations", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(normalizeAgentProgress(undefined)).toBeNull();
    expect(
      normalizeAgentProgress("bad", {
        surface: "test.progress",
        sourceEventType: "progress_updated",
      })
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[ui-shape] normalized malformed UI payload",
      expect.objectContaining({
        surface: "test.progress",
        fieldPath: "progress",
        expected: "object",
        receivedType: "string",
      })
    );

    warn.mockRestore();
  });

  it("normalizes message parts to an array", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(normalizeMessageParts(undefined)).toEqual([]);
    expect(normalizeMessageParts({})).toEqual([]);
    expect(normalizeMessageParts([{ kind: "text", text: "ok" }])).toEqual([
      { kind: "text", text: "ok" },
    ]);

    warn.mockRestore();
  });

  it("normalizes workflow and subagent card arrays", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      normalizeWorkflowUiPayload({
        checkpoints: undefined,
        artifacts: {},
        logs: "bad",
        traceEvents: [],
        warnings: ["keep", 1],
      })
    ).toEqual({
      checkpoints: [],
      artifacts: [],
      logs: [],
      traceEvents: [],
      warnings: ["keep"],
    });

    expect(
      normalizeSubagentBatchPayload({
        tasks: undefined,
        auditEvents: null,
        attempts: "bad",
      })
    ).toEqual({ tasks: [], auditEvents: [], attempts: [] });

    warn.mockRestore();
  });
});

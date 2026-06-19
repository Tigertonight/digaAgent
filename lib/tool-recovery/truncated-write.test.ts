import { describe, expect, it } from "vitest";
import {
  appendWriteTruncationRecovery,
  diagnoseToolTruncation,
  isMissingWriteContentFailure,
  largeFileWriteProtocolLines,
} from "./truncated-write";

describe("write truncation recovery", () => {
  it("detects write validation failures missing content", () => {
    expect(
      isMissingWriteContentFailure({
        toolName: "write",
        isError: true,
        input: { path: "/repo/docs/report.md" },
        content: [
          {
            type: "text",
            text:
              'Validation failed for tool "write":\n' +
              "  - content: must have required properties content",
          },
        ],
      })
    ).toBe(true);
  });

  it("classifies truncation across workflow and subagent tools", () => {
    expect(
      diagnoseToolTruncation({
        toolName: "run_workflow_script",
        isError: true,
        input: { objective: "Audit", rationale: "Long harness" },
        result: {
          content: [
            {
              type: "text",
              text: "run_workflow_script received neither a script, a valid draftRef, nor a valid skillRef. If you intended to pass a large inline script, it was likely truncated.",
            },
          ],
        },
      })
    ).toMatchObject({
      code: "script_args_truncated",
      field: "script",
      recommendedStrategy: "draft_ref",
    });

    expect(
      diagnoseToolTruncation({
        toolName: "delegate_subagents",
        isError: true,
        input: { reason: "audit project" },
        result: "delegate_subagents was called without any tasks. This usually means the tool call was truncated.",
      })
    ).toMatchObject({
      code: "tool_args_truncated",
      field: "tasks",
      recommendedStrategy: "split_subagent_batch",
    });
  });

  it("detects oversized high-risk tool payloads before execution", () => {
    expect(
      diagnoseToolTruncation({
        toolName: "write",
        isError: true,
        input: { path: "docs/report.md", content: "x".repeat(13_000) },
        result: "tool error",
      })
    ).toMatchObject({
      code: "oversized_tool_payload",
      field: "content",
      recommendedStrategy: "skeleton_then_sections",
    });
  });

  it("does not flag normal write errors or valid write inputs", () => {
    expect(
      isMissingWriteContentFailure({
        toolName: "write",
        isError: true,
        input: { path: "/repo/docs/report.md", content: "hello" },
        content: [{ type: "text", text: "EACCES: permission denied" }],
      })
    ).toBe(false);

    expect(
      isMissingWriteContentFailure({
        toolName: "read",
        isError: true,
        input: { path: "/repo/docs/report.md" },
        content: [
          {
            type: "text",
            text:
              'Validation failed for tool "read":\n' +
              "  - path: must have required properties path",
          },
        ],
      })
    ).toBe(false);
  });

  it("adds an explicit segmented-retry recovery protocol", () => {
    const text = appendWriteTruncationRecovery("Validation failed");
    expect(text).toContain("do not retry the same write call");
    expect(text).toContain("short skeleton/outline first");
    expect(text).toContain("verify the file is non-empty");

    const once = appendWriteTruncationRecovery(text);
    expect(once).toBe(text);
  });

  it("documents report writing as skeleton, section edits, then verification", () => {
    const protocol = largeFileWriteProtocolLines().join("\n");
    expect(protocol).toContain("short skeleton");
    expect(protocol).toContain("one section at a time");
    expect(protocol).toContain("verify the file is non-empty");
  });
});

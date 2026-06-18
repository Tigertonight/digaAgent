import { describe, expect, it } from "vitest";
import {
  appendWriteTruncationRecovery,
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

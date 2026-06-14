import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  findWriteBoundaryViolation,
  normalizeWriteBoundaries,
} from "./write-boundary";

describe("subagent write boundary", () => {
  it("allows writes inside a declared file boundary", () => {
    const violation = findWriteBoundaryViolation({
      toolName: "edit",
      input: { path: "app/components/Safe.tsx" },
      cwd: "/repo",
      writePaths: ["app/components/Safe.tsx"],
    });

    expect(violation).toBeNull();
  });

  it("allows writes inside a declared directory boundary", () => {
    const violation = findWriteBoundaryViolation({
      toolName: "write",
      input: { path: "app/components/Nested.tsx" },
      cwd: "/repo",
      writePaths: ["app/components"],
    });

    expect(violation).toBeNull();
  });

  it("blocks writes outside declared boundaries", () => {
    const violation = findWriteBoundaryViolation({
      toolName: "edit",
      input: { path: "app/api/route.ts" },
      cwd: "/repo",
      writePaths: ["app/components"],
    });

    expect(violation).toMatchObject({
      reason: "write target is outside declared writePaths",
      paths: ["app/api/route.ts"],
      allowedPaths: ["app/components"],
    });
  });

  it("blocks write tools when no boundary is declared", () => {
    const violation = findWriteBoundaryViolation({
      toolName: "edit",
      input: { path: "app/components/Safe.tsx" },
      cwd: "/repo",
    });

    expect(violation?.reason).toContain("no writePaths boundary");
  });

  it("extracts file targets from apply_patch payloads", () => {
    const violation = findWriteBoundaryViolation({
      toolName: "apply_patch",
      input: {
        patch: [
          "*** Begin Patch",
          "*** Update File: app/components/Safe.tsx",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      cwd: "/repo",
      writePaths: ["app/components"],
    });

    expect(violation).toBeNull();
  });

  it("normalizes relative boundaries against the child cwd", () => {
    expect(normalizeWriteBoundaries("/repo", ["src"]).map((item) => item.absolute)).toEqual([
      path.resolve("/repo", "src"),
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { parseDefinition } from "./definition-parser";

const VALID = `---
title: Code Reviewer
description: Use for reviewing diffs and security risks.
role: code-review
permissionMode: readOnly
defaultTools:
  - read
  - grep
model:
  id: gpt-5
  provider: openai-completions
---

Review the diff for correctness and security. Cite file:line.`;

describe("parseDefinition", () => {
  it("parses a valid definition", () => {
    const { definition, error } = parseDefinition(VALID, {
      id: "reviewer",
      source: "project",
      sourcePath: "/x/reviewer.md",
    });
    expect(error).toBeUndefined();
    expect(definition).toBeTruthy();
    expect(definition!.id).toBe("reviewer");
    expect(definition!.title).toBe("Code Reviewer");
    expect(definition!.role).toBe("code-review");
    expect(definition!.permissionMode).toBe("readOnly");
    expect(definition!.defaultTools).toEqual(["read", "grep"]);
    expect(definition!.model).toEqual({ id: "gpt-5", provider: "openai-completions" });
    expect(definition!.prompt).toContain("Review the diff");
    expect(definition!.versionHash).toHaveLength(16);
  });

  it("errors when frontmatter is missing", () => {
    const { error } = parseDefinition("just a body, no frontmatter", {
      id: "x",
      source: "user",
    });
    expect(error).toMatch(/frontmatter/i);
  });

  it("errors when title is missing", () => {
    const md = `---\ndescription: d\n---\nbody`;
    expect(parseDefinition(md, { id: "x", source: "user" }).error).toMatch(
      /title/
    );
  });

  it("errors when description is missing", () => {
    const md = `---\ntitle: t\n---\nbody`;
    expect(parseDefinition(md, { id: "x", source: "user" }).error).toMatch(
      /description/
    );
  });

  it("errors when body is empty", () => {
    const md = `---\ntitle: t\ndescription: d\n---\n`;
    expect(parseDefinition(md, { id: "x", source: "user" }).error).toMatch(
      /prompt body/
    );
  });

  it("errors on invalid permissionMode", () => {
    const md = `---\ntitle: t\ndescription: d\npermissionMode: superuser\n---\nbody`;
    expect(parseDefinition(md, { id: "x", source: "user" }).error).toMatch(
      /permissionMode/
    );
  });

  it("warns on unknown role but still parses", () => {
    const md = `---\ntitle: t\ndescription: d\nrole: wizard\n---\nbody`;
    const res = parseDefinition(md, { id: "x", source: "user" });
    expect(res.error).toBeUndefined();
    expect(res.definition!.role).toBeUndefined();
    expect(res.warnings.join(" ")).toMatch(/wizard/);
  });

  it("rejects unsafe ids", () => {
    const md = `---\ntitle: t\ndescription: d\n---\nbody`;
    expect(parseDefinition(md, { id: "../escape", source: "user" }).error).toMatch(
      /invalid/
    );
  });

  it("truncates an over-long prompt body", () => {
    const longBody = "x".repeat(5000);
    const md = `---\ntitle: t\ndescription: d\n---\n${longBody}`;
    const res = parseDefinition(md, { id: "x", source: "user" });
    expect(res.definition!.prompt.length).toBe(4000);
  });

  it("strips quotes from scalar values", () => {
    const md = `---\ntitle: "Quoted Title"\ndescription: 'd'\n---\nbody`;
    const res = parseDefinition(md, { id: "x", source: "user" });
    expect(res.definition!.title).toBe("Quoted Title");
  });

  it("does not crash on unrecognized frontmatter lines", () => {
    const md = `---\ntitle: t\ndescription: d\n: broken line\n---\nbody`;
    const res = parseDefinition(md, { id: "x", source: "user" });
    expect(res.definition).toBeTruthy();
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});

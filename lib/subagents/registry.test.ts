import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetRegistryForTest,
  __setRegistryUserRootForTest,
  discoverDefinitions,
  getDefinition,
  getRegistryHints,
  listDefinitions,
} from "./registry";

function md(title: string, body = "do the thing", extra = ""): string {
  return `---\ntitle: ${title}\ndescription: ${title} desc\n${extra}---\n${body}`;
}

describe("subagent registry", () => {
  let userRoot: string;
  let cwd: string;

  beforeEach(() => {
    userRoot = mkdtempSync(path.join(os.tmpdir(), "diga-agent-user-"));
    cwd = mkdtempSync(path.join(os.tmpdir(), "diga-agent-cwd-"));
    __setRegistryUserRootForTest(userRoot);
  });

  afterEach(() => {
    __setRegistryUserRootForTest(null);
    rmSync(userRoot, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function writeUser(id: string, content: string) {
    const dir = path.join(userRoot, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${id}.md`), content, "utf8");
  }

  function writeProject(id: string, content: string) {
    const dir = path.join(cwd, ".agents", "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${id}.md`), content, "utf8");
  }

  it("returns empty when no directories exist", () => {
    const res = discoverDefinitions(cwd, { force: true });
    expect(res.definitions).toHaveLength(0);
    expect(res.errors).toHaveLength(0);
  });

  it("discovers user and project definitions", () => {
    writeUser("researcher", md("Researcher"));
    writeProject("reviewer", md("Reviewer"));
    const defs = listDefinitions(cwd);
    const ids = defs.map((d) => d.id).sort();
    expect(ids).toEqual(["researcher", "reviewer"]);
  });

  it("project overrides user by id", () => {
    writeUser("reviewer", md("User Reviewer"));
    writeProject("reviewer", md("Project Reviewer"));
    const def = getDefinition(cwd, "reviewer");
    expect(def?.title).toBe("Project Reviewer");
    expect(def?.source).toBe("project");
  });

  it("skips a corrupt file but keeps others", () => {
    writeProject("good", md("Good"));
    writeProject("bad", "no frontmatter here");
    const res = discoverDefinitions(cwd, { force: true });
    expect(res.definitions.map((d) => d.id)).toEqual(["good"]);
    expect(res.errors.join(" ")).toMatch(/bad\.md/);
  });

  it("caches by cwd and re-reads with force", () => {
    writeProject("a", md("A"));
    expect(listDefinitions(cwd)).toHaveLength(1);
    writeProject("b", md("B"));
    // Cached: still 1 without force.
    expect(listDefinitions(cwd)).toHaveLength(1);
    // Force re-discovery: now 2.
    expect(discoverDefinitions(cwd, { force: true }).definitions).toHaveLength(2);
  });

  it("produces compact hints", () => {
    writeProject("reviewer", md("Reviewer"));
    const hints = getRegistryHints(cwd);
    expect(hints).toEqual([
      { id: "reviewer", title: "Reviewer", description: "Reviewer desc" },
    ]);
  });

  it("assigns version hashes that differ by content", () => {
    writeProject("a", md("A", "body one"));
    const v1 = getDefinition(cwd, "a")?.versionHash;
    writeProject("a", md("A", "body two"));
    const v2 = discoverDefinitions(cwd, { force: true }).definitions[0].versionHash;
    expect(v1).toBeTruthy();
    expect(v2).toBeTruthy();
    expect(v1).not.toBe(v2);
  });

  it("isolates via __resetRegistryForTest", () => {
    writeProject("a", md("A"));
    listDefinitions(cwd);
    __resetRegistryForTest();
    writeProject("b", md("B"));
    expect(listDefinitions(cwd).map((d) => d.id).sort()).toEqual(["a", "b"]);
  });
});

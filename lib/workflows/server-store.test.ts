import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __clearWorkflowMemoryForTest,
  __setWorkflowStoreRootForTest,
  getWorkflowRun,
  listWorkflowRuns,
  pruneWorkflowRuns,
  putWorkflowRun,
  workflowResumeSnapshot,
} from "./server-store";
import type { WorkflowRun } from "./types";

describe("workflow server-store persistence", () => {
  let workflowRoot: string;
  let originalCompressionThreshold: string | undefined;

  beforeEach(async () => {
    originalCompressionThreshold =
      process.env.DIGA_AGENT_WORKFLOW_ARTIFACT_COMPRESSION_BYTES;
    process.env.DIGA_AGENT_WORKFLOW_ARTIFACT_COMPRESSION_BYTES = "64";
    workflowRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-store-schema-"));
    __setWorkflowStoreRootForTest(workflowRoot);
  });

  afterEach(async () => {
    if (originalCompressionThreshold === undefined) {
      delete process.env.DIGA_AGENT_WORKFLOW_ARTIFACT_COMPRESSION_BYTES;
    } else {
      process.env.DIGA_AGENT_WORKFLOW_ARTIFACT_COMPRESSION_BYTES =
        originalCompressionThreshold;
    }
    __setWorkflowStoreRootForTest(null);
    if (workflowRoot) {
      await rm(workflowRoot, { recursive: true, force: true });
    }
  });

  function run(id: string, patch: Partial<WorkflowRun> = {}): WorkflowRun {
    return {
      id,
      parentAgentId: "parent-store",
      objective: `Objective ${id}`,
      rationale: "Store test",
      status: "completed",
      script: "return true;",
      manifest: {
        capabilities: ["spawn_agent", "read_files"],
        maxAgents: 8,
        maxConcurrency: 4,
        timeoutMs: 600000,
        runtime: "process",
      },
      artifacts: [],
      checkpoints: [],
      logs: [],
      createdAt: Date.now(),
      endedAt: Date.now(),
      ...patch,
    };
  }

  function runFile(id: string) {
    return path.join(workflowRoot, "workflows", "runs", `${id}.json`);
  }

  it("persists workflow runs in a versioned envelope", async () => {
    putWorkflowRun(run("workflow-envelope"));

    const raw = JSON.parse(await readFile(runFile("workflow-envelope"), "utf8"));
    expect(raw.schemaVersion).toBe(2);
    expect(raw.kind).toBe("workflow-run");
    expect(raw.run.id).toBe("workflow-envelope");
    expect(typeof raw.persistedAt).toBe("number");
    expect(raw.artifactIndex).toEqual([]);
    expect(raw.migrationHistory).toContain("workflow-run:v2");
  });

  it("loads legacy bare WorkflowRun JSON and migrates it to the envelope format", async () => {
    const legacy = run("workflow-legacy", {
      checkpoints: [{ name: "legacy", value: true, createdAt: Date.now() }],
    });
    await mkdir(path.dirname(runFile(legacy.id)), { recursive: true });
    await writeFile(runFile(legacy.id), JSON.stringify(legacy, null, 2), "utf8");

    __clearWorkflowMemoryForTest();
    const loaded = getWorkflowRun(legacy.id);
    expect(loaded?.checkpoints[0]?.name).toBe("legacy");

    const migrated = JSON.parse(await readFile(runFile(legacy.id), "utf8"));
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.run.id).toBe(legacy.id);
  });

  it("compresses large persisted artifacts and restores them when loading", async () => {
    const largeValue = { text: "x".repeat(300), nested: { ok: true } };
    putWorkflowRun(
      run("workflow-compressed", {
        artifacts: [
          {
            name: "large",
            value: largeValue,
            createdAt: 123,
          },
        ],
      })
    );

    const raw = JSON.parse(await readFile(runFile("workflow-compressed"), "utf8"));
    expect(raw.artifactIndex).toEqual([
      expect.objectContaining({ name: "large", compressed: true }),
    ]);
    expect(raw.run.artifacts[0].value.__digaAgentWorkflowCompressedArtifact).toBe(
      true
    );

    __clearWorkflowMemoryForTest();
    expect(getWorkflowRun("workflow-compressed")?.artifacts[0]?.value).toEqual(
      largeValue
    );
  });

  it("prunes old completed workflow runs per parent without deleting running runs", () => {
    const base = Date.now();
    putWorkflowRun(run("old-1", { createdAt: base - 3000 }));
    putWorkflowRun(run("old-2", { createdAt: base - 2000 }));
    putWorkflowRun(run("new-1", { createdAt: base - 1000 }));
    putWorkflowRun(
      run("running-old", {
        status: "running",
        createdAt: base - 10000,
        endedAt: undefined,
      })
    );

    const result = pruneWorkflowRuns({ maxRunsPerParent: 2, maxAgeMs: 0, now: base });
    expect(result.deleted).toBe(1);
    expect(listWorkflowRuns("parent-store").map((item) => item.id)).toEqual([
      "new-1",
      "old-2",
      "running-old",
    ]);
  });

  it("includes compact checkpoint and artifact previews in resume snapshots", () => {
    const saved = run("workflow-resume-summary", {
      checkpoints: [
        {
          name: "scan",
          value: { files: ["a.ts"], note: "ready" },
          createdAt: 100,
        },
      ],
      artifacts: [
        {
          name: "large-report",
          value: { text: "x".repeat(500) },
          createdAt: 200,
        },
      ],
    });

    const snapshot = workflowResumeSnapshot(saved);
    expect(snapshot.checkpointSummaries).toEqual([
      {
        name: "scan",
        createdAt: 100,
        preview: '{"files":["a.ts"],"note":"ready"}',
      },
    ]);
    expect(snapshot.artifactSummaries[0]?.name).toBe("large-report");
    expect(snapshot.artifactSummaries[0]?.preview.length).toBeLessThanOrEqual(361);
  });
});

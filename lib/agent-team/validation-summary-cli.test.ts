import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve("scripts/agent-team-validation-summary.mjs");

function writeRun(root: string, run: Record<string, unknown>) {
  const dir = path.join(root, "agent-teams", "runs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${run.id}.json`),
    JSON.stringify({ schemaVersion: 1, kind: "agent-team-run", persistedAt: 1, run }, null, 2)
  );
}

function baseRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "team-validation-test",
    parentAgentId: "agent-1",
    parentSessionPath: "/tmp/session.jsonl",
    objective: "SECRET USER OBJECTIVE",
    status: "completed",
    leadState: "finalized",
    leadAgentId: "lead",
    createdAt: 1,
    updatedAt: 2,
    settings: {
      memberScale: "standard",
      allowNetwork: false,
      allowWrite: true,
      allowWorktree: true,
      allowChallenges: true,
      requirePlanApproval: true,
      displayMode: "workspace",
      writePolicy: "plan_approval",
      networkPolicy: "disabled",
      worktreePolicy: "per_member",
      resultIngestionMode: "structured",
      coordinationProfile: "basic",
      stopConditions: {
        requiredTasksComplete: true,
        noOpenBlockingChallenges: true,
        leadFinalSynthesis: true,
      },
    },
    members: [
      { id: "lead", name: "Lead", role: "lead", agentId: "agent-1", status: "idle" },
      {
        id: "builder",
        name: "Builder",
        role: "builder",
        agentId: "agent-2",
        status: "idle",
        hydrateState: "rehydrated",
        worktree: {
          id: "wt",
          path: "/tmp/wt",
          branchName: "team/builder",
          baseRef: "HEAD",
          status: "merged",
          createdAt: 1,
        },
      },
    ],
    coordinationAudit: [
      { id: "c1", at: 1, memberId: "builder", toolName: "team_get_board", args: {}, outcome: "ok" },
      { id: "c2", at: 2, memberId: "builder", toolName: "team_submit_result", args: {}, outcome: "ok" },
    ],
    board: {
      summary: "done",
      tasks: [
        {
          id: "task",
          title: "Task",
          description: "Task",
          status: "completed",
          ownerAgentId: "builder",
          expectedOutput: "report",
          evidenceRequired: true,
          priority: "high",
          required: true,
          findingIds: ["finding"],
          completedAt: 2,
        },
      ],
      results: [
        {
          id: "result",
          taskId: "task",
          authorAgentId: "builder",
          sessionFile: "/tmp/session.jsonl",
          rawText: "SECRET RAW TEAMMATE OUTPUT",
          summary: "summary",
          parsedAt: 2,
          status: "parsed",
          findingIds: ["finding"],
          challengeIds: [],
          evidenceRefs: ["session:/tmp/session.jsonl"],
          parseWarnings: [],
        },
      ],
      plans: [],
      findings: [
        {
          id: "finding",
          taskId: "task",
          authorAgentId: "builder",
          claim: "SECRET FINDING CLAIM",
          evidenceRefs: ["session:/tmp/session.jsonl"],
          confidence: "high",
          status: "accepted",
          challengeIds: [],
          sourceResultId: "result",
        },
      ],
      challenges: [],
      decisions: [
        {
          id: "decision",
          title: "Decision",
          rationale: "SECRET DECISION RATIONALE",
          acceptedFindingIds: ["finding"],
          rejectedFindingIds: [],
          challengeIds: [],
          evidenceRefs: ["session:/tmp/session.jsonl"],
          sourceResultIds: ["result"],
          confidence: "high",
          status: "accepted",
          madeByAgentId: "lead",
          createdAt: 2,
        },
      ],
      messages: [],
      fileLocks: [],
      hooks: [],
      qualityGates: [{ id: "gate", title: "Gate", status: "passed", severity: "blocking" }],
      capabilityAudit: [],
      events: [],
    },
    ...overrides,
  };
}

describe("agent-team-validation-summary script", () => {
  it("creates a strict passing redacted summary without raw user/team content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diga-team-summary-"));
    const run = baseRun();
    writeRun(root, run);

    const output = execFileSync("node", [scriptPath, "--root", root, "--strict"], {
      encoding: "utf8",
    });

    expect(output).toContain("Passed 8/8 checks.");
    expect(output).toContain("team_submit_result:1");
    expect(output).not.toContain("SECRET USER OBJECTIVE");
    expect(output).not.toContain("SECRET RAW TEAMMATE OUTPUT");
    expect(output).not.toContain("SECRET FINDING CLAIM");
    expect(output).not.toContain("SECRET DECISION RATIONALE");
  });

  it("fails strict mode for incomplete real-model evidence", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diga-team-summary-"));
    const complete = baseRun();
    const run = baseRun({
      status: "running",
      leadState: "exploring",
      board: {
        ...(complete.board as Record<string, unknown>),
        tasks: [
          {
            id: "task",
            title: "Task",
            description: "Task",
            status: "running",
            ownerAgentId: "builder",
            expectedOutput: "report",
            evidenceRequired: true,
            priority: "high",
            required: true,
            findingIds: [],
          },
        ],
        decisions: [],
        challenges: [{ id: "challenge", status: "open" }],
      },
    });
    writeRun(root, run);

    const result = spawnSync("node", [scriptPath, "--root", root, "--strict"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Passed 5/8 checks.");
    expect(result.stdout).toContain("Required tasks complete | needs review");
    expect(result.stdout).toContain("No open blocking challenges | needs review");
    expect(result.stdout).toContain("Final decision is traceable | needs review");
  });

  it("accepts decision evidence through source results and accepted findings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diga-team-summary-"));
    const complete = baseRun();
    writeRun(
      root,
      baseRun({
        board: {
          ...(complete.board as Record<string, unknown>),
          decisions: [
            {
              id: "decision",
              title: "Decision",
              rationale: "SECRET DECISION RATIONALE",
              acceptedFindingIds: ["finding"],
              rejectedFindingIds: [],
              challengeIds: [],
              evidenceRefs: [],
              sourceResultIds: ["result"],
              confidence: "high",
              status: "accepted",
              madeByAgentId: "lead",
              createdAt: 2,
            },
          ],
        },
      })
    );

    const output = execFileSync("node", [scriptPath, "--root", root, "--strict"], {
      encoding: "utf8",
    });

    expect(output).toContain("Passed 8/8 checks.");
    expect(output).not.toContain("SECRET DECISION RATIONALE");
  });

  it("lists redacted validation candidates ordered by score", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diga-team-summary-"));
    writeRun(root, baseRun({ id: "team-pass" }));
    writeRun(
      root,
      baseRun({
        id: "team-incomplete",
        objective: "SECRET LOWER SCORE OBJECTIVE",
        board: {
          ...(baseRun().board as Record<string, unknown>),
          tasks: [
            {
              id: "task",
              title: "Task",
              description: "Task",
              status: "running",
              ownerAgentId: "builder",
              expectedOutput: "report",
              evidenceRequired: true,
              priority: "high",
              required: true,
              findingIds: [],
            },
          ],
          decisions: [],
        },
      })
    );

    const output = execFileSync("node", [scriptPath, "--root", root, "--list"], {
      encoding: "utf8",
    });

    expect(output).toContain("# Agent Team Validation Candidates");
    expect(output.indexOf("team-pass")).toBeLessThan(output.indexOf("team-incomplete"));
    expect(output).toContain("| 8/8 | completed | finalized | standard | none | `team-pass`");
    expect(output).toContain("traceable_decision");
    expect(output).not.toContain("SECRET LOWER SCORE OBJECTIVE");
    expect(output).not.toContain("SECRET RAW TEAMMATE OUTPUT");
  });
});

import { describe, expect, it } from "vitest";
import { createInitialAgentTeamRun } from "./mock";
import {
  acceptAgentTeamFinding,
  claimAgentTeamTask,
  completeAgentTeamInitialFrame,
  completeAgentTeamTask,
  createAgentTeamChallenge,
  createAgentTeamDispatchPlan,
  createAgentTeamDispatchPlans,
  evaluateAgentTeamFinalize,
  markAgentTeamTeammateIdle,
  promoteAgentTeamMember,
  failAgentTeamTask,
  recoverStaleAgentTeamTasks,
  recordAgentTeamDecision,
  replaceAgentTeamMember,
  resolveAgentTeamChallenge,
  recordAgentTeamToolWrite,
  retryAgentTeamTask,
  sendAgentTeamMessage,
  submitAgentTeamResult,
  transitionAgentTeamRun,
  updateAgentTeamHook,
} from "./runtime";

describe("agent team runtime gates", () => {
  it("blocks finalize while required tasks are incomplete", () => {
    const run = createInitialAgentTeamRun("compare agent teams");
    const result = transitionAgentTeamRun(run, "completed");

    expect(result.blockedReasons.length).toBeGreaterThan(0);
    expect(result.run.status).toBe("running");
    expect(result.run.board.qualityGates.some((gate) => gate.status === "failed")).toBe(true);
    expect(result.run.board.events.at(-1)?.type).toBe("quality_gate_failed");
  });

  it("allows finalize only after required tasks and a traceable decision are present", () => {
    const run = createInitialAgentTeamRun("finalize team");
    const withAcceptedFinding = {
      ...run,
      leadState: "ready_to_synthesize" as const,
      board: {
        ...run.board,
        tasks: run.board.tasks.map((task) => ({
          ...task,
          status: "completed" as const,
          completedAt: Date.now(),
        })),
        findings: [
          {
            id: "finding-final",
            authorAgentId: run.leadAgentId,
            claim: "Traceable final finding.",
            evidenceRefs: ["artifact:final"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
            sourceResultId: "result-final",
          },
        ],
        decisions: [
          {
            id: "decision-final",
            title: "Final decision",
            rationale: "Accepted evidence supports synthesis.",
            acceptedFindingIds: ["finding-final"],
            rejectedFindingIds: [],
            evidenceRefs: ["artifact:final"],
            sourceResultIds: ["result-final"],
            madeByAgentId: run.leadAgentId,
            status: "accepted" as const,
          },
        ],
      },
    };

    const check = evaluateAgentTeamFinalize(withAcceptedFinding);
    const result = transitionAgentTeamRun(withAcceptedFinding, "completed");

    expect(check.ok).toBe(true);
    expect(result.blockedReasons).toEqual([]);
    expect(result.run.status).toBe("completed");
    expect(result.run.leadState).toBe("finalized");
  });

  it("ingests structured teammate results before completing tasks", () => {
    const run = createInitialAgentTeamRun("structured results");
    const memberId = run.members[1].id;
    const claimed = claimAgentTeamTask(
      {
        ...run,
        members: run.members.map((member) =>
          member.id === memberId ? { ...member, agentId: "child-agent" } : member
        ),
      },
      "frame",
      memberId
    );
    const submitted = submitAgentTeamResult(claimed.run, {
      taskId: "frame",
      memberId,
      rawText: [
        "```TEAM_RESULT_JSON",
        JSON.stringify({
          summary: "Framing completed.",
          findings: [
            {
              claim: "Team mode needs an explicit workspace.",
              evidenceRefs: ["session:/tmp/member.jsonl", "artifact:board"],
              confidence: "high",
            },
          ],
          challenges: [
            {
              reason: "Need proof that this is distinct from subagents.",
              severity: "medium",
            },
          ],
        }),
        "```",
      ].join("\n"),
      sessionFile: "/tmp/member.jsonl",
      dispatchMode: "single",
    });

    expect(submitted.error).toBeUndefined();
    expect(submitted.run.board.results).toHaveLength(1);
    expect(submitted.run.board.findings).toHaveLength(2);
    expect(submitted.run.board.findings.some((finding) => finding.sourceResultId === submitted.run.board.results[0].id)).toBe(true);
    expect(submitted.run.board.challenges).toHaveLength(1);
    expect(submitted.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("completed");
    expect(submitted.run.board.tasks.find((task) => task.id === "frame")?.completionSource).toBe("teammate_result");
  });

  it("blocks malformed teammate results for review", () => {
    const run = createInitialAgentTeamRun("bad result");
    const result = submitAgentTeamResult(run, {
      taskId: "frame",
      memberId: run.leadAgentId,
      rawText: "I think it is done, but no JSON.",
    });

    expect(result.error).toContain("needs review");
    expect(result.run.board.results[0]?.status).toBe("needs_review");
    expect(result.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("blocked");
  });

  it("records finding acceptance, challenge resolution, and traceable decisions", () => {
    const run = createInitialAgentTeamRun("decision chain");
    const completed = completeAgentTeamTask(run, "frame", run.leadAgentId, {
      findingClaim: "Accepted team finding.",
      evidenceRefs: ["artifact:finding"],
      confidence: "high",
    });
    const findingId = completed.run.board.findings.at(-1)!.id;
    const accepted = acceptAgentTeamFinding(completed.run, findingId, run.leadAgentId);
    const challenged = createAgentTeamChallenge(accepted.run, {
      targetFindingId: findingId,
      authorAgentId: run.leadAgentId,
      reason: "Verify traceability.",
    });
    const challengeId = challenged.run.board.challenges.at(-1)!.id;
    const resolved = resolveAgentTeamChallenge(
      challenged.run,
      challengeId,
      run.leadAgentId,
      "Evidence verified.",
      [findingId]
    );
    const decision = recordAgentTeamDecision(resolved.run, {
      title: "Use Team workspace",
      rationale: "Accepted finding and resolved challenge are traceable.",
      madeByAgentId: run.leadAgentId,
      acceptedFindingIds: [findingId],
      challengeIds: [challengeId],
      evidenceRefs: ["artifact:finding"],
    });

    expect(decision.error).toBeUndefined();
    expect(decision.run.board.findings.find((finding) => finding.id === findingId)?.status).toBe("challenged");
    expect(decision.run.board.challenges.find((challenge) => challenge.id === challengeId)?.status).toBe("resolved");
    expect(decision.run.board.decisions.at(-1)?.acceptedFindingIds).toEqual([findingId]);
  });

  it("blocks claiming a dependent task until prerequisites complete, then unblocks it", () => {
    const run = createInitialAgentTeamRun("dependency team");
    const leadId = run.leadAgentId;
    const blocked = claimAgentTeamTask(run, "evidence", leadId);

    expect(blocked.error).toContain("Waiting for dependencies");
    expect(blocked.run.board.tasks.find((task) => task.id === "evidence")?.status).toBe("blocked");

    const completed = completeAgentTeamTask(blocked.run, "frame", leadId, {
      findingClaim: "Problem framing complete.",
      evidenceRefs: ["team:frame"],
      confidence: "high",
    });

    expect(completed.error).toBeUndefined();
    expect(completed.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("completed");
    expect(completed.run.board.tasks.find((task) => task.id === "evidence")?.status).toBe("pending");
    expect(completed.run.board.findings.some((finding) => finding.claim === "Problem framing complete.")).toBe(true);
  });

  it("acquires file locks on claim, blocks conflicting claims, and releases locks on completion", () => {
    const run = createInitialAgentTeamRun("file lock team");
    const firstMember = run.members[1].id;
    const secondMember = run.members[2].id;
    const ready = {
      ...run,
      members: run.members.map((member, index) =>
        index > 0 ? { ...member, agentId: `child-${index}` } : member
      ),
      board: {
        ...run.board,
        tasks: [
          {
            ...run.board.tasks[0],
            id: "edit-a",
            title: "Edit A",
            status: "pending" as const,
            ownerAgentId: undefined,
            dependsOnTaskIds: [],
            writePaths: ["src/app.ts"],
          },
          {
            ...run.board.tasks[1],
            id: "edit-b",
            title: "Edit B",
            status: "pending" as const,
            dependsOnTaskIds: [],
            writePaths: ["src/app.ts"],
          },
        ],
      },
    };

    const claimed = claimAgentTeamTask(ready, "edit-a", firstMember);
    const blocked = claimAgentTeamTask(claimed.run, "edit-b", secondMember);
    const completed = completeAgentTeamTask(claimed.run, "edit-a", firstMember, {
      findingClaim: "Edit A complete.",
    });

    expect(claimed.error).toBeUndefined();
    expect(claimed.run.board.fileLocks.filter((lock) => lock.status === "active")).toHaveLength(1);
    expect(blocked.error).toContain("Waiting for file lock");
    expect(blocked.run.board.tasks.find((task) => task.id === "edit-b")?.status).toBe("blocked");
    expect(completed.run.board.fileLocks.every((lock) => lock.status === "released")).toBe(true);
    expect(completed.run.board.events.some((event) => event.type === "file_lock_released")).toBe(true);
  });

  it("auto-acquires file locks from write tool targets", () => {
    const run = createInitialAgentTeamRun("tool lock team");
    const memberId = run.members[1].id;
    const claimed = claimAgentTeamTask(
      {
        ...run,
        members: run.members.map((member, index) =>
          index === 1 ? { ...member, agentId: "child-agent" } : member
        ),
        board: {
          ...run.board,
          tasks: run.board.tasks.map((task) =>
            task.id === "frame"
              ? { ...task, status: "pending" as const, ownerAgentId: undefined }
              : task
          ),
        },
      },
      "frame",
      memberId
    );
    const locked = recordAgentTeamToolWrite(claimed.run, memberId, ["src/app.ts"]);

    expect(locked.error).toBeUndefined();
    expect(locked.run.board.fileLocks.some((lock) => lock.path === "src/app.ts" && lock.status === "active")).toBe(true);
    expect(locked.run.board.tasks.find((task) => task.id === "frame")?.writePaths).toContain("src/app.ts");
    expect(locked.run.board.capabilityAudit.find((item) => item.id === "file-locking")?.evidence).toContain("write tool acquired Team file locks");
  });

  it("blocks write tool targets that conflict with another teammate lock", () => {
    const run = createInitialAgentTeamRun("tool lock conflict");
    const firstMember = run.members[1].id;
    const secondMember = run.members[2].id;
    const ready = {
      ...run,
      members: run.members.map((member, index) =>
        index > 0 ? { ...member, agentId: `child-${index}` } : member
      ),
      board: {
        ...run.board,
        tasks: [
          {
            ...run.board.tasks[0],
            id: "edit-a",
            status: "pending" as const,
            ownerAgentId: undefined,
            dependsOnTaskIds: [],
          },
          {
            ...run.board.tasks[1],
            id: "edit-b",
            status: "pending" as const,
            ownerAgentId: undefined,
            dependsOnTaskIds: [],
          },
        ],
      },
    };
    const firstClaim = claimAgentTeamTask(ready, "edit-a", firstMember);
    const firstLock = recordAgentTeamToolWrite(firstClaim.run, firstMember, ["src/app.ts"]);
    const secondClaim = claimAgentTeamTask(firstLock.run, "edit-b", secondMember);
    const conflict = recordAgentTeamToolWrite(secondClaim.run, secondMember, ["src/app.ts"]);

    expect(conflict.error).toContain("Waiting for file lock");
    expect(conflict.run.board.tasks.find((task) => task.id === "edit-b")?.status).toBe("blocked");
    expect(conflict.run.members.find((member) => member.id === secondMember)?.status).toBe("blocked");
  });

  it("releases active file locks when the team is aborted", () => {
    const run = createInitialAgentTeamRun("shutdown locks");
    const memberId = run.members[1].id;
    const claimed = claimAgentTeamTask(
      {
        ...run,
        members: run.members.map((member, index) =>
          index === 1 ? { ...member, agentId: "child-agent" } : member
        ),
        board: {
          ...run.board,
          tasks: run.board.tasks.map((task) =>
            task.id === "frame"
              ? { ...task, status: "pending" as const, ownerAgentId: undefined, writePaths: ["src/a.ts"] }
              : task
          ),
        },
      },
      "frame",
      memberId
    );
    const stopped = transitionAgentTeamRun(claimed.run, "aborted");

    expect(stopped.run.status).toBe("aborted");
    expect(stopped.run.board.fileLocks.every((lock) => lock.status === "released")).toBe(true);
    expect(stopped.run.board.capabilityAudit.find((item) => item.id === "shutdown-cleanup")?.digaStatus).toBe("implemented");
  });

  it("records mailbox messages and updates Claude parity audit", () => {
    const run = createInitialAgentTeamRun("mailbox team");
    const result = sendAgentTeamMessage(run, {
      fromAgentId: run.leadAgentId,
      body: "Please challenge the first finding.",
    });

    expect(result.error).toBeUndefined();
    expect(result.run.board.messages).toHaveLength(1);
    expect(result.run.board.events.at(-1)?.type).toBe("message_sent");
    expect(result.run.board.capabilityAudit.find((item) => item.id === "mailbox")?.digaStatus).toBe("partial");
  });

  it("records direct teammate follow-ups in mailbox and parity audit", () => {
    const run = createInitialAgentTeamRun("direct follow up");
    const memberId = run.members[1].id;
    const result = sendAgentTeamMessage(
      run,
      {
        fromAgentId: run.leadAgentId,
        toAgentId: memberId,
        body: "Can you check the evidence again?",
      },
      { directFollowUp: true }
    );

    expect(result.error).toBeUndefined();
    expect(result.run.board.messages.at(-1)?.toAgentId).toBe(memberId);
    expect(result.run.members.find((member) => member.id === memberId)?.latestOutput).toContain("follow-up");
    expect(result.run.board.capabilityAudit.find((item) => item.id === "direct-teammate-interaction")?.digaStatus).toBe("implemented");
  });

  it("promotes a teammate session for direct interaction", () => {
    const run = createInitialAgentTeamRun("promote teammate");
    const memberId = run.members[1].id;
    const result = promoteAgentTeamMember(
      {
        ...run,
        members: run.members.map((member) =>
          member.id === memberId
            ? { ...member, agentId: "child-agent", sessionFile: "/tmp/child.jsonl" }
            : member
        ),
      },
      memberId
    );

    expect(result.error).toBeUndefined();
    expect(result.run.members.find((member) => member.id === memberId)?.sidebarVisible).toBe(true);
    expect(result.run.board.events.at(-1)?.type).toBe("member_promoted");
    expect(result.run.board.capabilityAudit.find((item) => item.id === "direct-teammate-interaction")?.digaStatus).toBe("implemented");
  });

  it("creates a teammate dispatch plan with mailbox context", () => {
    const run = createInitialAgentTeamRun("dispatch team");
    const teammateId = run.members[1].id;
    const ready = sendAgentTeamMessage(
      {
        ...run,
        members: run.members.map((member, index) =>
          index === 1 ? { ...member, agentId: "child-agent-1" } : member
        ),
        board: {
          ...run.board,
          tasks: run.board.tasks.map((task) =>
            task.id === "frame" ? { ...task, status: "completed" } : task
          ),
        },
      },
      {
        fromAgentId: run.leadAgentId,
        toAgentId: teammateId,
        body: "Focus on evidence.",
      }
    ).run;

    const plan = createAgentTeamDispatchPlan(ready);

    expect(plan?.task.id).toBe("evidence");
    expect(plan?.memberId).toBe(teammateId);
    expect(plan?.mailboxMessages[0]?.body).toBe("Focus on evidence.");
    expect(plan?.prompt).toContain("Task title: 收集证据");
  });

  it("does not fall back to Lead when no teammate session is runnable", () => {
    const run = createInitialAgentTeamRun("no teammate fallback");
    const ready = completeAgentTeamInitialFrame(run);

    expect(createAgentTeamDispatchPlan(ready)).toBeNull();
  });

  it("recovers stale claimed tasks so until-idle can redispatch them", () => {
    const run = createInitialAgentTeamRun("stale team");
    const now = 1_782_000_000_000;
    const teammateId = run.members.find((member) => member.id.includes(":researcher"))?.id;
    if (!teammateId) throw new Error("missing researcher");
    const claimed = claimAgentTeamTask(
      {
        ...run,
        updatedAt: now - 10 * 60_000,
        board: {
          ...run.board,
          tasks: run.board.tasks.map((task) =>
            task.id === "frame"
              ? { ...task, status: "completed" as const }
              : task
          ),
        },
        members: run.members.map((member) =>
          member.id === teammateId ? { ...member, agentId: "research-agent" } : member
        ),
      },
      "evidence",
      teammateId
    ).run;
    const stale = {
      ...claimed,
      board: {
        ...claimed.board,
        tasks: claimed.board.tasks.map((task) =>
          task.id === "evidence"
            ? { ...task, claimedAt: now - 10 * 60_000 }
            : task
        ),
      },
    };

    const recovered = recoverStaleAgentTeamTasks(stale, {
      now,
      staleMs: 60_000,
    });

    expect(recovered.recoveredTaskIds).toEqual(["evidence"]);
    expect(
      recovered.run.board.tasks.find((task) => task.id === "evidence")?.status
    ).toBe("pending");
    expect(
      recovered.run.board.tasks.find((task) => task.id === "evidence")?.ownerAgentId
    ).toBeUndefined();
    expect(
      recovered.run.members.find((member) => member.id === teammateId)?.status
    ).toBe("idle");
    expect(createAgentTeamDispatchPlan(recovered.run)?.task.id).toBe("evidence");
    expect(createAgentTeamDispatchPlan(recovered.run)?.memberId).toBe(teammateId);
  });

  it("assigns challenge and synthesis tasks to matching teammates", () => {
    const run = createInitialAgentTeamRun("role matching");
    const withAgents = {
      ...run,
      members: run.members.map((member) =>
        member.id === run.leadAgentId
          ? member
          : { ...member, agentId: `agent-${member.name.toLowerCase()}` }
      ),
      board: {
        ...run.board,
        tasks: run.board.tasks.map((task) => {
          if (task.id === "frame" || task.id === "evidence") {
            return { ...task, status: "completed" as const };
          }
          return task;
        }),
      },
    };

    const challengePlan = createAgentTeamDispatchPlan(withAgents);

    expect(challengePlan?.task.id).toBe("challenge");
    expect(challengePlan?.memberId).toContain(":critic");

    const withChallengeDone = {
      ...withAgents,
      board: {
        ...withAgents.board,
        tasks: withAgents.board.tasks.map((task) =>
          task.id === "challenge"
            ? { ...task, status: "completed" as const }
            : task
        ),
      },
    };
    const synthesisPlan = createAgentTeamDispatchPlan(withChallengeDone);

    expect(synthesisPlan?.task.id).toBe("synthesis");
    expect(synthesisPlan?.memberId).toContain(":synthesizer");
    expect(synthesisPlan?.prompt).toContain("final answer to the user's Team objective");
    expect(synthesisPlan?.prompt).toContain("direct conclusion");
  });

  it("auto-settles synthesis results into a traceable final decision", () => {
    const run = createInitialAgentTeamRun("auto settle");
    const memberId = run.members.find((member) => member.id.includes(":synthesizer"))?.id ?? run.leadAgentId;
    const prepared = {
      ...run,
      members: run.members.map((member) =>
        member.id === memberId ? { ...member, agentId: "synthesis-agent" } : member
      ),
      board: {
        ...run.board,
        tasks: run.board.tasks.map((task) => {
          if (task.id === "frame" || task.id === "evidence" || task.id === "challenge") {
            return { ...task, status: "completed" as const };
          }
          if (task.id === "synthesis") {
            return {
              ...task,
              status: "claimed" as const,
              ownerAgentId: memberId,
            };
          }
          return task;
        }),
        challenges: [
          {
            id: "open-challenge",
            targetFindingId: "f-mode",
            authorAgentId: run.leadAgentId,
            reason: "Needs final synthesis.",
            severity: "medium" as const,
            status: "open" as const,
            createdAt: Date.now(),
          },
        ],
      },
    };

    const submitted = submitAgentTeamResult(prepared, {
      taskId: "synthesis",
      memberId,
      rawText: [
        "TEAM_RESULT_JSON:",
        "```json",
        JSON.stringify({
          summary: "Final traceable synthesis.",
          findings: [
            {
              claim: "Final decision is backed by accepted evidence.",
              confidence: "high",
              evidenceRefs: ["file:app/components/MessageView.tsx"],
            },
          ],
          challenges: [],
          needsFollowUp: [],
        }),
        "```",
      ].join("\n"),
      dispatchMode: "until_idle",
    });

    expect(submitted.error).toBeUndefined();
    expect(submitted.run.status).toBe("completed");
    expect(submitted.run.leadState).toBe("finalized");
    expect(submitted.run.board.challenges.every((challenge) => challenge.status === "resolved")).toBe(true);
    expect(submitted.run.board.decisions.at(-1)?.acceptedFindingIds.length).toBeGreaterThan(0);
    expect(submitted.run.board.decisions.at(-1)?.sourceResultIds).toHaveLength(1);
  });

  it("does not recover stale tasks that already have a submitted result", () => {
    const run = createInitialAgentTeamRun("result team");
    const now = 1_782_000_000_000;
    const leadId = run.leadAgentId;
    const claimed = claimAgentTeamTask(
      {
        ...run,
        updatedAt: now - 10 * 60_000,
        board: {
          ...run.board,
          tasks: run.board.tasks.map((task) =>
            task.id === "frame"
              ? { ...task, status: "completed" as const }
              : task
          ),
        },
      },
      "evidence",
      leadId
    ).run;
    const withResult = {
      ...claimed,
      board: {
        ...claimed.board,
        tasks: claimed.board.tasks.map((task) =>
          task.id === "evidence"
            ? { ...task, claimedAt: now - 10 * 60_000 }
            : task
        ),
        results: [
          {
            id: "result-1",
            taskId: "evidence",
            authorAgentId: leadId,
            rawText: "done",
            summary: "done",
            parsedAt: now - 1_000,
            status: "parsed" as const,
            findingIds: [],
            challengeIds: [],
            evidenceRefs: [],
            parseWarnings: [],
          },
        ],
      },
    };

    const recovered = recoverStaleAgentTeamTasks(withResult, {
      now,
      staleMs: 60_000,
    });

    expect(recovered.recoveredTaskIds).toEqual([]);
    expect(
      recovered.run.board.tasks.find((task) => task.id === "evidence")?.status
    ).toBe("claimed");
  });

  it("marks automatic dispatch parity partial when auto-dispatched completion lands", () => {
    const run = createInitialAgentTeamRun("auto dispatch parity");
    const completed = completeAgentTeamTask(
      {
        ...run,
        board: {
          ...run.board,
          tasks: run.board.tasks.map((task) =>
            task.id === "frame" ? { ...task, ownerAgentId: run.leadAgentId } : task
          ),
        },
      },
      "frame",
      run.leadAgentId,
      {
        findingClaim: "Auto dispatch result.",
        autoDispatched: true,
      }
    );

    expect(
      completed.run.board.capabilityAudit.find(
        (item) => item.id === "automatic-dispatch"
      )?.digaStatus
    ).toBe("partial");
  });

  it("marks automatic dispatch implemented when until-idle dispatch lands", () => {
    const run = createInitialAgentTeamRun("until idle parity");
    const completed = completeAgentTeamTask(
      {
        ...run,
        board: {
          ...run.board,
          tasks: run.board.tasks.map((task) =>
            task.id === "frame" ? { ...task, ownerAgentId: run.leadAgentId } : task
          ),
        },
      },
      "frame",
      run.leadAgentId,
      {
        findingClaim: "Until idle dispatch result.",
        autoDispatched: true,
        dispatchMode: "until_idle",
      }
    );

    const audit = completed.run.board.capabilityAudit.find(
      (item) => item.id === "automatic-dispatch"
    );
    expect(audit?.digaStatus).toBe("implemented");
    expect(audit?.evidence).toContain("run_until_idle replanned teammate tasks until idle");
  });

  it("blocks required task completion without a finding through TaskCompleted gate", () => {
    const run = createInitialAgentTeamRun("hook gate");
    const result = completeAgentTeamTask(run, "frame", run.leadAgentId);

    expect(result.error).toContain("needs a finding");
    expect(result.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("running");
    expect(result.run.board.events.at(-1)?.type).toBe("quality_gate_failed");
    expect(result.run.board.hooks.find((hook) => hook.id === "hook-task-completed-finding")?.status).toBe("failed");
    expect(result.run.board.capabilityAudit.find((item) => item.id === "quality-hooks")?.digaStatus).toBe("partial");
  });

  it("records non-blocking TaskCompleted hook warnings without blocking completion", () => {
    const run = createInitialAgentTeamRun("hook warning");
    const result = completeAgentTeamTask(run, "frame", run.leadAgentId, {
      findingClaim: "Frame done without explicit evidence.",
    });

    expect(result.error).toBeUndefined();
    expect(result.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("completed");
    expect(result.run.board.hooks.find((hook) => hook.id === "hook-task-completed-evidence")?.status).toBe("failed");
    expect(result.run.board.events.some((event) => event.data?.hookId === "hook-task-completed-evidence")).toBe(true);
  });

  it("evaluates TeammateIdle hooks when the team reaches idle", () => {
    const run = createInitialAgentTeamRun("idle hook");
    const idle = markAgentTeamTeammateIdle({
      ...run,
      board: {
        ...run.board,
        tasks: run.board.tasks.map((task) => ({
          ...task,
          status: "completed" as const,
        })),
      },
    });

    expect(idle.board.hooks.find((hook) => hook.id === "hook-teammate-idle")?.status).toBe("passed");
    expect(idle.board.capabilityAudit.find((item) => item.id === "quality-hooks")?.digaStatus).toBe("implemented");
  });

  it("updates hook configuration and resets hook status", () => {
    const run = createInitialAgentTeamRun("configure hook");
    const updated = updateAgentTeamHook(run, "hook-task-completed-evidence", {
      enabled: false,
    });

    expect(updated.error).toBeUndefined();
    expect(updated.run.board.hooks.find((hook) => hook.id === "hook-task-completed-evidence")?.enabled).toBe(false);
    expect(updated.run.board.capabilityAudit.find((item) => item.id === "quality-hooks")?.digaStatus).toBe("implemented");
  });

  it("marks failed dispatches as retryable blocked tasks", () => {
    const run = createInitialAgentTeamRun("failure recovery");
    const memberId = run.members[1].id;
    const claimed = claimAgentTeamTask(
      {
        ...run,
        members: run.members.map((member, index) =>
          index === 1 ? { ...member, agentId: "child-agent" } : member
        ),
        board: {
          ...run.board,
          tasks: run.board.tasks.map((task) =>
            task.id === "frame"
              ? { ...task, status: "pending" as const, ownerAgentId: undefined, writePaths: ["src/a.ts"] }
              : task
          ),
        },
      },
      "frame",
      memberId
    );
    const failed = failAgentTeamTask(claimed.run, "frame", memberId, "model crashed");

    expect(failed.error).toBeUndefined();
    expect(failed.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("blocked");
    expect(failed.run.board.tasks.find((task) => task.id === "frame")?.lastError).toBe("model crashed");
    expect(failed.run.members.find((member) => member.id === memberId)?.status).toBe("blocked");
    expect(failed.run.board.fileLocks.every((lock) => lock.status === "released")).toBe(true);
  });

  it("retries blocked tasks back to the pending queue", () => {
    const run = createInitialAgentTeamRun("retry recovery");
    const failed = failAgentTeamTask(run, "frame", run.leadAgentId, "temporary failure").run;
    const retried = retryAgentTeamTask(failed, "frame");

    expect(retried.error).toBeUndefined();
    expect(retried.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("pending");
    expect(retried.run.board.tasks.find((task) => task.id === "frame")?.retryCount).toBe(1);
    expect(retried.run.board.events.at(-1)?.type).toBe("task_retried");
  });

  it("replaces a blocked teammate with a fresh session reference", () => {
    const run = createInitialAgentTeamRun("replace teammate");
    const memberId = run.members[1].id;
    const replaced = replaceAgentTeamMember(
      {
        ...run,
        members: run.members.map((member) =>
          member.id === memberId
            ? { ...member, status: "blocked" as const, agentId: "old-agent", failureCount: 2 }
            : member
        ),
      },
      memberId,
      { agentId: "new-agent", sessionFile: "/tmp/new.jsonl", modelId: "m" }
    );

    expect(replaced.error).toBeUndefined();
    expect(replaced.run.members.find((member) => member.id === memberId)?.agentId).toBe("new-agent");
    expect(replaced.run.members.find((member) => member.id === memberId)?.failureCount).toBe(0);
    expect(replaced.run.board.events.at(-1)?.type).toBe("member_replaced");
  });

  it("plans multiple independent dispatches across idle teammates", () => {
    const run = createInitialAgentTeamRun("batch dispatch");
    const expanded = {
      ...run,
      members: run.members.map((member, index) =>
        index > 0 ? { ...member, agentId: `child-${index}` } : member
      ),
      board: {
        ...run.board,
        tasks: [
          {
            ...run.board.tasks[0],
            id: "ux",
            title: "UX review",
            dependsOnTaskIds: [],
            status: "pending" as const,
          },
          {
            ...run.board.tasks[1],
            id: "backend",
            title: "Backend review",
            dependsOnTaskIds: [],
            status: "pending" as const,
          },
          {
            ...run.board.tasks[2],
            id: "tests",
            title: "Test review",
            dependsOnTaskIds: [],
            status: "pending" as const,
          },
        ],
      },
    };

    const plans = createAgentTeamDispatchPlans(expanded, 3);

    expect(plans.map((plan) => plan.task.id).sort()).toEqual(["backend", "tests", "ux"]);
    expect(new Set(plans.map((plan) => plan.memberId)).size).toBe(3);
  });
});

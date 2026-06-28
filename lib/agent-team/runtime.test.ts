import { describe, expect, it } from "vitest";
import { createInitialAgentTeamRun } from "./initial-run";
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
  recoverBlockedAgentTeamRun,
  recordAgentTeamDecision,
  replaceAgentTeamMember,
  resolveAgentTeamChallenge,
  recordAgentTeamToolWrite,
  retryAgentTeamTask,
  sendAgentTeamMessage,
  settleAgentTeamCompletedSynthesis,
  synthesizeAgentTeamFromAvailableWork,
  submitAgentTeamResult,
  transitionAgentTeamRun,
  updateAgentTeamHook,
} from "./runtime";
import { attachAgentTeamDiagnostics } from "./diagnostics";

describe("agent team runtime gates", () => {
  it("blocks finalize while required tasks are incomplete", () => {
    const run = createInitialAgentTeamRun("compare agent teams");
    const result = transitionAgentTeamRun(run, "completed");

    expect(result.blockedReasons.length).toBeGreaterThan(0);
    expect(result.run.status).toBe("running");
    expect(result.run.board.qualityGates.some((gate) => gate.status === "failed")).toBe(true);
    expect(result.run.board.events.at(-1)?.type).toBe("quality_gate_failed");
  });

  it("treats incomplete required tasks as progress, not user blocking, while running", () => {
    const run = createInitialAgentTeamRun("running team progress");
    const result = transitionAgentTeamRun(run, "completed");
    const diagnosed = attachAgentTeamDiagnostics(result.run);

    expect(diagnosed.status).toBe("running");
    expect(
      diagnosed.blockReasons?.some(
        (reason) =>
          reason.code === "quality_gate_failed" &&
          reason.entityRefs.gateId === "gate-required-tasks"
      )
    ).toBe(false);
  });

  it("can summarize available work when a required synthesis task is stuck", () => {
    const run = createInitialAgentTeamRun("stuck organizer");
    const failed = failAgentTeamTask(
      run,
      "synthesis",
      run.leadAgentId,
      "organizer crashed before final answer"
    ).run;

    const blocked = transitionAgentTeamRun(failed, "completed");
    const result = synthesizeAgentTeamFromAvailableWork(blocked.run, {
      reason: "Use current evidence and keep unfinished work as risk.",
    });

    expect(blocked.blockedReasons.join(" ")).toContain("required task");
    expect(result.blockedReasons).toEqual([]);
    expect(result.forcedTaskIds).toContain("synthesis");
    expect(result.run.status).toBe("completed");
    expect(result.run.board.tasks.find((task) => task.id === "synthesis")?.status).toBe("skipped");
    expect(result.run.board.tasks.find((task) => task.id === "synthesis")?.completionSource).toBe("lead_override");
    expect(result.run.board.decisions.at(-1)?.title).toBe("使用已有结果生成最终综合");
  });

  it("archives leftover optional tasks when summarizing with available work", () => {
    const run = createInitialAgentTeamRun("summarize with optional leftovers");
    const withOptional = {
      ...run,
      board: {
        ...run.board,
        tasks: [
          ...run.board.tasks,
          {
            id: "optional-validation",
            title: "Optional validation",
            description: "Optional task should not keep a completed team looking active.",
            status: "pending" as const,
            priority: "normal" as const,
            required: false,
            findingIds: [],
            dependsOnTaskIds: ["synthesis"],
            expectedOutput: "review" as const,
            evidenceRequired: false,
          },
        ],
      },
    };
    const failed = failAgentTeamTask(
      withOptional,
      "synthesis",
      run.leadAgentId,
      "organizer crashed before final answer"
    ).run;

    const result = synthesizeAgentTeamFromAvailableWork(failed, {
      reason: "Use current evidence and keep unfinished work as risk.",
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.board.tasks.find((task) => task.id === "optional-validation")?.status).toBe("skipped");
    expect(result.run.board.tasks.find((task) => task.id === "optional-validation")?.completionSource).toBe("lead_override");
  });

  it("does not expose stale blocking diagnostics after a team is finalized", () => {
    const run = createInitialAgentTeamRun("finalized stale diagnostics");
    const failed = failAgentTeamTask(
      run,
      "synthesis",
      run.leadAgentId,
      "Stream ended without finish_reason"
    ).run;
    const summarized = synthesizeAgentTeamFromAvailableWork(failed, {
      reason: "Finalize with current risks.",
    });
    const withStaleDiagnostics = {
      ...summarized.run,
      board: {
        ...summarized.run.board,
        qualityGates: [
          ...summarized.run.board.qualityGates,
          {
            id: "gate-stale",
            title: "Stale gate",
            status: "failed" as const,
            severity: "blocking" as const,
            message: "Old gate failure should be archived after finalization.",
          },
        ],
      },
    };
    const diagnosed = attachAgentTeamDiagnostics(withStaleDiagnostics);

    expect(diagnosed.status).toBe("completed");
    expect(diagnosed.leadState).toBe("finalized");
    expect(diagnosed.blockReasons).toEqual([]);
  });

  it("archives unfinished optional tasks when a team completes", () => {
    const base = createInitialAgentTeamRun("completed team should be terminal");
    const accepted = {
      ...base,
      board: {
        ...base.board,
        findings: [
          {
            id: "finding-1",
            taskId: "evidence",
            authorAgentId: base.leadAgentId,
            claim: "The target file exists.",
            evidenceRefs: ["file:app/ChatApp.tsx"],
            confidence: "high" as const,
            status: "accepted" as const,
            challengeIds: [],
            provenance: [{ kind: "file" as const, ref: "file:app/ChatApp.tsx" }],
          },
        ],
        decisions: [
          {
            id: "decision-1",
            title: "Final answer",
            rationale: "通过：目标文件存在。",
            acceptedFindingIds: ["finding-1"],
            rejectedFindingIds: [],
            sourceResultIds: ["result-1"],
            evidenceRefs: ["file:app/ChatApp.tsx"],
            challengeIds: [],
            madeByAgentId: base.leadAgentId,
            createdAt: Date.now(),
          },
        ],
        tasks: [
          ...base.board.tasks.map((task) => ({ ...task, status: "completed" as const })),
          {
            id: "optional-review",
            title: "Optional review",
            description: "Optional task that should not remain active after finalize.",
            status: "claimed" as const,
            ownerAgentId: base.members[1]?.id,
            priority: "normal" as const,
            required: false,
            findingIds: [],
            dependsOnTaskIds: ["synthesis"],
            expectedOutput: "review" as const,
            evidenceRequired: false,
          },
        ],
      },
      members: base.members.map((member, index) =>
        index === 1 ? { ...member, status: "working" as const, currentTaskId: "optional-review" } : member
      ),
    };

    const result = transitionAgentTeamRun(accepted, "completed");

    expect(result.run.status).toBe("completed");
    expect(
      result.run.board.tasks.every(
        (task) => task.status === "completed" || task.status === "skipped"
      )
    ).toBe(true);
    expect(result.run.board.tasks.find((task) => task.id === "optional-review")?.status).toBe("skipped");
    expect(result.run.board.tasks.find((task) => task.id === "optional-review")?.completionSource).toBe("lead_override");
    expect(result.run.board.tasks.every((task) => !task.blocker && !task.lastError)).toBe(true);
    expect(result.run.members.find((member) => member.currentTaskId === "optional-review")).toBeUndefined();
  });

  it("keeps diagnostics visible when leadState is finalized but run is not completed", () => {
    const run = createInitialAgentTeamRun("inconsistent finalized state");
    const failed = failAgentTeamTask(
      run,
      "synthesis",
      run.leadAgentId,
      "Stream ended without finish_reason"
    ).run;

    const diagnosed = attachAgentTeamDiagnostics({
      ...failed,
      status: "running",
      leadState: "finalized",
    });

    expect(diagnosed.blockReasons?.some((reason) => reason.code === "provider_stream_error")).toBe(true);
  });

  it("classifies teammate provider auth failures as model/provider errors", () => {
    const run = createInitialAgentTeamRun("provider auth failure");
    const failed = failAgentTeamTask(
      run,
      "frame",
      run.leadAgentId,
      "Dispatch failed: Member model error: No API key for provider: openai-codex"
    ).run;

    const diagnosed = attachAgentTeamDiagnostics(failed);
    const reason = diagnosed.blockReasons?.find((item) => item.code === "provider_stream_error");

    expect(reason?.message).toContain("成员模型调用失败");
    expect(reason?.recommendedAction).toContain("模型");
  });

  it("classifies provider overload failures as model/provider errors", () => {
    const run = createInitialAgentTeamRun("provider overload failure");
    const failed = failAgentTeamTask(
      run,
      "frame",
      run.leadAgentId,
      "Dispatch failed: Member model error: 529 当前服务集群负载较高，请稍后重试。"
    ).run;

    const diagnosed = attachAgentTeamDiagnostics(failed);

    expect(diagnosed.blockReasons?.some((reason) => reason.code === "provider_stream_error")).toBe(true);
  });

  it("does not mask provider failures as missing findings diagnostics", () => {
    const run = createInitialAgentTeamRun("provider ended early");
    const result = submitAgentTeamResult(run, {
      taskId: "frame",
      memberId: run.leadAgentId,
      rawText: "No teammate output was captured.",
      sessionFile: "/tmp/member.jsonl",
    });

    const diagnosed = attachAgentTeamDiagnostics(result.run);
    const taskReasons = diagnosed.blockReasons?.filter((reason) => reason.entityRefs.taskId === "frame") ?? [];

    expect(taskReasons.some((reason) => reason.code === "provider_stream_error")).toBe(true);
    expect(taskReasons.some((reason) => reason.code === "missing_findings")).toBe(false);
    expect(taskReasons.some((reason) => reason.code === "missing_structured_result")).toBe(false);
  });

  it("does not dispatch blocked tasks until recovery moves them back to pending", () => {
    const run = createInitialAgentTeamRun("blocked dispatch");
    const teammateId = run.members[1]!.id;
    const blocked = failAgentTeamTask(
      {
        ...run,
        members: run.members.map((member) =>
          member.id === teammateId ? { ...member, agentId: "child-agent" } : member
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
      teammateId,
      "temporary failure"
    ).run;

    expect(createAgentTeamDispatchPlan(blocked)?.task.id).not.toBe("frame");

    const retried = retryAgentTeamTask(blocked, "frame");
    const redispatchable = {
      ...retried.run,
      members: retried.run.members.map((member) =>
        member.id === teammateId ? { ...member, status: "idle" as const } : member
      ),
    };

    expect(createAgentTeamDispatchPlan(redispatchable)?.task.id).toBe("frame");
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

  it("blocks finalize while agent team worktrees are still active", () => {
    const run = createInitialAgentTeamRun("finalize worktree team", {
      allowWorktree: true,
      worktreePolicy: "per_member",
    });
    const teammate = run.members.find((member) => member.id !== run.leadAgentId)!;
    const ready = {
      ...run,
      leadState: "finalized" as const,
      board: {
        ...run.board,
        tasks: run.board.tasks.map((task) => ({
          ...task,
          status: "completed" as const,
          completedAt: Date.now(),
        })),
      },
      members: run.members.map((member) =>
        member.id === teammate.id
          ? {
              ...member,
              worktree: {
                id: "wt-active",
                path: "/tmp/wt-active",
                branchName: "team/wt-active",
                baseRef: "HEAD",
                status: "active" as const,
                createdAt: Date.now(),
              },
            }
          : member
      ),
    };

    const result = transitionAgentTeamRun(ready, "completed");

    expect(result.run.status).toBe("running");
    expect(result.blockedReasons.join(" ")).toContain("worktree");
    expect(
      result.run.board.qualityGates.find((gate) => gate.id === "gate-worktrees-merged")?.status
    ).toBe("failed");
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

  it("adapts natural-language teammate results in collaboration mode", () => {
    const run = createInitialAgentTeamRun("natural result", { mode: "collaboration" });
    const result = submitAgentTeamResult(run, {
      taskId: "frame",
      memberId: run.leadAgentId,
      rawText: "发现：Agent Team 会根据 lib/agent-team/runtime.ts 中的结果入库逻辑更新 board。",
      sessionFile: "/tmp/member.jsonl",
    });

    expect(result.error).toBeUndefined();
    expect(result.run.board.results[0]?.source).toBe("adapter");
    expect(result.run.board.results[0]?.adaptedFromNaturalLanguage).toBe(true);
    expect(result.run.board.findings.some((finding) =>
      finding.evidenceRefs.includes("file:lib/agent-team/runtime.ts")
    )).toBe(true);
    expect(result.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("completed");
  });

  it("blocks unextractable teammate results for review", () => {
    const run = createInitialAgentTeamRun("bad result");
    const result = submitAgentTeamResult(run, {
      taskId: "frame",
      memberId: run.leadAgentId,
      rawText: "Done.",
    });

    expect(result.error).toContain("待整理");
    expect(result.run.board.results[0]?.status).toBe("needs_review");
    expect(result.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("blocked");
  });

  it("treats captured empty/provider-error teammate output as a recoverable block", () => {
    const run = createInitialAgentTeamRun("provider ended early");
    const result = submitAgentTeamResult(run, {
      taskId: "frame",
      memberId: run.leadAgentId,
      rawText: "No teammate output was captured.",
      sessionFile: "/tmp/member.jsonl",
    });

    expect(result.error).toContain("待整理");
    expect(result.run.board.results[0]?.status).toBe("needs_review");
    expect(result.run.board.results[0]?.summary).toBe("没有拿到可采纳的成员结果。");
    expect(result.run.board.results[0]?.summary).not.toContain("No teammate output");
    expect(result.run.board.results[0]?.parseWarnings.join(" ")).toContain("provider stream ended");
    expect(result.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("blocked");
    expect(result.run.board.tasks.find((task) => task.id === "frame")?.attempts?.at(-1)?.reasonCode).toBe("provider_stream_error");
  });

  it("does not finalize with only system/empty-output findings", () => {
    const run = createInitialAgentTeamRun("empty final");
    const ready = {
      ...run,
      leadState: "finalized" as const,
      board: {
        ...run.board,
        tasks: run.board.tasks.map((task) => ({
          ...task,
          status: "completed" as const,
          completedAt: Date.now(),
        })),
        findings: [
          ...run.board.findings,
          {
            id: "empty-output",
            authorAgentId: run.leadAgentId,
            claim: "No teammate output was captured.",
            evidenceRefs: ["session:/tmp/member.jsonl"],
            confidence: "medium" as const,
            status: "accepted" as const,
            challengeIds: [],
            sourceResultId: "empty-result",
          },
        ],
        decisions: [
          {
            id: "decision-empty",
            title: "Empty decision",
            rationale: "No teammate output was captured.",
            acceptedFindingIds: ["f-mode", "empty-output"],
            rejectedFindingIds: [],
            evidenceRefs: ["session:/tmp/member.jsonl"],
            sourceResultIds: ["empty-result"],
            madeByAgentId: run.leadAgentId,
            status: "accepted" as const,
          },
        ],
      },
    };

    const result = transitionAgentTeamRun(ready, "completed");

    expect(result.run.status).toBe("running");
    expect(result.blockedReasons.join(" ")).toContain("空输出");
  });

  it("finalizes with an explicit risk conclusion when only provider-error results exist", () => {
    const run = createInitialAgentTeamRun("provider risk summary", {
      mode: "collaboration",
    });
    const reviewed = submitAgentTeamResult(run, {
      taskId: "frame",
      memberId: run.leadAgentId,
      rawText: "No teammate output was captured.",
      sessionFile: "/tmp/member.jsonl",
    }).run;

    const summarized = synthesizeAgentTeamFromAvailableWork(reviewed, {
      reason: "用户选择带风险总结。",
    });

    expect(summarized.blockedReasons).toEqual([]);
    expect(summarized.run.status).toBe("completed");
    const finding = summarized.run.board.findings.at(-1);
    const decision = summarized.run.board.decisions.at(-1);
    expect(finding?.claim).toContain("不通过");
    expect(finding?.claim).not.toContain("No teammate output");
    expect(finding?.evidenceRefs).toContain("session:/tmp/member.jsonl");
    expect(finding?.evidenceRefs.some((ref) => ref.startsWith("task:"))).toBe(true);
    expect(decision?.acceptedFindingIds).toContain(finding?.id);
    expect(decision?.rationale).toContain("不通过");
    expect(decision?.rationale).not.toContain("No teammate output");
  });

  it("keeps a substantive finding without evidence refs instead of dropping to the fallback verdict", () => {
    // 复现 issue：子 agent 给了真实结论但没有附 evidence ref。此前 synthesize
    // 因 isSubstantiveFinding 要求必须带 file:/session:/task: ref，把发现整体
    // 丢弃，最终落到“不通过：无法形成可靠结论”的兜底。修复后应保留发现并采纳。
    const base = createInitialAgentTeamRun("审核报告：检查模块逻辑");
    const run = {
      ...base,
      board: {
        ...base.board,
        findings: [
          {
            id: "f-real",
            taskId: "frame",
            authorAgentId: base.leadAgentId,
            claim: "状态机的完成态分支会屏蔽需要裁决与阻塞诊断，属于不合理逻辑。",
            evidenceRefs: [], // 关键：没有 evidence ref
            confidence: "medium" as const,
            status: "proposed" as const,
            challengeIds: [],
          },
        ],
      },
    };

    const summarized = synthesizeAgentTeamFromAvailableWork(run, {
      reason: "用户选择带风险总结。",
    });

    const decision = summarized.run.board.decisions.at(-1);
    // 真实发现被采纳，而不是被忽略后生成兜底 finding。
    expect(decision?.acceptedFindingIds).toContain("f-real");
    expect(decision?.rationale).not.toContain("无法形成可靠结论");
    const acceptedReal = summarized.run.board.findings.find((f) => f.id === "f-real");
    expect(acceptedReal?.status).toBe("accepted");
  });

  it("keeps findings without evidence in both collaboration and audit mode (downgraded, not dropped)", () => {
    // 关键回归：缺 evidence 的实质发现必须进 board（降为 low 置信 + 风险标记），
    // 不能被整体丢弃。此前 audit 模式会把它们卡在 needs_review、findings 不入
    // board，导致最终综合凭空生成 pessimistic 兜底（用户复现的 bug）。
    const collaboration = createInitialAgentTeamRun("collaboration result", {
      mode: "collaboration",
    });
    const audit = createInitialAgentTeamRun("audit result", {
      mode: "audit",
    });
    const rawText = [
      "TEAM_RESULT_JSON:",
      "```json",
      JSON.stringify({
        summary: "Found one real issue.",
        findings: [{ claim: "状态机完成态分支屏蔽了需要裁决的提示。", confidence: "medium" }],
        challenges: [],
        needsFollowUp: [],
      }),
      "```",
    ].join("\n");

    for (const run of [collaboration, audit]) {
      const submitted = submitAgentTeamResult(run, {
        taskId: "frame",
        memberId: run.leadAgentId,
        rawText,
      });
      // 不再丢弃：发现进入 board。
      const boardFinding = submitted.run.board.findings.find((f) =>
        f.claim.includes("状态机完成态分支")
      );
      expect(boardFinding).toBeTruthy();
      // 缺 evidence 降为 low 置信，作为风险提示保留。
      expect(boardFinding?.confidence).toBe("low");
      // result 不再因缺 evidence 被卡 needs_review。
      expect(submitted.run.board.results[0]?.status).toBe("parsed");
    }
  });

  it("still blocks a result that captured no usable teammate output at all", () => {
    // 真正“完全没拿到结果”才阻断，保留 needs_review 语义。
    const run = createInitialAgentTeamRun("no findings", { mode: "audit" });
    const submitted = submitAgentTeamResult(run, {
      taskId: "frame",
      memberId: run.leadAgentId,
      rawText: "No teammate output was captured.",
    });
    expect(submitted.error).toBeTruthy();
    expect(submitted.run.board.results[0]?.status).toBe("needs_review");
    // 没有从这个空结果里新增任何发现（只保留初始的 f-mode 标记）。
    expect(
      submitted.run.board.findings.some((f) => f.sourceResultId)
    ).toBe(false);
  });

  it("recovers retryable blocked tasks with standard reason codes", () => {
    const run = createInitialAgentTeamRun("recover blocked team");
    const failed = failAgentTeamTask(
      run,
      "frame",
      run.leadAgentId,
      "Dispatch failed: Stream ended without finish_reason"
    ).run;

    const recovered = recoverBlockedAgentTeamRun(failed, { now: 200, maxAttempts: 2 });

    expect(recovered.recoveredTaskIds).toContain("frame");
    expect(recovered.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("pending");
    expect(recovered.attempts[0]?.reasonCode).toBe("provider_stream_error");
    expect(recovered.run.recoveryAttempts?.[0]?.status).toBe("succeeded");
    expect(recovered.run.board.events.at(-1)?.message).toBe("成员模型临时中断，已收回任务并准备自动重试。");
  });

  it("keeps provider schema/config errors for user action instead of auto retrying", () => {
    const run = createInitialAgentTeamRun("schema failure team");
    const failed = failAgentTeamTask(
      run,
      "frame",
      run.leadAgentId,
      'Dispatch failed: 500 {"message":"tools.9.custom.input_schema.type: Field required"}'
    ).run;

    const diagnosed = attachAgentTeamDiagnostics(failed);
    const reason = diagnosed.blockReasons?.find((item) => item.code === "provider_stream_error");
    const recovered = recoverBlockedAgentTeamRun(diagnosed, { now: 220, maxAttempts: 2 });

    expect(reason?.message).toBe("成员模型调用失败：当前供应商不接受这次工具参数格式。");
    expect(reason?.autoActions).toEqual([]);
    expect(recovered.recoveredTaskIds).toEqual([]);
    expect(recovered.attempts).toEqual([]);
    expect(recovered.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("blocked");
  });

  it("recovers needs-review natural-language results through the result adapter", () => {
    const run = createInitialAgentTeamRun("adapt blocked result", { mode: "collaboration" });
    const reviewed = submitAgentTeamResult(run, {
      taskId: "frame",
      memberId: run.leadAgentId,
      rawText: "Done.",
    }).run;
    const oldResultId = reviewed.board.results[0]!.id;
    const withNaturalLanguage = {
      ...reviewed,
      board: {
        ...reviewed.board,
        results: reviewed.board.results.map((result) =>
          result.id === oldResultId
            ? {
                ...result,
                rawText: "发现：Team board 会从 lib/agent-team/result-ingestion.ts 整理成员自然语言回复。",
              }
            : result
        ),
      },
    };

    const recovered = recoverBlockedAgentTeamRun(withNaturalLanguage, { now: 300, maxAttempts: 2 });

    expect(recovered.recoveredTaskIds).toContain("frame");
    expect(recovered.attempts[0]?.action).toBe("adapt_result");
    expect(recovered.run.board.tasks.find((task) => task.id === "frame")?.status).toBe("completed");
    expect(recovered.run.board.results.at(-1)?.source).toBe("adapter");
    expect(recovered.run.board.results.find((result) => result.id === oldResultId)?.status).toBe("rejected");
  });

  it("recovers audit natural-language results when task text contains a concrete file target", () => {
    const run = createInitialAgentTeamRun(
      "严格审计验证：只读确认 definitely-not-a-real-file-xyz.ts 是否存在。",
      { mode: "audit" }
    );
    const reviewed = submitAgentTeamResult(run, {
      taskId: "frame",
      memberId: run.leadAgentId,
      rawText: "结论：不存在。没有找到 definitely-not-a-real-file-xyz.ts。",
    }).run;

    expect(reviewed.board.results[0]?.status).toBe("parsed");
    expect(reviewed.board.tasks.find((task) => task.id === "frame")?.status).toBe("completed");
    expect(reviewed.board.findings.at(-1)?.evidenceRefs).toContain(
      "file:definitely-not-a-real-file-xyz.ts"
    );
  });

  it("clears blocked member state when recovering a blocked task for redispatch", () => {
    const run = createInitialAgentTeamRun("recover member state");
    const failed = failAgentTeamTask(
      run,
      "frame",
      run.leadAgentId,
      "Dispatch failed: Stream ended without finish_reason"
    ).run;

    const recovered = recoverBlockedAgentTeamRun(failed, { now: 400, maxAttempts: 2 });

    expect(recovered.recoveredTaskIds).toContain("frame");
    expect(recovered.run.members.find((member) => member.id === run.leadAgentId)?.status).toBe("idle");
    expect(recovered.run.members.find((member) => member.id === run.leadAgentId)?.currentTaskId).toBeUndefined();
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

  it("keeps stopped teams terminal even if a later finalize is requested", () => {
    const run = createInitialAgentTeamRun("stopped stays stopped");
    const stopped = transitionAgentTeamRun(run, "aborted");
    const finalized = transitionAgentTeamRun(stopped.run, "completed");

    expect(finalized.run.status).toBe("aborted");
    expect(finalized.blockedReasons).toContain("Team has already been stopped.");
    expect(finalized.run.board.events.at(-1)?.type).toBe("team_aborted");
  });

  it("does not auto-settle a completed synthesis result after the team was stopped", () => {
    const run = createInitialAgentTeamRun("stopped synthesis should not complete");
    const stopped = transitionAgentTeamRun(run, "aborted").run;
    const withLateSynthesis = {
      ...stopped,
      board: {
        ...stopped.board,
        tasks: stopped.board.tasks.map((task) =>
          task.id === "synthesis"
            ? {
                ...task,
                status: "completed" as const,
                ownerAgentId: stopped.leadAgentId,
                resultId: "late-result",
              }
            : task
        ),
        results: [
          ...stopped.board.results,
          {
            id: "late-result",
            taskId: "synthesis",
            authorAgentId: stopped.leadAgentId,
            status: "parsed" as const,
            summary: "Late synthesis should not revive the team.",
            rawText: "Late synthesis should not revive the team.",
            findingIds: [],
            challengeIds: [],
            evidenceRefs: ["session:current"],
            createdAt: Date.now(),
            parsedAt: Date.now(),
            parseWarnings: [],
          },
        ],
      },
    };

    const settled = settleAgentTeamCompletedSynthesis(withLateSynthesis);

    expect(settled.status).toBe("aborted");
    expect(settled.leadState).not.toBe("finalized");
    expect(settled.board.decisions).toHaveLength(stopped.board.decisions.length);
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

  it("prioritizes synthesis before optional challenge in collaboration mode", () => {
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

    const synthesisPlan = createAgentTeamDispatchPlan(withAgents);

    expect(synthesisPlan?.task.id).toBe("synthesis");
    expect(synthesisPlan?.memberId).toContain(":synthesizer");
    expect(synthesisPlan?.prompt).toContain("final answer to the user's Team objective");
    expect(synthesisPlan?.prompt).toContain("direct conclusion");
  });

  it("keeps challenge before synthesis in audit mode", () => {
    const run = createInitialAgentTeamRun("role matching", { mode: "audit" });
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

  it("does not auto-resolve open challenges in audit mode synthesis", () => {
    const run = createInitialAgentTeamRun("audit synthesis challenge", { mode: "audit" });
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
            reason: "Needs explicit audit resolution.",
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

    expect(submitted.run.status).toBe("running");
    expect(submitted.run.board.challenges.some((challenge) => challenge.status === "open")).toBe(true);
    expect(submitted.run.blockReasons?.some((reason) => reason.code === "open_challenge")).toBe(true);
  });

  it("honors disabled stop conditions during finalize", () => {
    const run = createInitialAgentTeamRun("optional finalize gates", {
      stopConditions: {
        requiredTasksComplete: false,
        noOpenBlockingChallenges: false,
        leadFinalSynthesis: false,
      },
    });

    const result = transitionAgentTeamRun(run, "completed");

    expect(result.blockedReasons).toEqual([]);
    expect(result.run.status).toBe("completed");
    expect(result.run.board.qualityGates.every((gate) => gate.status === "passed")).toBe(true);
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
            required: true,
          },
        ],
      },
    };

    const plans = createAgentTeamDispatchPlans(expanded, 3);

    expect(plans.map((plan) => plan.task.id).sort()).toEqual(["backend", "tests", "ux"]);
    expect(new Set(plans.map((plan) => plan.memberId)).size).toBe(3);
  });
});

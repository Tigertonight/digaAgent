import type {
  AgentTeamChallenge,
  AgentTeamEvent,
  AgentTeamFileLock,
  AgentTeamFinding,
  AgentTeamHook,
  AgentTeamHookTrigger,
  AgentTeamMessage,
  AgentTeamPlan,
  AgentTeamQualityGate,
  AgentTeamResult,
  AgentTeamRun,
  AgentTeamRunStatus,
  AgentTeamTask,
} from "./types";
import { parseAgentTeamResultText } from "./result-ingestion";

export interface AgentTeamFinalizeCheck {
  ok: boolean;
  gates: AgentTeamQualityGate[];
  blockingReasons: string[];
}

export interface AgentTeamDispatchPlan {
  task: AgentTeamTask;
  memberId: string;
  prompt: string;
  mailboxMessages: AgentTeamMessage[];
}

interface AgentTeamHookContext {
  task?: AgentTeamTask;
  memberId?: string;
  findingClaim?: string;
  evidenceRefs?: string[];
}

interface AgentTeamHookCheck {
  hooks: AgentTeamHook[];
  events: AgentTeamEvent[];
  blockingReasons: string[];
}

function normalizePathForLock(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function pathsConflict(a: string, b: string): boolean {
  const left = normalizePathForLock(a);
  const right = normalizePathForLock(b);
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function activeFileLocks(run: AgentTeamRun): AgentTeamFileLock[] {
  return (run.board.fileLocks ?? []).filter((lock) => lock.status === "active");
}

function findFileLockConflict(
  run: AgentTeamRun,
  paths: string[],
  memberId: string
): AgentTeamFileLock | null {
  for (const path of paths) {
    const normalized = normalizePathForLock(path);
    const conflict = activeFileLocks(run).find(
      (lock) =>
        lock.ownerAgentId !== memberId &&
        pathsConflict(lock.path, normalized)
    );
    if (conflict) return conflict;
  }
  return null;
}

function isOpenChallenge(challenge: AgentTeamChallenge): boolean {
  return challenge.status === "open" || challenge.status === "needs_evidence";
}

function isAcceptedForDecision(run: AgentTeamRun, finding: AgentTeamFinding): boolean {
  if (finding.status === "accepted") return true;
  if (finding.status !== "challenged" || !finding.acceptedByAgentId) return false;
  return finding.challengeIds.every((id) =>
    run.board.challenges.some(
      (challenge) =>
        challenge.id === id &&
        (challenge.status === "resolved" || challenge.status === "dismissed")
    )
  );
}

function acceptedFindings(run: AgentTeamRun): AgentTeamFinding[] {
  return run.board.findings.filter((finding) => isAcceptedForDecision(run, finding));
}

function acceptedDecisions(run: AgentTeamRun) {
  return run.board.decisions.filter((decision) => (decision.status ?? "accepted") === "accepted");
}

function makeEvent(
  run: AgentTeamRun,
  type: AgentTeamEvent["type"],
  message: string,
  data?: Record<string, unknown>
): AgentTeamEvent {
  return {
    id: `${run.id}:event:${Date.now()}:${run.board.events.length + 1}`,
    type,
    at: Date.now(),
    actorAgentId: run.leadAgentId,
    message,
    ...(data ? { data } : {}),
  };
}

function eventWithActor(
  run: AgentTeamRun,
  type: AgentTeamEvent["type"],
  actorAgentId: string,
  message: string,
  data?: Record<string, unknown>
): AgentTeamEvent {
  return {
    ...makeEvent(run, type, message, data),
    actorAgentId,
  };
}

function updateCapability(
  run: AgentTeamRun,
  id: string,
  patch: {
    status?: AgentTeamRun["board"]["capabilityAudit"][number]["digaStatus"];
    gap?: string;
    nextStep?: string;
    evidence?: string;
  }
): AgentTeamRun["board"]["capabilityAudit"] {
  return run.board.capabilityAudit.map((item) =>
    item.id === id
      ? {
          ...item,
          ...(patch.status ? { digaStatus: patch.status } : {}),
          ...(patch.gap ? { gap: patch.gap } : {}),
          ...(patch.nextStep ? { nextStep: patch.nextStep } : {}),
          ...(patch.evidence && !item.evidence.includes(patch.evidence)
            ? { evidence: [...item.evidence, patch.evidence] }
            : {}),
        }
      : item
  );
}

function dependenciesComplete(run: AgentTeamRun, taskId: string): boolean {
  const task = run.board.tasks.find((item) => item.id === taskId);
  if (!task?.dependsOnTaskIds?.length) return true;
  const completed = new Set(
    run.board.tasks
      .filter((item) => item.status === "completed")
      .map((item) => item.id)
  );
  return task.dependsOnTaskIds.every((id) => completed.has(id));
}

function runnableTasks(run: AgentTeamRun): AgentTeamTask[] {
  return run.board.tasks
    .filter((task) =>
      (task.status === "pending" || task.status === "blocked") &&
      dependenciesComplete(run, task.id)
    )
    .sort((a, b) => {
      const prio = (task: AgentTeamTask) =>
        task.priority === "high" ? 0 : task.priority === "normal" ? 1 : 2;
      return prio(a) - prio(b);
    });
}

export function recoverStaleAgentTeamTasks(
  run: AgentTeamRun,
  opts: { now?: number; staleMs?: number } = {}
): { run: AgentTeamRun; recoveredTaskIds: string[] } {
  const now = opts.now ?? Date.now();
  const staleMs = Math.max(1, opts.staleMs ?? 2 * 60 * 1000);
  const recoveredTaskIds: string[] = [];
  const nextTasks = run.board.tasks.map((task) => {
    if (task.status !== "claimed" && task.status !== "running") return task;
    const lastTouched = task.claimedAt ?? run.updatedAt ?? run.createdAt;
    if (now - lastTouched < staleMs) return task;
    const hasResult = (run.board.results ?? []).some((result) => result.taskId === task.id);
    if (hasResult) return task;
    recoveredTaskIds.push(task.id);
    return {
      ...task,
      status: dependenciesComplete(run, task.id) ? ("pending" as const) : ("blocked" as const),
      ownerAgentId: undefined,
      blocker: dependenciesComplete(run, task.id)
        ? undefined
        : `Waiting for dependencies: ${(task.dependsOnTaskIds ?? []).join(", ")}`,
      lastError: "Recovered stale task without teammate result.",
      retryCount: (task.retryCount ?? 0) + 1,
    };
  });
  if (recoveredTaskIds.length === 0) return { run, recoveredTaskIds };
  const recoveredSet = new Set(recoveredTaskIds);
  const nextEvents = [
    ...run.board.events,
    ...recoveredTaskIds.map((taskId) => ({
      ...makeEvent(run, "task_retried", `Recovered stale task ${taskId} for automatic redispatch.`, {
        staleMs,
      }),
      taskId,
    })),
  ];
  return {
    recoveredTaskIds,
    run: refreshAgentTeamQualityGates(patchAgentTeamRun(run, {
      board: {
        ...run.board,
        tasks: nextTasks,
        events: nextEvents,
      },
      members: run.members.map((member) =>
        member.currentTaskId && recoveredSet.has(member.currentTaskId)
          ? {
              ...member,
              status: "idle" as const,
              currentTaskId: undefined,
              failureCount: (member.failureCount ?? 0) + 1,
              latestOutput: "之前的任务没有返回结果，已交回队列等待自动重派。",
              lastActiveAt: now,
            }
          : member
      ),
    })),
  };
}

export function completeAgentTeamInitialFrame(run: AgentTeamRun): AgentTeamRun {
  const frame = run.board.tasks.find((task) => task.id === "frame");
  if (!frame || frame.status === "completed") return run;
  const frameFindings = run.board.findings.filter(
    (finding) =>
      finding.taskId === frame.id &&
      finding.evidenceRefs.length > 0 &&
      (finding.status === "accepted" || finding.status === "proposed")
  );
  if (frameFindings.length === 0) return run;
  const now = Date.now();
  const events: AgentTeamEvent[] = [
    ...run.board.events,
    {
      ...eventWithActor(
        run,
        "task_completed",
        run.leadAgentId,
        "Lead completed initial Team framing."
      ),
      taskId: frame.id,
    },
  ];
  const intermediate: AgentTeamRun = {
    ...run,
    board: {
      ...run.board,
      tasks: run.board.tasks.map((task) =>
        task.id === frame.id
          ? {
              ...task,
              status: "completed" as const,
              ownerAgentId: task.ownerAgentId ?? run.leadAgentId,
              completedAt: now,
              findingIds: Array.from(new Set([...task.findingIds, ...frameFindings.map((finding) => finding.id)])),
              blocker: undefined,
            }
          : task
      ),
    },
  };
  return refreshAgentTeamQualityGates(patchAgentTeamRun(run, {
    board: {
      ...run.board,
      tasks: unblockReadyTasks(intermediate, events),
      events,
      capabilityAudit: updateCapability(run, "shared-task-list", {
        status: "partial",
        evidence: "initial Team frame completed from board evidence",
        gap: "已支持启动后自动完成 Lead framing 并解锁首个成员任务。",
        nextStep: "继续补强多成员协作和失败恢复体验。",
      }),
    },
    members: run.members.map((member) =>
      member.id === run.leadAgentId && member.currentTaskId === frame.id
        ? {
            ...member,
            status: "idle" as const,
            currentTaskId: undefined,
            latestOutput: "已界定目标和协作方式，团队开始自动分工。",
            lastActiveAt: now,
          }
        : member
    ),
  }));
}

function idleTeammates(run: AgentTeamRun): string[] {
  return run.members
    .filter((member) =>
      member.id !== run.leadAgentId &&
      member.status !== "blocked" &&
      member.status !== "working" &&
      Boolean(member.agentId)
    )
    .map((member) => member.id);
}

function teammateScoreForTask(run: AgentTeamRun, task: AgentTeamTask, memberId: string): number {
  const member = run.members.find((item) => item.id === memberId);
  if (!member) return 0;
  const failurePenalty = (member.failureCount ?? 0) * 70;
  const taskText = `${task.id} ${task.title} ${task.description} ${task.expectedOutput ?? ""}`.toLowerCase();
  const roleText = `${member.role} ${member.name}`.toLowerCase();
  if (/synthesis|decision|综合|决策|final/.test(taskText)) {
    if (/综合|结构|synth|裁判|lead|决策/.test(roleText)) return 100 - failurePenalty;
    if (member.id === run.leadAgentId) return 80 - failurePenalty;
    return 10 - failurePenalty;
  }
  if (/challenge|review|critic|挑战|反证|质疑/.test(taskText)) {
    if (/挑战|反证|critic|review/.test(roleText)) return 100 - failurePenalty;
    if (/验收|核查|validator/.test(roleText)) return 60 - failurePenalty;
    if (member.id === run.leadAgentId) return 20 - failurePenalty;
    return 5 - failurePenalty;
  }
  if (/evidence|finding|research|证据|调研|收集|发现/.test(taskText)) {
    if (/资料|证据|research/.test(roleText)) return 100 - failurePenalty;
    if (/验收|核查|validator/.test(roleText)) return 60 - failurePenalty;
    return 20 - failurePenalty;
  }
  if (/validate|验收|核查/.test(taskText)) {
    if (/验收|核查|validator/.test(roleText)) return 100 - failurePenalty;
    if (/挑战|反证|critic/.test(roleText)) return 50 - failurePenalty;
    return 10 - failurePenalty;
  }
  return 25 - failurePenalty;
}

function selectIdleTeammateForTask(
  run: AgentTeamRun,
  task: AgentTeamTask,
  candidates = idleTeammates(run)
): string | undefined {
  return [...candidates].sort((left, right) => {
    const score = teammateScoreForTask(run, task, right) - teammateScoreForTask(run, task, left);
    if (score !== 0) return score;
    return candidates.indexOf(left) - candidates.indexOf(right);
  })[0];
}

function evaluateHookRule(
  run: AgentTeamRun,
  hook: AgentTeamHook,
  context: AgentTeamHookContext
): string | null {
  if (hook.rule === "required_task_needs_finding") {
    return context.task?.required && !context.findingClaim?.trim()
      ? `${context.task.title} is required and needs a finding before completion.`
      : null;
  }
  if (hook.rule === "task_needs_evidence") {
    return context.task && (context.evidenceRefs ?? []).length === 0
      ? `${context.task.title} completed without evidence refs.`
      : null;
  }
  if (hook.rule === "idle_requires_no_runnable_tasks") {
    const runnable = runnableTasks(run).filter((task) => task.status !== "completed");
    return runnable.length > 0
      ? `${runnable.length} runnable task(s) remain while teammate idle was evaluated.`
      : null;
  }
  return null;
}

export function evaluateAgentTeamHooks(
  run: AgentTeamRun,
  trigger: AgentTeamHookTrigger,
  context: AgentTeamHookContext = {}
): AgentTeamHookCheck {
  const now = Date.now();
  const events: AgentTeamEvent[] = [];
  const blockingReasons: string[] = [];
  const hooks = (run.board.hooks ?? []).map((hook) => {
    if (!hook.enabled || hook.trigger !== trigger) return hook;
    const failure = evaluateHookRule(run, hook, context);
    if (!failure) {
      return {
        ...hook,
        status: "passed" as const,
        lastCheckedAt: now,
        lastFailure: undefined,
      };
    }
    const nextHook = {
      ...hook,
      status: "failed" as const,
      lastCheckedAt: now,
      lastFailure: failure,
    };
    if (hook.severity === "blocking") blockingReasons.push(failure);
    events.push({
      ...eventWithActor(
        run,
        "quality_gate_failed",
        context.memberId ?? run.leadAgentId,
        `${hook.title}: ${failure}`,
        { hookId: hook.id, trigger, severity: hook.severity }
      ),
      taskId: context.task?.id,
    });
    return nextHook;
  });
  return { hooks, events, blockingReasons };
}

export function createAgentTeamDispatchPlan(run: AgentTeamRun): AgentTeamDispatchPlan | null {
  const task = runnableTasks(run)[0];
  const memberId = task ? selectIdleTeammateForTask(run, task) : undefined;
  if (!task || !memberId) return null;
  const mailboxMessages = run.board.messages.filter(
    (message) =>
      !message.toAgentId ||
      message.toAgentId === memberId ||
      message.taskId === task.id
  );
  const prompt = [
    `You are a teammate in an Agent Team run.`,
    `Team objective: ${run.objective}`,
    `Your member id: ${memberId}`,
    `Task id: ${task.id}`,
    `Task title: ${task.title}`,
    `Task description: ${task.description}`,
    "",
    "Relevant mailbox messages:",
    ...(mailboxMessages.length > 0
      ? mailboxMessages.map((message) => `- ${message.fromAgentId}: ${message.body}`)
      : ["- (none)"]),
    "",
    "Current board context:",
    ...run.board.results.slice(-6).map((result) =>
      `- result ${result.id} (${result.taskId}, ${result.status}): ${result.summary}`
    ),
    ...run.board.findings.slice(-12).map((finding) =>
      `- finding ${finding.id} [${finding.status}] (${finding.confidence}): ${finding.claim} evidence=${finding.evidenceRefs.join(", ") || "(none)"}`
    ),
    ...run.board.challenges.slice(-8).map((challenge) =>
      `- challenge ${challenge.id} [${challenge.status}] target=${challenge.targetFindingId}: ${challenge.reason}`
    ),
    "",
    task.expectedOutput === "decision_input"
      ? [
          "For synthesis: write the summary as the final answer to the user's Team objective, not as an internal process report.",
          "Start with the direct conclusion, then summarize the strongest reasons and any remaining caveats or next steps.",
          "Use proposed and accepted findings plus resolved/open challenges above to make a traceable decision.",
          "Do not refuse merely because Lead has not accepted findings yet; the Team runtime will accept/resolve after your synthesis if your result cites evidence.",
          "Avoid wording like 'cannot form a decision because no accepted findings exist' when there are usable results/findings in the board.",
        ].join(" ")
      : "Use the board context to avoid repeating previous work and to challenge or refine existing findings.",
    "",
    "Return a concise task result with evidence. If you find a risk, include it explicitly.",
    "Use the TEAM_RESULT_JSON contract exactly so the Team board can ingest your real output.",
  ].join("\n");
  return { task, memberId, prompt, mailboxMessages };
}

export function createAgentTeamDispatchPlans(
  run: AgentTeamRun,
  limit: number
): AgentTeamDispatchPlan[] {
  const safeLimit = Math.max(1, Math.min(8, Math.floor(limit)));
  const tasks = runnableTasks(run);
  const members = idleTeammates(run);
  if (members.length === 0 || tasks.length === 0) {
    const fallback = createAgentTeamDispatchPlan(run);
    return fallback ? [fallback] : [];
  }
  const plans: AgentTeamDispatchPlan[] = [];
  const usedTasks = new Set<string>();
  const usedMembers = new Set<string>();
  for (const task of tasks) {
    const memberId = selectIdleTeammateForTask(
      run,
      task,
      members.filter((id) => !usedMembers.has(id))
    );
    if (!memberId) break;
    if (usedTasks.has(task.id)) continue;
    const single = createAgentTeamDispatchPlan({
      ...run,
      board: {
        ...run.board,
        tasks: run.board.tasks.map((item) =>
          usedTasks.has(item.id) ? { ...item, status: "claimed" as const } : item
        ),
      },
      members: run.members.map((member) =>
        usedMembers.has(member.id)
          ? { ...member, status: "working" as const }
          : member
      ),
    });
    if (!single || single.task.id !== task.id) continue;
    plans.push({ ...single, memberId });
    usedTasks.add(task.id);
    usedMembers.add(memberId);
    if (plans.length >= safeLimit) break;
  }
  return plans;
}

function unblockReadyTasks(run: AgentTeamRun, events: AgentTeamEvent[]): AgentTeamRun["board"]["tasks"] {
  return run.board.tasks.map((task) => {
    if (task.status !== "blocked") return task;
    if (!dependenciesComplete(run, task.id)) return task;
    events.push({
      ...makeEvent(run, "task_unblocked", `${task.title} dependencies are complete.`),
      taskId: task.id,
    });
    return {
      ...task,
      status: "pending" as const,
      blocker: undefined,
    };
  });
}

export function evaluateAgentTeamFinalize(run: AgentTeamRun): AgentTeamFinalizeCheck {
  const now = Date.now();
  const requiredIncomplete = run.board.tasks.filter(
    (task) => task.required && task.status !== "completed"
  );
  const openBlockingChallenges = run.board.challenges.filter(isOpenChallenge);
  const decisions = acceptedDecisions(run);
  const hasTraceableDecision = decisions.some(
    (decision) =>
      decision.acceptedFindingIds.some((id) =>
        run.board.findings.some((finding) => finding.id === id && isAcceptedForDecision(run, finding))
      ) &&
      (decision.evidenceRefs?.length || decision.sourceResultIds?.length)
  );
  const leadReady = run.leadState === "finalized" || hasTraceableDecision;

  const gates: AgentTeamQualityGate[] = run.board.qualityGates.map((gate) => {
    if (gate.id === "gate-required-tasks") {
      return {
        ...gate,
        status: requiredIncomplete.length === 0 ? "passed" : "failed",
        checkedAt: now,
        relatedTaskIds: requiredIncomplete.map((task) => task.id),
        message:
          requiredIncomplete.length === 0
            ? "所有 required tasks 已完成。"
            : `仍有 ${requiredIncomplete.length} 个 required task 未完成。`,
      };
    }
    if (gate.id === "gate-open-challenges") {
      return {
        ...gate,
        status: openBlockingChallenges.length === 0 ? "passed" : "failed",
        checkedAt: now,
        relatedChallengeIds: openBlockingChallenges.map((challenge) => challenge.id),
        message:
          openBlockingChallenges.length === 0
            ? "没有开放的 blocking challenge。"
            : `仍有 ${openBlockingChallenges.length} 个 challenge 未解决。`,
      };
    }
    if (gate.id === "gate-lead-synthesis") {
      return {
        ...gate,
        status: leadReady ? "passed" : "failed",
        checkedAt: now,
        message: leadReady
          ? "Lead 已形成带 evidence / finding 追溯的最终综合判断。"
          : "Lead 尚未形成可追溯最终综合判断。",
      };
    }
    return gate;
  });
  const blockingReasons = gates
    .filter((gate) => gate.severity === "blocking" && gate.status === "failed")
    .map((gate) => gate.message);

  return {
    ok: blockingReasons.length === 0,
    gates,
    blockingReasons,
  };
}

function refreshAgentTeamQualityGates(run: AgentTeamRun): AgentTeamRun {
  const check = evaluateAgentTeamFinalize(run);
  return patchAgentTeamRun(run, {
    board: {
      ...run.board,
      qualityGates: check.gates,
    },
  });
}

export function patchAgentTeamRun(
  run: AgentTeamRun,
  patch: Partial<AgentTeamRun>
): AgentTeamRun {
  return {
    ...run,
    ...patch,
    board: patch.board ?? run.board,
    members: patch.members ?? run.members,
    settings: patch.settings ?? run.settings,
    updatedAt: patch.updatedAt ?? Date.now(),
  };
}

export function transitionAgentTeamRun(
  run: AgentTeamRun,
  status: AgentTeamRunStatus
): { run: AgentTeamRun; blockedReasons: string[] } {
  const now = Date.now();
  if (status === "completed") {
    const check = evaluateAgentTeamFinalize(run);
    if (!check.ok) {
      const event = makeEvent(run, "quality_gate_failed", "Finalize blocked by quality gates.", {
        blockingReasons: check.blockingReasons,
      });
      return {
        run: patchAgentTeamRun(run, {
          status: "running",
          board: {
            ...run.board,
            qualityGates: check.gates,
            events: [...run.board.events, event],
          },
        }),
        blockedReasons: check.blockingReasons,
      };
    }
    return {
      run: patchAgentTeamRun(run, {
        status: "completed",
        leadState: "finalized",
        endedAt: now,
        board: {
          ...run.board,
          qualityGates: check.gates,
          events: [
            ...run.board.events,
            makeEvent(run, "team_finalized", "Team finalized after all quality gates passed."),
          ],
        },
      }),
      blockedReasons: [],
    };
  }

  const type =
    status === "paused"
      ? "team_paused"
      : status === "running"
        ? "team_resumed"
        : status === "aborted"
          ? "team_aborted"
          : "team_resumed";
  const releasedLocks =
    status === "aborted"
      ? (run.board.fileLocks ?? []).map((lock) =>
          lock.status === "active"
            ? { ...lock, status: "released" as const, releasedAt: now }
            : lock
        )
      : run.board.fileLocks;
  const releasedLockEvents =
    status === "aborted"
      ? (run.board.fileLocks ?? [])
          .filter((lock) => lock.status === "active")
          .map((lock) => ({
            ...makeEvent(run, "file_lock_released", `Released ${lock.path} during Team shutdown.`, {
              lockId: lock.id,
            }),
            taskId: lock.taskId,
            targetAgentId: lock.ownerAgentId,
          }))
      : [];
  return {
    run: patchAgentTeamRun(run, {
      status,
      ...(status === "aborted" ? { endedAt: now } : {}),
      board: {
        ...run.board,
        fileLocks: releasedLocks,
        capabilityAudit:
          status === "aborted"
            ? updateCapability(run, "shutdown-cleanup", {
                status: "implemented",
                evidence: "team shutdown released file locks",
                gap: "已支持 Team stop 时释放 board 资源；API 层会请求中止 teammate session。",
                nextStep: "补 teammate replacement 与更细粒度的退出报告。",
              })
            : run.board.capabilityAudit,
        events: [
          ...run.board.events,
          ...releasedLockEvents,
          makeEvent(run, type, `Team status changed to ${status}.`),
        ],
      },
      members:
        status === "aborted"
          ? run.members.map((member) =>
              member.status === "working"
                ? {
                    ...member,
                    status: "done" as const,
                    currentTaskId: undefined,
                    latestOutput: "Team stopped; teammate work was shut down.",
                    lastActiveAt: now,
                  }
                : member
            )
          : run.members,
    }),
    blockedReasons: [],
  };
}

export function claimAgentTeamTask(
  run: AgentTeamRun,
  taskId: string,
  memberId: string,
  opts: {
    writePaths?: string[];
  } = {}
): { run: AgentTeamRun; error?: string } {
  const now = Date.now();
  const task = run.board.tasks.find((item) => item.id === taskId);
  const member = run.members.find((item) => item.id === memberId);
  if (!task) return { run, error: "task not found" };
  if (!member) return { run, error: "member not found" };
  if (task.status === "completed") return { run, error: "task already completed" };
  if (!dependenciesComplete(run, taskId)) {
    const blocker = `Waiting for dependencies: ${(task.dependsOnTaskIds ?? []).join(", ")}`;
    const nextTasks = run.board.tasks.map((item) =>
      item.id === taskId ? { ...item, status: "blocked" as const, blocker } : item
    );
    return {
      run: patchAgentTeamRun(run, {
        board: {
          ...run.board,
          tasks: nextTasks,
          events: [
            ...run.board.events,
            {
              ...eventWithActor(run, "task_blocked", memberId, `${task.title} is blocked.`, {
                blocker,
              }),
              taskId,
            },
          ],
        },
      }),
      error: blocker,
    };
  }
  const requestedWritePaths = [
    ...(task.writePaths ?? []),
    ...(opts.writePaths ?? []),
  ]
    .map(normalizePathForLock)
    .filter(Boolean);
  const conflict = findFileLockConflict(run, requestedWritePaths, memberId);
  if (conflict) {
    const blocker = `Waiting for file lock: ${conflict.path} is held by ${conflict.ownerAgentId}`;
    const nextTasks = run.board.tasks.map((item) =>
      item.id === taskId ? { ...item, status: "blocked" as const, blocker } : item
    );
    return {
      run: patchAgentTeamRun(run, {
        board: {
          ...run.board,
          tasks: nextTasks,
          capabilityAudit: updateCapability(run, "file-locking", {
            status: "implemented",
            evidence: "claim blocked by active file lock",
            gap: "已支持 Team board 级 file lock 与冲突阻塞；后续可接入真实工具调用写入前校验。",
            nextStep: "把编辑工具的目标文件自动映射到 Team fileLocks。",
          }),
          events: [
            ...run.board.events,
            {
              ...eventWithActor(run, "task_blocked", memberId, `${task.title} is blocked by file lock.`, {
                blocker,
                conflict,
              }),
              taskId,
            },
          ],
        },
      }),
      error: blocker,
    };
  }
  const newLocks: AgentTeamFileLock[] = requestedWritePaths.map((path, index) => ({
    id: `${run.id}:lock:${taskId}:${memberId}:${now}:${index}`,
    path,
    ownerAgentId: memberId,
    taskId,
    status: "active",
    acquiredAt: now,
  }));

  const nextTasks = run.board.tasks.map((item) =>
    item.id === taskId
      ? {
          ...item,
          status: "claimed" as const,
          ownerAgentId: memberId,
          claimedAt: now,
          writePaths: requestedWritePaths.length > 0 ? requestedWritePaths : item.writePaths,
          blocker: undefined,
        }
      : item
  );
  const nextMembers = run.members.map((item) =>
    item.id === memberId
      ? {
          ...item,
          status: "working" as const,
          currentTaskId: taskId,
          latestOutput: `已认领任务：${task.title}`,
          lastActiveAt: now,
        }
      : item
  );
  return {
    run: refreshAgentTeamQualityGates(patchAgentTeamRun(run, {
      board: {
        ...run.board,
        tasks: nextTasks,
        fileLocks: [...(run.board.fileLocks ?? []), ...newLocks],
        capabilityAudit: updateCapability(run, "shared-task-list", {
          status: "partial",
          evidence: "task claim API exercised",
          gap: "已支持任务认领/完成/依赖解锁协议，尚未由 teammate 自动循环认领。",
          nextStep: "让 hidden teammate 从 task queue 自动 claim 并执行。",
        }).map((item) =>
          item.id === "file-locking" && newLocks.length > 0
            ? {
                ...item,
                digaStatus: "implemented",
                evidence: item.evidence.includes("claim acquired Team file locks")
                  ? item.evidence
                  : [...item.evidence, "claim acquired Team file locks"],
                gap: "已支持 Team board 级 file lock 与冲突阻塞；后续可接入真实工具调用写入前校验。",
                nextStep: "把编辑工具的目标文件自动映射到 Team fileLocks。",
              }
            : item
        ),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(run, "task_claimed", memberId, `${member.name} claimed ${task.title}.`),
            taskId,
          },
          ...newLocks.map((lock) => ({
            ...eventWithActor(run, "file_lock_acquired", memberId, `${member.name} locked ${lock.path}.`, {
              lockId: lock.id,
            }),
            taskId,
          })),
        ],
      },
      members: nextMembers,
    })),
  };
}

export function recordAgentTeamToolWrite(
  run: AgentTeamRun,
  memberId: string,
  paths: string[]
): { run: AgentTeamRun; error?: string } {
  const now = Date.now();
  const member = run.members.find((item) => item.id === memberId);
  if (!member) return { run, error: "member not found" };
  const taskId = member.currentTaskId;
  if (!taskId) return { run };
  const task = run.board.tasks.find((item) => item.id === taskId);
  if (!task || task.status === "completed") return { run };
  const requestedWritePaths = paths.map(normalizePathForLock).filter(Boolean);
  if (requestedWritePaths.length === 0) return { run };
  const conflict = findFileLockConflict(run, requestedWritePaths, memberId);
  if (conflict) {
    const blocker = `Waiting for file lock: ${conflict.path} is held by ${conflict.ownerAgentId}`;
    return {
      run: patchAgentTeamRun(run, {
        board: {
          ...run.board,
          tasks: run.board.tasks.map((item) =>
            item.id === taskId
              ? {
                  ...item,
                  status: "blocked" as const,
                  blocker,
                  lastError: blocker,
                }
              : item
          ),
          capabilityAudit: updateCapability(run, "file-locking", {
            status: "implemented",
            evidence: "write tool blocked by Team file lock",
            gap: "已支持写入工具调用前自动上报路径并阻止冲突写入。",
            nextStep: "把更多非标准写入工具的路径 schema 纳入提取器。",
          }),
          events: [
            ...run.board.events,
            {
              ...eventWithActor(run, "task_blocked", memberId, `${task.title} is blocked by file lock.`, {
                blocker,
                conflict,
                requestedWritePaths,
              }),
              taskId,
            },
          ],
        },
        members: run.members.map((item) =>
          item.id === memberId
            ? {
                ...item,
                status: "blocked" as const,
                latestOutput: blocker,
                lastActiveAt: now,
              }
            : item
        ),
      }),
      error: blocker,
    };
  }

  const existingActive = activeFileLocks(run).filter(
    (lock) => lock.ownerAgentId === memberId && lock.taskId === taskId
  );
  const newPaths = requestedWritePaths.filter(
    (target) => !existingActive.some((lock) => pathsConflict(lock.path, target))
  );
  if (newPaths.length === 0) return { run };
  const newLocks: AgentTeamFileLock[] = newPaths.map((path, index) => ({
    id: `${run.id}:lock:${taskId}:${memberId}:tool:${now}:${index}`,
    path,
    ownerAgentId: memberId,
    taskId,
    status: "active",
    acquiredAt: now,
  }));
  const nextTaskWritePaths = Array.from(
    new Set([...(task.writePaths ?? []), ...requestedWritePaths])
  );
  return {
    run: refreshAgentTeamQualityGates(patchAgentTeamRun(run, {
      board: {
        ...run.board,
        fileLocks: [...(run.board.fileLocks ?? []), ...newLocks],
        tasks: run.board.tasks.map((item) =>
          item.id === taskId
            ? {
                ...item,
                writePaths: nextTaskWritePaths,
              }
            : item
        ),
        capabilityAudit: updateCapability(run, "file-locking", {
          status: "implemented",
          evidence: "write tool acquired Team file locks",
          gap: "已支持写入工具调用前自动上报路径并进入 Team locks。",
          nextStep: "把更多非标准写入工具的路径 schema 纳入提取器。",
        }),
        events: [
          ...run.board.events,
          ...newLocks.map((lock) => ({
            ...eventWithActor(run, "file_lock_acquired", memberId, `${member.name} locked ${lock.path} from tool call.`, {
              lockId: lock.id,
              source: "tool_call",
            }),
            taskId,
          })),
        ],
      },
      members: run.members.map((item) =>
        item.id === memberId
          ? {
              ...item,
              lastActiveAt: now,
            }
          : item
      ),
    })),
  };
}

export function completeAgentTeamTask(
  run: AgentTeamRun,
  taskId: string,
  memberId: string,
  opts: {
    findingClaim?: string;
    evidenceRefs?: string[];
    confidence?: AgentTeamFinding["confidence"];
    autoDispatched?: boolean;
    dispatchMode?: "single" | "batch" | "until_idle";
    sourceResultId?: string;
  } = {}
): { run: AgentTeamRun; error?: string } {
  const now = Date.now();
  const task = run.board.tasks.find((item) => item.id === taskId);
  const member = run.members.find((item) => item.id === memberId);
  if (!task) return { run, error: "task not found" };
  if (!member) return { run, error: "member not found" };
  if (task.ownerAgentId && task.ownerAgentId !== memberId) {
    return { run, error: "task owned by another member" };
  }
  const hookCheck = evaluateAgentTeamHooks(run, "TaskCompleted", {
    task,
    memberId,
    findingClaim: opts.findingClaim,
    evidenceRefs: opts.evidenceRefs,
  });
  if (hookCheck.blockingReasons.length > 0) {
    const message = hookCheck.blockingReasons.join("; ");
    return {
      run: patchAgentTeamRun(run, {
        board: {
          ...run.board,
          hooks: hookCheck.hooks,
          capabilityAudit: updateCapability(run, "quality-hooks", {
            status: "partial",
            evidence: "TaskCompleted hook registry blocked completion",
            gap: "已支持内置 Team hook registry，尚未支持用户自定义 hook 脚本。",
            nextStep: "在 Workspace 暴露 hook 状态，并支持用户添加规则。",
          }),
          events: [...run.board.events, ...hookCheck.events],
        },
      }),
      error: message,
    };
  }
  const existingResultFindings = opts.sourceResultId
    ? run.board.findings.filter((finding) => finding.sourceResultId === opts.sourceResultId)
    : [];
  const finding: AgentTeamFinding | null = opts.findingClaim?.trim() && existingResultFindings.length === 0
    ? {
        id: `${taskId}:finding:${now}`,
        taskId,
        authorAgentId: memberId,
        claim: opts.findingClaim.trim(),
        evidenceRefs: opts.evidenceRefs ?? [],
        confidence: opts.confidence ?? "medium",
        status: "proposed",
        challengeIds: [],
        sourceResultId: opts.sourceResultId,
        provenance: [
          ...(opts.sourceResultId
            ? [{ kind: "result" as const, ref: opts.sourceResultId }]
            : []),
          ...(opts.evidenceRefs ?? []).map((ref) => ({
            kind: ref.startsWith("file:")
              ? "file" as const
              : ref.startsWith("session:")
                ? "session" as const
                : "artifact" as const,
            ref,
          })),
        ],
      }
    : null;
  const findingIds = Array.from(
    new Set([
      ...task.findingIds,
      ...existingResultFindings.map((item) => item.id),
      ...(finding ? [finding.id] : []),
    ])
  );
  const completedTasks = run.board.tasks.map((item) =>
    item.id === taskId
      ? {
          ...item,
        status: "completed" as const,
        ownerAgentId: memberId,
        completedAt: now,
        findingIds,
        resultId: opts.sourceResultId ?? item.resultId,
        completionSource: opts.sourceResultId ? "teammate_result" as const : item.completionSource,
        blocker: undefined,
      }
      : item
  );
  const intermediate: AgentTeamRun = {
    ...run,
    board: {
      ...run.board,
      tasks: completedTasks,
      findings: finding ? [...run.board.findings, finding] : run.board.findings,
    },
  };
  const events: AgentTeamEvent[] = [
    ...run.board.events,
    {
      ...eventWithActor(run, "task_completed", memberId, `${member.name} completed ${task.title}.`),
      taskId,
    },
  ];
  if (finding) {
    events.push({
      ...eventWithActor(run, "finding_proposed", memberId, finding.claim),
      taskId,
      findingId: finding.id,
    });
  }
  const nextTasks = unblockReadyTasks(intermediate, events);
  const nextMembers = run.members.map((item) =>
    item.id === memberId
      ? {
          ...item,
          status: "idle" as const,
          currentTaskId: undefined,
          latestOutput: `已完成任务：${task.title}`,
          lastActiveAt: now,
        }
      : item
  );
  const releasedLocks = (run.board.fileLocks ?? []).map((lock) =>
    lock.status === "active" && lock.taskId === taskId && lock.ownerAgentId === memberId
      ? { ...lock, status: "released" as const, releasedAt: now }
      : lock
  );
  const releasedEvents = (run.board.fileLocks ?? [])
    .filter((lock) => lock.status === "active" && lock.taskId === taskId && lock.ownerAgentId === memberId)
    .map((lock) => ({
      ...eventWithActor(run, "file_lock_released", memberId, `${member.name} released ${lock.path}.`, {
        lockId: lock.id,
      }),
      taskId,
    }));
  return {
    run: refreshAgentTeamQualityGates(patchAgentTeamRun(run, {
      board: {
        ...run.board,
        tasks: nextTasks,
        findings: finding ? [...run.board.findings, finding] : run.board.findings,
        fileLocks: releasedLocks,
        hooks: hookCheck.hooks,
        capabilityAudit: updateCapability(run, "shared-task-list", {
          status: "partial",
          evidence: "task complete API exercised",
          gap: "已支持任务认领/完成/依赖解锁协议，尚未由 teammate 自动循环认领。",
          nextStep: "让 hidden teammate 从 task queue 自动 claim 并执行。",
        }).map((item) => {
          if (item.id !== "automatic-dispatch" || !opts.autoDispatched) return item;
          const mode = opts.dispatchMode ?? "single";
          const evidence =
            mode === "until_idle"
              ? "run_until_idle replanned teammate tasks until idle"
              : mode === "batch"
                ? "run_batch dispatched multiple teammate tasks"
                : "run_next dispatched teammate task";
          return {
            ...item,
            digaStatus: mode === "until_idle" ? "implemented" : "partial",
            evidence: item.evidence.includes(evidence)
              ? item.evidence
              : [...item.evidence, evidence],
            gap:
              mode === "until_idle"
                ? "已支持持续重规划与多轮自动调度；仍需补失败重试、replacement teammate 和真正的文件锁。"
                : "已支持自动调度 teammate 执行任务并回写 finding，尚未实现持续循环与失败重试。",
            nextStep:
              mode === "until_idle"
                ? "补齐失败重试、replacement teammate、文件锁和 shutdown 语义。"
                : "实现 run_until_idle：持续重规划、等待成员完成并推进到无可运行任务。",
          };
        }),
        events: [...events, ...hookCheck.events, ...releasedEvents],
      },
      members: nextMembers,
      leadState:
        nextTasks.every((item) => !item.required || item.status === "completed") &&
        acceptedFindings({ ...run, board: { ...run.board, findings: finding ? [...run.board.findings, finding] : run.board.findings } }).length > 0
          ? "ready_to_synthesize"
          : run.leadState,
    })),
  };
}

export function submitAgentTeamResult(
  run: AgentTeamRun,
  opts: {
    taskId: string;
    memberId: string;
    rawText: string;
    sessionFile?: string;
    dispatchMode?: "single" | "batch" | "until_idle";
  }
): { run: AgentTeamRun; error?: string } {
  const now = Date.now();
  const task = run.board.tasks.find((item) => item.id === opts.taskId);
  const member = run.members.find((item) => item.id === opts.memberId);
  if (!task) return { run, error: "task not found" };
  if (!member) return { run, error: "member not found" };
  const parsed = parseAgentTeamResultText(opts.rawText);
  const resultId = `${opts.taskId}:result:${now}`;
  const findingIds = parsed.findings.map((_, index) => `${resultId}:finding:${index + 1}`);
  const challengeIds = parsed.challenges.map((_, index) => `${resultId}:challenge:${index + 1}`);
  const result: AgentTeamResult = {
    id: resultId,
    taskId: opts.taskId,
    authorAgentId: opts.memberId,
    sessionFile: opts.sessionFile,
    rawText: opts.rawText,
    summary: parsed.summary,
    parsedAt: now,
    status: parsed.findings.length > 0 && parsed.warnings.length === 0 ? "parsed" : "needs_review",
    findingIds,
    challengeIds,
    evidenceRefs: Array.from(new Set(parsed.findings.flatMap((finding) => finding.evidenceRefs ?? []))),
    parseWarnings: parsed.warnings,
  };
  if (result.status === "needs_review") {
    const blocker =
      parsed.findings.length === 0
        ? "Teammate result needs review: no structured findings were provided."
        : `Teammate result needs review: ${parsed.warnings.join("; ")}`;
    return {
      run: patchAgentTeamRun(run, {
        board: {
          ...run.board,
          results: [...(run.board.results ?? []), result],
          tasks: run.board.tasks.map((item) =>
            item.id === opts.taskId
              ? {
                  ...item,
                  status: "blocked" as const,
                  blocker,
                  resultId,
                  lastError: blocker,
                }
              : item
          ),
          capabilityAudit: updateCapability(run, "automatic-dispatch", {
            status: "partial",
            evidence: "teammate result captured but requires review",
            gap: "已停止 prompt 成功即完成；结构化结果缺 evidence 或 findings 时会阻塞等待审阅。",
            nextStep: "补 Workspace 审阅 result 并转成 finding/challenge 的人工入口。",
          }),
          events: [
            ...run.board.events,
            {
              ...eventWithActor(run, "result_submitted", opts.memberId, blocker, {
                resultId,
                warnings: parsed.warnings,
              }),
              taskId: opts.taskId,
            },
          ],
        },
        members: run.members.map((item) =>
          item.id === opts.memberId
            ? {
                ...item,
                status: "blocked" as const,
                currentTaskId: undefined,
                latestOutput: blocker,
                lastActiveAt: now,
              }
            : item
        ),
      }),
      error: blocker,
    };
  }

  const findings: AgentTeamFinding[] = parsed.findings.map((finding, index) => ({
    id: findingIds[index],
    taskId: opts.taskId,
    authorAgentId: opts.memberId,
    claim: finding.claim,
    evidenceRefs: finding.evidenceRefs ?? [],
    confidence: finding.confidence ?? "medium",
    status: "proposed",
    challengeIds: [],
    sourceResultId: resultId,
    provenance: [
      { kind: "result", ref: resultId },
      ...(finding.evidenceRefs ?? []).map((ref) => ({
        kind: ref.startsWith("file:")
          ? "file" as const
          : ref.startsWith("session:")
            ? "session" as const
            : "artifact" as const,
        ref,
      })),
    ],
  }));
  const defaultTargetFindingId = findings[0]?.id ?? run.board.findings[0]?.id ?? "";
  const challenges: AgentTeamChallenge[] = run.settings.allowChallenges
    ? parsed.challenges.map((challenge, index) => ({
        id: challengeIds[index],
        targetFindingId: challenge.targetFindingId || defaultTargetFindingId,
        authorAgentId: opts.memberId,
        reason: challenge.reason,
        severity: challenge.severity ?? "medium",
        status: "open",
        sourceResultId: resultId,
        createdAt: now,
        requiredEvidenceRefs: challenge.requiredEvidenceRefs,
      }))
    : [];
  const intermediate: AgentTeamRun = {
    ...run,
    board: {
      ...run.board,
      results: [...(run.board.results ?? []), result],
      findings: [...run.board.findings, ...findings],
      challenges: [...run.board.challenges, ...challenges],
      tasks: run.board.tasks.map((item) =>
        item.id === opts.taskId
          ? { ...item, resultId, findingIds: [...item.findingIds, ...findingIds] }
          : item
      ),
    },
  };
  const completed = completeAgentTeamTask(intermediate, opts.taskId, opts.memberId, {
    findingClaim: findings[0]?.claim ?? parsed.summary,
    evidenceRefs: result.evidenceRefs,
    confidence: findings[0]?.confidence ?? "medium",
    autoDispatched: true,
    dispatchMode: opts.dispatchMode,
    sourceResultId: resultId,
  });
  const nextRun = completed.run;
  const dedupedFindings = nextRun.board.findings.filter(
    (finding, index, all) => all.findIndex((item) => item.id === finding.id) === index
  );
  const ingestedRun = patchAgentTeamRun(nextRun, {
      board: {
        ...nextRun.board,
        findings: dedupedFindings,
        results: nextRun.board.results ?? intermediate.board.results,
        challenges: nextRun.board.challenges,
        capabilityAudit: updateCapability(nextRun, "automatic-dispatch", {
          status: opts.dispatchMode === "until_idle" ? "implemented" : "partial",
          evidence: "teammate result ingested before task completion",
          gap: "已改为基于真实 teammate result 完成任务；后续可接入 teammate coordination tools 直接提交结果。",
          nextStep: "把 team_submit_result 做成 teammate 可调用工具。",
        }),
        events: [
          ...nextRun.board.events,
          {
            ...eventWithActor(run, "result_submitted", opts.memberId, parsed.summary, {
              resultId,
              findingIds,
              challengeIds: challenges.map((challenge) => challenge.id),
            }),
            taskId: opts.taskId,
          },
          ...challenges.map((challenge) => ({
            ...eventWithActor(run, "finding_challenged", opts.memberId, challenge.reason, {
              challengeId: challenge.id,
              targetFindingId: challenge.targetFindingId,
            }),
            taskId: opts.taskId,
            challengeId: challenge.id,
            findingId: challenge.targetFindingId,
          })),
          ...findings.map((finding) => ({
            ...eventWithActor(run, "finding_proposed", opts.memberId, finding.claim, {
              sourceResultId: resultId,
            }),
            taskId: opts.taskId,
            findingId: finding.id,
          })),
        ],
      },
    });
  const settledRun = autoSettleSynthesisResult(ingestedRun, {
    taskId: opts.taskId,
    memberId: opts.memberId,
    resultId,
    summary: parsed.summary,
    findingIds,
    challengeIds: challenges.map((challenge) => challenge.id),
    evidenceRefs: result.evidenceRefs,
  });
  return {
    run: settledRun,
    error: completed.error,
  };
}

function autoSettleSynthesisResult(
  run: AgentTeamRun,
  opts: {
    taskId: string;
    memberId: string;
    resultId: string;
    summary: string;
    findingIds: string[];
    challengeIds: string[];
    evidenceRefs: string[];
  }
): AgentTeamRun {
  const task = run.board.tasks.find((item) => item.id === opts.taskId);
  if (!task || (task.id !== "synthesis" && task.expectedOutput !== "decision_input")) {
    return run;
  }
  let nextRun = run;
  const synthesisFindingIds = opts.findingIds.filter((id) =>
    nextRun.board.findings.some((finding) => finding.id === id)
  );
  for (const findingId of synthesisFindingIds) {
    const accepted = acceptAgentTeamFinding(nextRun, findingId, nextRun.leadAgentId);
    nextRun = accepted.run;
  }
  const openChallenges = nextRun.board.challenges.filter(isOpenChallenge);
  for (const challenge of openChallenges) {
    const resolved = resolveAgentTeamChallenge(
      nextRun,
      challenge.id,
      nextRun.leadAgentId,
      "Lead accepted the synthesis result as the resolution for this open challenge.",
      synthesisFindingIds
    );
    nextRun = resolved.run;
  }
  const acceptedFindingIds = nextRun.board.findings
    .filter((finding) => isAcceptedForDecision(nextRun, finding))
    .map((finding) => finding.id);
  const decision = recordAgentTeamDecision(nextRun, {
    title: "Team 最终综合",
    rationale: opts.summary,
    madeByAgentId: nextRun.leadAgentId,
    acceptedFindingIds,
    challengeIds: nextRun.board.challenges
      .filter((challenge) => challenge.status === "resolved" || challenge.status === "dismissed")
      .map((challenge) => challenge.id),
    evidenceRefs: opts.evidenceRefs,
    sourceResultIds: [opts.resultId],
    confidence: "high",
  });
  nextRun = decision.run;
  if (decision.error) return nextRun;
  return transitionAgentTeamRun(nextRun, "completed").run;
}

export function settleAgentTeamCompletedSynthesis(run: AgentTeamRun): AgentTeamRun {
  if (run.status === "completed") return run;
  const synthesisTask = run.board.tasks.find(
    (task) =>
      task.status === "completed" &&
      (task.id === "synthesis" || task.expectedOutput === "decision_input") &&
      task.resultId
  );
  const result = synthesisTask?.resultId
    ? run.board.results.find((item) => item.id === synthesisTask.resultId)
    : undefined;
  if (!synthesisTask || !result) return run;
  return autoSettleSynthesisResult(run, {
    taskId: synthesisTask.id,
    memberId: synthesisTask.ownerAgentId ?? result.authorAgentId,
    resultId: result.id,
    summary: result.summary,
    findingIds: result.findingIds,
    challengeIds: result.challengeIds,
    evidenceRefs: result.evidenceRefs,
  });
}

export function acceptAgentTeamFinding(
  run: AgentTeamRun,
  findingId: string,
  actorAgentId: string
): { run: AgentTeamRun; error?: string } {
  const finding = run.board.findings.find((item) => item.id === findingId);
  if (!finding) return { run, error: "finding not found" };
  const now = Date.now();
  return {
    run: patchAgentTeamRun(run, {
      board: {
        ...run.board,
        findings: run.board.findings.map((item) =>
          item.id === findingId
            ? {
                ...item,
                status: "accepted" as const,
                acceptedByAgentId: actorAgentId,
                acceptedAt: now,
              }
            : item
        ),
        capabilityAudit: updateCapability(run, "decision-traceability", {
          status: "partial",
          evidence: "finding accepted with actor metadata",
          gap: "Findings 已能显式采纳/拒绝；decision 需要绑定 accepted finding 才能 finalize。",
          nextStep: "把 final decision 与 accepted finding/challenge resolution 强绑定。",
        }),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(run, "finding_accepted", actorAgentId, `Accepted finding: ${finding.claim}`),
            findingId,
          },
        ],
      },
    }),
  };
}

export function rejectAgentTeamFinding(
  run: AgentTeamRun,
  findingId: string,
  actorAgentId: string,
  reason: string
): { run: AgentTeamRun; error?: string } {
  const finding = run.board.findings.find((item) => item.id === findingId);
  if (!finding) return { run, error: "finding not found" };
  if (!reason.trim()) return { run, error: "rejection reason is required" };
  const now = Date.now();
  return {
    run: patchAgentTeamRun(run, {
      board: {
        ...run.board,
        findings: run.board.findings.map((item) =>
          item.id === findingId
            ? {
                ...item,
                status: "rejected" as const,
                rejectedByAgentId: actorAgentId,
                rejectedAt: now,
                rejectionReason: reason.trim(),
              }
            : item
        ),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(run, "finding_rejected", actorAgentId, `Rejected finding: ${reason.trim()}`),
            findingId,
          },
        ],
      },
    }),
  };
}

export function createAgentTeamChallenge(
  run: AgentTeamRun,
  opts: {
    targetFindingId: string;
    authorAgentId: string;
    reason: string;
    severity?: AgentTeamChallenge["severity"];
    requiredEvidenceRefs?: string[];
  }
): { run: AgentTeamRun; error?: string } {
  if (!run.settings.allowChallenges) return { run, error: "challenges are disabled for this Team" };
  const finding = run.board.findings.find((item) => item.id === opts.targetFindingId);
  if (!finding) return { run, error: "target finding not found" };
  if (!opts.reason.trim()) return { run, error: "challenge reason is required" };
  const now = Date.now();
  const challenge: AgentTeamChallenge = {
    id: `${opts.targetFindingId}:challenge:${now}`,
    targetFindingId: opts.targetFindingId,
    authorAgentId: opts.authorAgentId,
    reason: opts.reason.trim(),
    severity: opts.severity ?? "medium",
    status: "open",
    createdAt: now,
    requiredEvidenceRefs: opts.requiredEvidenceRefs ?? [],
  };
  return {
    run: patchAgentTeamRun(run, {
      leadState: "needs_decision",
      board: {
        ...run.board,
        challenges: [...run.board.challenges, challenge],
        findings: run.board.findings.map((item) =>
          item.id === opts.targetFindingId
            ? {
                ...item,
                status: "challenged" as const,
                challengeIds: [...item.challengeIds, challenge.id],
              }
            : item
        ),
        capabilityAudit: updateCapability(run, "challenge-lifecycle", {
          status: "implemented",
          evidence: "create_challenge mutation recorded open challenge",
          gap: "Challenge 已有创建/解决/驳回状态机；后续补 teammate tool 直接发起 challenge。",
          nextStep: "把 team_create_challenge 暴露给 teammate coordination tools。",
        }),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(run, "finding_challenged", opts.authorAgentId, challenge.reason, {
              challengeId: challenge.id,
            }),
            findingId: opts.targetFindingId,
            challengeId: challenge.id,
          },
        ],
      },
    }),
  };
}

export function resolveAgentTeamChallenge(
  run: AgentTeamRun,
  challengeId: string,
  actorAgentId: string,
  resolution: string,
  resolutionFindingIds: string[] = []
): { run: AgentTeamRun; error?: string } {
  const challenge = run.board.challenges.find((item) => item.id === challengeId);
  if (!challenge) return { run, error: "challenge not found" };
  if (!resolution.trim()) return { run, error: "challenge resolution is required" };
  const now = Date.now();
  return {
    run: refreshAgentTeamQualityGates(patchAgentTeamRun(run, {
      board: {
        ...run.board,
        challenges: run.board.challenges.map((item) =>
          item.id === challengeId
            ? {
                ...item,
                status: "resolved" as const,
                resolution: resolution.trim(),
                resolvedAt: now,
                resolvedByAgentId: actorAgentId,
                resolutionFindingIds,
              }
            : item
        ),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(run, "challenge_resolved", actorAgentId, resolution.trim(), {
              challengeId,
              resolutionFindingIds,
            }),
            challengeId,
            findingId: challenge.targetFindingId,
          },
        ],
      },
    })),
  };
}

export function dismissAgentTeamChallenge(
  run: AgentTeamRun,
  challengeId: string,
  actorAgentId: string,
  reason: string
): { run: AgentTeamRun; error?: string } {
  const challenge = run.board.challenges.find((item) => item.id === challengeId);
  if (!challenge) return { run, error: "challenge not found" };
  if (!reason.trim()) return { run, error: "dismiss reason is required" };
  const now = Date.now();
  return {
    run: refreshAgentTeamQualityGates(patchAgentTeamRun(run, {
      board: {
        ...run.board,
        challenges: run.board.challenges.map((item) =>
          item.id === challengeId
            ? {
                ...item,
                status: "dismissed" as const,
                resolution: reason.trim(),
                resolvedAt: now,
                resolvedByAgentId: actorAgentId,
              }
            : item
        ),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(run, "challenge_dismissed", actorAgentId, reason.trim(), {
              challengeId,
            }),
            challengeId,
            findingId: challenge.targetFindingId,
          },
        ],
      },
    })),
  };
}

export function recordAgentTeamDecision(
  run: AgentTeamRun,
  opts: {
    title: string;
    rationale: string;
    madeByAgentId: string;
    acceptedFindingIds: string[];
    rejectedFindingIds?: string[];
    challengeIds?: string[];
    evidenceRefs?: string[];
    sourceResultIds?: string[];
    confidence?: "low" | "medium" | "high";
  }
): { run: AgentTeamRun; error?: string } {
  if (!opts.title.trim()) return { run, error: "decision title is required" };
  if (!opts.rationale.trim()) return { run, error: "decision rationale is required" };
  const accepted = opts.acceptedFindingIds.filter((id) =>
    run.board.findings.some((finding) => finding.id === id && isAcceptedForDecision(run, finding))
  );
  if (accepted.length === 0) {
    return { run, error: "decision requires at least one accepted finding" };
  }
  if ((opts.evidenceRefs ?? []).length === 0 && (opts.sourceResultIds ?? []).length === 0) {
    return { run, error: "decision requires evidence refs or source result refs" };
  }
  const unresolved = (opts.challengeIds ?? []).filter((id) =>
    run.board.challenges.some((challenge) => challenge.id === id && isOpenChallenge(challenge))
  );
  if (unresolved.length > 0) {
    return { run, error: `decision references unresolved challenges: ${unresolved.join(", ")}` };
  }
  const now = Date.now();
  const decision = {
    id: `${run.id}:decision:${now}`,
    title: opts.title.trim(),
    rationale: opts.rationale.trim(),
    acceptedFindingIds: accepted,
    rejectedFindingIds: opts.rejectedFindingIds ?? [],
    challengeIds: opts.challengeIds ?? [],
    evidenceRefs: opts.evidenceRefs ?? [],
    sourceResultIds: opts.sourceResultIds ?? [],
    confidence: opts.confidence ?? "medium",
    status: "accepted" as const,
    madeByAgentId: opts.madeByAgentId,
    createdAt: now,
  };
  return {
    run: patchAgentTeamRun(run, {
      leadState: "ready_to_synthesize",
      board: {
        ...run.board,
        decisions: [...run.board.decisions, decision],
        capabilityAudit: updateCapability(run, "decision-traceability", {
          status: "implemented",
          evidence: "record_decision requires accepted findings and trace refs",
          gap: "Decision 已强制绑定 accepted finding；后续补 Workspace 点击溯源详情。",
          nextStep: "在 UI 中展开 decision 的 linked findings/challenges/results。",
        }),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(run, "decision_recorded", opts.madeByAgentId, decision.title, {
              decisionId: decision.id,
              acceptedFindingIds: accepted,
              challengeIds: decision.challengeIds,
            }),
          },
        ],
      },
    }),
  };
}

export function submitAgentTeamPlan(
  run: AgentTeamRun,
  opts: {
    taskId: string;
    authorAgentId: string;
    body: string;
    criteria?: string[];
  }
): { run: AgentTeamRun; error?: string } {
  const task = run.board.tasks.find((item) => item.id === opts.taskId);
  if (!task) return { run, error: "task not found" };
  if (!opts.body.trim()) return { run, error: "plan body is required" };
  const now = Date.now();
  const plan: AgentTeamPlan = {
    id: `${opts.taskId}:plan:${now}`,
    taskId: opts.taskId,
    authorAgentId: opts.authorAgentId,
    body: opts.body.trim(),
    status: "submitted",
    submittedAt: now,
    criteria: opts.criteria ?? task.acceptanceCriteria ?? [],
  };
  return {
    run: patchAgentTeamRun(run, {
      board: {
        ...run.board,
        plans: [...(run.board.plans ?? []), plan],
        tasks: run.board.tasks.map((item) =>
          item.id === opts.taskId
            ? {
                ...item,
                planId: plan.id,
                status: "needs_plan" as const,
                blocker: "Waiting for Lead plan approval.",
              }
            : item
        ),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(run, "plan_submitted", opts.authorAgentId, `Plan submitted for ${task.title}.`, {
              planId: plan.id,
            }),
            taskId: opts.taskId,
          },
        ],
      },
    }),
  };
}

export function approveAgentTeamPlan(
  run: AgentTeamRun,
  planId: string,
  reviewerAgentId: string
): { run: AgentTeamRun; error?: string } {
  const plan = (run.board.plans ?? []).find((item) => item.id === planId);
  if (!plan) return { run, error: "plan not found" };
  const now = Date.now();
  return {
    run: patchAgentTeamRun(run, {
      board: {
        ...run.board,
        plans: (run.board.plans ?? []).map((item) =>
          item.id === planId
            ? {
                ...item,
                status: "approved" as const,
                reviewedAt: now,
                reviewedByAgentId: reviewerAgentId,
              }
            : item
        ),
        tasks: run.board.tasks.map((task) =>
          task.id === plan.taskId && task.status === "needs_plan"
            ? {
                ...task,
                status: "pending" as const,
                blocker: undefined,
              }
            : task
        ),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(run, "plan_approved", reviewerAgentId, `Plan approved for ${plan.taskId}.`, {
              planId,
            }),
            taskId: plan.taskId,
          },
        ],
      },
    }),
  };
}

export function rejectAgentTeamPlan(
  run: AgentTeamRun,
  planId: string,
  reviewerAgentId: string,
  reason: string
): { run: AgentTeamRun; error?: string } {
  const plan = (run.board.plans ?? []).find((item) => item.id === planId);
  if (!plan) return { run, error: "plan not found" };
  if (!reason.trim()) return { run, error: "plan rejection reason is required" };
  const now = Date.now();
  return {
    run: patchAgentTeamRun(run, {
      board: {
        ...run.board,
        plans: (run.board.plans ?? []).map((item) =>
          item.id === planId
            ? {
                ...item,
                status: "rejected" as const,
                reviewedAt: now,
                reviewedByAgentId: reviewerAgentId,
                rejectionReason: reason.trim(),
              }
            : item
        ),
        tasks: run.board.tasks.map((task) =>
          task.id === plan.taskId
            ? {
                ...task,
                status: "needs_plan" as const,
                blocker: reason.trim(),
              }
            : task
        ),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(run, "plan_rejected", reviewerAgentId, reason.trim(), {
              planId,
            }),
            taskId: plan.taskId,
          },
        ],
      },
    }),
  };
}

export function markAgentTeamTeammateIdle(run: AgentTeamRun): AgentTeamRun {
  const hookCheck = evaluateAgentTeamHooks(run, "TeammateIdle", {
    memberId: run.leadAgentId,
  });
  return patchAgentTeamRun(run, {
    board: {
      ...run.board,
      hooks: hookCheck.hooks,
      capabilityAudit: updateCapability(run, "quality-hooks", {
        status: "implemented",
        evidence: "TeammateIdle hook registry evaluated",
        gap: "已支持 TaskCompleted / TeammateIdle 内置 hook registry，尚未支持用户自定义脚本。",
        nextStep: "支持用户在 Workspace 添加/关闭 hook 规则。",
      }),
      events: [...run.board.events, ...hookCheck.events],
    },
  });
}

export function updateAgentTeamHook(
  run: AgentTeamRun,
  hookId: string,
  patch: {
    enabled?: boolean;
    severity?: AgentTeamHook["severity"];
  }
): { run: AgentTeamRun; error?: string } {
  const hook = (run.board.hooks ?? []).find((item) => item.id === hookId);
  if (!hook) return { run, error: "hook not found" };
  const nextHooks = (run.board.hooks ?? []).map((item) =>
    item.id === hookId
      ? {
          ...item,
          ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
          ...(patch.severity ? { severity: patch.severity } : {}),
          status: "pending" as const,
          lastFailure: undefined,
          lastCheckedAt: undefined,
        }
      : item
  );
  const state =
    typeof patch.enabled === "boolean"
      ? patch.enabled
        ? "enabled"
        : "disabled"
      : "updated";
  return {
    run: patchAgentTeamRun(run, {
      board: {
        ...run.board,
        hooks: nextHooks,
        capabilityAudit: updateCapability(run, "quality-hooks", {
          status: "implemented",
          evidence: "Team hook registry configured",
          gap: "已支持内置 hook registry 与启停配置；尚未支持任意用户脚本。",
          nextStep: "支持脚本型 hooks 和更细的 hook 参数编辑。",
        }),
        events: [
          ...run.board.events,
          makeEvent(run, "decision_recorded", `${hook.title} hook ${state}.`, {
            hookId,
            patch,
          }),
        ],
      },
    }),
  };
}

export function failAgentTeamTask(
  run: AgentTeamRun,
  taskId: string,
  memberId: string,
  error: string
): { run: AgentTeamRun; error?: string } {
  const now = Date.now();
  const task = run.board.tasks.find((item) => item.id === taskId);
  const member = run.members.find((item) => item.id === memberId);
  if (!task) return { run, error: "task not found" };
  if (!member) return { run, error: "member not found" };
  const releasedLocks = (run.board.fileLocks ?? []).map((lock) =>
    lock.status === "active" && lock.taskId === taskId && lock.ownerAgentId === memberId
      ? { ...lock, status: "released" as const, releasedAt: now }
      : lock
  );
  const releasedEvents = (run.board.fileLocks ?? [])
    .filter((lock) => lock.status === "active" && lock.taskId === taskId && lock.ownerAgentId === memberId)
    .map((lock) => ({
      ...eventWithActor(run, "file_lock_released", memberId, `${member.name} released ${lock.path} after failure.`, {
        lockId: lock.id,
      }),
      taskId,
    }));
  return {
    run: patchAgentTeamRun(run, {
      board: {
        ...run.board,
        fileLocks: releasedLocks,
        tasks: run.board.tasks.map((item) =>
          item.id === taskId
            ? {
                ...item,
                status: "blocked" as const,
                blocker: error,
                lastError: error,
                ownerAgentId: memberId,
              }
            : item
        ),
        capabilityAudit: updateCapability(run, "failure-recovery", {
          status: "partial",
          evidence: "dispatch failure captured as retryable blocked task",
          gap: "已能把失败任务回写为可重试状态，replacement teammate API 已接入但未自动选择替换。",
          nextStep: "在连续失败后自动建议或创建 replacement teammate。",
        }),
        events: [
          ...run.board.events,
          ...releasedEvents,
          {
            ...eventWithActor(run, "task_blocked", memberId, `${task.title} failed and is ready for retry.`, {
              error,
            }),
            taskId,
          },
        ],
      },
      members: run.members.map((item) =>
        item.id === memberId
          ? {
              ...item,
              status: "blocked" as const,
              currentTaskId: undefined,
              failureCount: (item.failureCount ?? 0) + 1,
              latestOutput: error,
              lastActiveAt: now,
            }
          : item
      ),
    }),
  };
}

export function retryAgentTeamTask(
  run: AgentTeamRun,
  taskId: string
): { run: AgentTeamRun; error?: string } {
  const task = run.board.tasks.find((item) => item.id === taskId);
  if (!task) return { run, error: "task not found" };
  if (task.status === "completed") return { run, error: "task already completed" };
  return {
    run: patchAgentTeamRun(run, {
      board: {
        ...run.board,
        tasks: run.board.tasks.map((item) =>
          item.id === taskId
            ? {
                ...item,
                status: "pending" as const,
                ownerAgentId: undefined,
                blocker: undefined,
                retryCount: (item.retryCount ?? 0) + 1,
              }
            : item
        ),
        capabilityAudit: updateCapability(run, "failure-recovery", {
          status: "partial",
          evidence: "retry_task returned blocked task to pending queue",
          gap: "已支持手动 retry，尚未实现连续失败后的自动 replacement。",
          nextStep: "按 failureCount 触发 replacement teammate 建议。",
        }),
        events: [
          ...run.board.events,
          {
            ...makeEvent(run, "task_retried", `${task.title} returned to pending queue.`),
            taskId,
          },
        ],
      },
    }),
  };
}

export function replaceAgentTeamMember(
  run: AgentTeamRun,
  memberId: string,
  replacement: {
    agentId?: string;
    sessionFile?: string;
    modelId?: string;
  }
): { run: AgentTeamRun; error?: string } {
  const member = run.members.find((item) => item.id === memberId);
  if (!member) return { run, error: "member not found" };
  const now = Date.now();
  return {
    run: patchAgentTeamRun(run, {
      board: {
        ...run.board,
        capabilityAudit: updateCapability(run, "failure-recovery", {
          status: "implemented",
          evidence: "replace_member created replacement teammate session",
          gap: "已支持手动 replacement teammate；后续可按失败阈值自动触发。",
          nextStep: "实现连续失败阈值下的自动 replacement。",
        }),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(run, "member_replaced", run.leadAgentId, `${member.name} was replaced.`, {
              memberId,
              previousAgentId: member.agentId,
              replacementAgentId: replacement.agentId,
            }),
            targetAgentId: memberId,
          },
        ],
      },
      members: run.members.map((item) =>
        item.id === memberId
          ? {
              ...item,
              ...replacement,
              status: "idle" as const,
              currentTaskId: undefined,
              failureCount: 0,
              latestOutput: "Replacement teammate session 已创建，等待重新认领任务。",
              spawnedAt: now,
              lastActiveAt: now,
            }
          : item
      ),
    }),
  };
}

export function sendAgentTeamMessage(
  run: AgentTeamRun,
  message: Omit<AgentTeamMessage, "id" | "createdAt">,
  opts: { directFollowUp?: boolean } = {}
): { run: AgentTeamRun; error?: string } {
  const sender = run.members.find((member) => member.id === message.fromAgentId);
  if (!sender) return { run, error: "sender not found" };
  if (message.toAgentId && !run.members.some((member) => member.id === message.toAgentId)) {
    return { run, error: "recipient not found" };
  }
  const now = Date.now();
  const msg: AgentTeamMessage = {
    ...message,
    id: `${run.id}:message:${now}:${run.board.messages.length + 1}`,
    createdAt: now,
  };
  return {
    run: patchAgentTeamRun(run, {
      board: {
        ...run.board,
        messages: [...run.board.messages, msg],
        capabilityAudit: updateCapability(run, "mailbox", {
          status: "partial",
          evidence: "mailbox send API exercised",
          gap: "已支持 board mailbox 记录和实时广播，尚未注入 teammate 模型上下文。",
          nextStep: "把 mailbox inbox 注入 hidden teammate 的下一轮 prompt。",
        }).map((item) =>
          item.id === "direct-teammate-interaction" && opts.directFollowUp
            ? {
                ...item,
                digaStatus: "implemented",
                evidence: item.evidence.includes("follow_up_member delivered mailbox prompt")
                  ? item.evidence
                  : [...item.evidence, "follow_up_member delivered mailbox prompt"],
                gap: "已支持 Workspace 内点名 teammate 追问并同步 mailbox。",
                nextStep: "支持 teammate follow-up 的结构化答复回写为 finding 或 challenge。",
              }
            : item
        ),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(run, "message_sent", msg.fromAgentId, msg.body),
            targetAgentId: msg.toAgentId,
            taskId: msg.taskId,
            findingId: msg.findingId,
            challengeId: msg.challengeId,
          },
        ],
      },
      members: run.members.map((member) =>
        member.id === msg.toAgentId && opts.directFollowUp
          ? { ...member, latestOutput: `收到 follow-up：${msg.body}`, lastActiveAt: now }
          : member.id === msg.fromAgentId
          ? { ...member, latestOutput: msg.body, lastActiveAt: now }
          : member
      ),
    }),
  };
}

export function promoteAgentTeamMember(
  run: AgentTeamRun,
  memberId: string
): { run: AgentTeamRun; error?: string } {
  const member = run.members.find((item) => item.id === memberId);
  if (!member) return { run, error: "member not found" };
  if (!member.agentId && !member.sessionFile) {
    return { run, error: "member has no teammate session to promote" };
  }
  const now = Date.now();
  return {
    run: patchAgentTeamRun(run, {
      board: {
        ...run.board,
        capabilityAudit: updateCapability(run, "direct-teammate-interaction", {
          status: "implemented",
          evidence: "promote_member exposed teammate session",
          gap: "已支持用户主动把 teammate session 提升为 sidebar 子会话；后续可补更细的 inbox follow-up UX。",
          nextStep: "支持在 Team Workspace 内直接向指定 teammate 追问并同步回 mailbox。",
        }),
        events: [
          ...run.board.events,
          {
            ...eventWithActor(
              run,
              "member_promoted",
              run.leadAgentId,
              `${member.name} promoted to a visible teammate session.`,
              { memberId }
            ),
            targetAgentId: memberId,
          },
        ],
      },
      members: run.members.map((item) =>
        item.id === memberId
          ? {
              ...item,
              sidebarVisible: true,
              promotedAt: now,
              latestOutput: "已提升为可见 teammate session，可从 sidebar 打开继续追问。",
              lastActiveAt: now,
            }
          : item
      ),
    }),
  };
}

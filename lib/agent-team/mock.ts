import type { AgentTeamRun, AgentTeamSettings } from "./types";
import { planAgentTeamDeterministic } from "./planner";

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

const DEFAULT_SETTINGS: AgentTeamSettings = {
  memberScale: "standard",
  allowNetwork: false,
  allowWrite: false,
  allowWorktree: false,
  allowChallenges: true,
  requirePlanApproval: true,
  displayMode: "workspace",
  writePolicy: "plan_approval",
  networkPolicy: "disabled",
  worktreePolicy: "none",
  resultIngestionMode: "structured",
  stopConditions: {
    requiredTasksComplete: true,
    noOpenBlockingChallenges: true,
    leadFinalSynthesis: true,
  },
};

function normalizeSettings(settings?: Partial<AgentTeamSettings>): AgentTeamSettings {
  const allowWrite = settings?.allowWrite ?? DEFAULT_SETTINGS.allowWrite;
  const requirePlanApproval =
    settings?.requirePlanApproval ?? DEFAULT_SETTINGS.requirePlanApproval;
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    writePolicy:
      settings?.writePolicy ??
      (!allowWrite ? "read_only" : requirePlanApproval ? "plan_approval" : "write_allowed"),
    networkPolicy:
      settings?.networkPolicy ??
      (settings?.allowNetwork ? "teammates_allowed" : "disabled"),
    worktreePolicy:
      settings?.worktreePolicy ??
      (settings?.allowWorktree ? "per_member" : "none"),
    resultIngestionMode: settings?.resultIngestionMode ?? "structured",
    coordinationProfile: settings?.coordinationProfile ?? "basic",
    stopConditions: {
      ...DEFAULT_SETTINGS.stopConditions,
      ...(settings?.stopConditions ?? {}),
    },
  };
}

export function createInitialAgentTeamRun(
  objective: string,
  settings?: Partial<AgentTeamSettings>
): AgentTeamRun {
  const now = Date.now();
  const runId = makeId("team");
  const leadAgentId = `${runId}:lead`;
  const normalizedSettings = normalizeSettings(settings);
  const plan = planAgentTeamDeterministic({
    objective,
    settings: normalizedSettings,
    runId,
    leadAgentId,
    now,
  });
  const { members, tasks } = plan;

  return {
    id: runId,
    parentAgentId: undefined,
    parentSessionPath: undefined,
    objective,
    status: "running",
    leadState: "exploring",
    leadAgentId,
    members,
    board: {
      summary:
        "Team 已启动：先建立任务板，再由成员认领任务、发布发现、提出挑战，最后由 Lead 收敛决策。",
      tasks,
      results: [],
      plans: [],
      findings: [
        {
          id: "f-mode",
          taskId: "frame",
          authorAgentId: leadAgentId,
          claim: "当前是 Agent Team 模式：过程会进入共享白板，主聊天只保留摘要和决策入口。",
          evidenceRefs: ["composer:/team", "workspace:board"],
          confidence: "high",
          status: "accepted",
          challengeIds: [],
          provenance: [
            { kind: "message", ref: "composer:/team" },
            { kind: "artifact", ref: "workspace:board" },
          ],
        },
      ],
      challenges: [],
      decisions: [
        {
          id: "d-session-model",
          title: "会话策略",
          rationale:
            "默认采用一个主 session + Team Workspace。成员 transcript 可打开，但不自动塞进 sidebar。",
          acceptedFindingIds: ["f-mode"],
          rejectedFindingIds: [],
          challengeIds: [],
          evidenceRefs: ["composer:/team", "workspace:board"],
          sourceResultIds: [],
          confidence: "high",
          status: "accepted",
          madeByAgentId: leadAgentId,
          createdAt: now,
        },
      ],
      messages: [],
      fileLocks: [],
      hooks: [
        {
          id: "hook-task-completed-finding",
          title: "Required task needs finding",
          trigger: "TaskCompleted",
          rule: "required_task_needs_finding",
          enabled: true,
          severity: "blocking",
          status: "pending",
          message: "Required task 完成时必须留下 finding。",
        },
        {
          id: "hook-task-completed-evidence",
          title: "Task result should cite evidence",
          trigger: "TaskCompleted",
          rule: "task_needs_evidence",
          enabled: true,
          severity: "warning",
          status: "pending",
          message: "任务结果最好带 session、artifact 或文件证据引用。",
        },
        {
          id: "hook-teammate-idle",
          title: "Idle only when no runnable task",
          trigger: "TeammateIdle",
          rule: "idle_requires_no_runnable_tasks",
          enabled: true,
          severity: "warning",
          status: "pending",
          message: "进入 idle 前确认没有可运行任务被遗漏。",
        },
      ],
      qualityGates: [
        {
          id: "gate-required-tasks",
          title: "Required tasks complete",
          status: "pending",
          severity: "blocking",
          message: "所有 required tasks 完成前不能 finalize。",
        },
        {
          id: "gate-open-challenges",
          title: "No open blocking challenges",
          status: "pending",
          severity: "blocking",
          message: "存在 open / needs_evidence challenges 时不能 finalize。",
        },
        {
          id: "gate-lead-synthesis",
          title: "Lead final synthesis",
          status: "pending",
          severity: "blocking",
          message: "Lead 需要给出最终综合并记录 decision。",
        },
      ],
      capabilityAudit: [
        {
          id: "shared-task-list",
          title: "Shared task list",
          claudeCapability:
            "Claude Agent Teams 使用共享 task list，成员可 claim/complete 并自动解锁依赖。",
          digaStatus: "partial",
          evidence: ["lib/agent-team/types.ts: AgentTeamTask"],
          gap: "当前只有 board 数据，尚未驱动真实 teammate 执行。",
          nextStep: "接入 TeamTaskRuntime 和 member claim/complete API。",
        },
        {
          id: "mailbox",
          title: "Inter-agent mailbox",
          claudeCapability:
            "Claude teammates 能通过 mailbox 直接互相发消息。",
          digaStatus: "planned",
          evidence: ["lib/agent-team/types.ts: AgentTeamMessage"],
          gap: "当前只有消息结构，还没有注入成员上下文的投递机制。",
          nextStep: "实现 sendMessage API 和 teammate inbox 注入。",
        },
        {
          id: "independent-teammates",
          title: "Independent teammate sessions",
          claudeCapability:
            "每个 teammate 是独立 Claude Code 实例，有自己的 context window。",
          digaStatus: "planned",
          evidence: ["AgentTeamMember.agentId/sessionFile"],
          gap: "当前启动 Team 时还不会 spawn 子 session。",
          nextStep: "复用 createAgent 生成 hidden teammate records。",
        },
        {
          id: "direct-teammate-interaction",
          title: "Direct teammate interaction",
          claudeCapability:
            "Claude Agent Teams 允许用户直接进入单个 teammate 会话继续追问，而不必经过 lead。",
          digaStatus: "planned",
          evidence: ["AgentTeamMember.sessionFile"],
          gap: "当前 teammate transcript 是二级入口，但还没有 Workspace 内直接追问 teammate 的流程。",
          nextStep: "实现 follow_up_member：把用户追问同步到 mailbox 并投递给指定 teammate。",
        },
        {
          id: "quality-hooks",
          title: "Quality gates and hooks",
          claudeCapability:
            "Claude 支持 TeammateIdle、TaskCreated、TaskCompleted hooks 阻止低质量状态迁移。",
          digaStatus: "partial",
          evidence: ["AgentTeamQualityGate", "AgentTeamHook"],
          gap: "当前已有内置 hook registry，尚未支持用户自定义 hook 脚本。",
          nextStep: "把 hook registry 暴露到 Workspace，并支持用户添加规则。",
        },
        {
          id: "challenge-lifecycle",
          title: "Challenge lifecycle",
          claudeCapability:
            "Claude teammates can challenge findings, request evidence, and resolve or dismiss challenges before synthesis.",
          digaStatus: "planned",
          evidence: ["AgentTeamChallenge"],
          gap: "当前仅有 challenge 数据结构；需要 create/resolve/dismiss API 和 Workspace 操作。",
          nextStep: "实现 challenge lifecycle runtime mutations。",
        },
        {
          id: "decision-traceability",
          title: "Decision traceability",
          claudeCapability:
            "Lead decisions should be traceable to accepted findings, resolved challenges, and evidence.",
          digaStatus: "planned",
          evidence: ["AgentTeamDecision"],
          gap: "当前 decision 可显示，但尚未强制绑定 accepted findings 和 evidence。",
          nextStep: "实现 record_decision 并强化 finalize gates。",
        },
        {
          id: "automatic-dispatch",
          title: "Automatic teammate dispatch",
          claudeCapability:
            "Claude lead 会把共享 task list 中的任务分配给 teammates，并等待成员完成后再综合。",
          digaStatus: "planned",
          evidence: ["run_next API planned"],
          gap: "当前尚未自动把可运行任务派给 teammate 执行。",
          nextStep: "实现 run_next 调度：选择 task + teammate，注入 mailbox，回写 finding。",
        },
        {
          id: "file-locking",
          title: "File locking and race prevention",
          claudeCapability:
            "Claude Agent Teams 会通过团队协调和 hooks 降低多个 teammate 同时改同一文件的风险。",
          digaStatus: "planned",
          evidence: ["AgentTeamFileLock planned"],
          gap: "当前 Team board 尚未记录写入路径锁，无法阻止成员并发修改同一路径。",
          nextStep: "把 fileLocks 加入 board，任务 claim 时获取锁，完成或 shutdown 时释放。",
        },
        {
          id: "shutdown-cleanup",
          title: "Shutdown and cleanup",
          claudeCapability:
            "Claude Agent Teams 在会话退出或停止时清理 team 状态，避免残留运行中的 teammate。",
          digaStatus: "planned",
          evidence: ["team_aborted event"],
          gap: "当前 stop 只改变 Team run 状态，尚未释放资源或中止 teammate session。",
          nextStep: "实现 shutdown：释放 file locks，并请求中止未完成 teammate session。",
        },
        {
          id: "failure-recovery",
          title: "Failure retry and replacement",
          claudeCapability:
            "Claude Agent Teams 可以在 teammate 失败或卡住后重试任务，并由其他 teammate 接手。",
          digaStatus: "planned",
          evidence: ["AgentTeamTask.retryCount planned"],
          gap: "当前 dispatch 失败只记录消息，尚未把任务恢复为可重试或替换 teammate。",
          nextStep: "实现 fail/retry task 和 replace_member。",
        },
      ],
      events: [
        {
          id: `${runId}:event:created`,
          type: "team_created",
          at: now,
          actorAgentId: leadAgentId,
          message: "Team run created with local shared board.",
        },
      ],
    },
    settings: normalizedSettings,
    plannerProfile: plan.profile,
    plannerInputs: { objective, tags: plan.tags },
    createdAt: now,
    updatedAt: now,
  };
}

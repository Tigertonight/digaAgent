import type { AgentTeamMember, AgentTeamSettings, AgentTeamTask } from "./types";

export type AgentTeamPlannerTag = "code" | "research" | "qa" | "writing" | "data" | "multi";

export interface AgentTeamPlanInput {
  objective: string;
  settings: AgentTeamSettings;
  runId: string;
  leadAgentId: string;
  now: number;
  hints?: {
    tags?: AgentTeamPlannerTag[];
  };
}

export interface AgentTeamPlanOutput {
  members: AgentTeamMember[];
  tasks: AgentTeamTask[];
  tags: AgentTeamPlannerTag[];
  rationale: string;
  profile: "deterministic";
}

const TAG_PATTERNS: Array<[AgentTeamPlannerTag, RegExp]> = [
  ["code", /代码|实现|修复|改文件|review|重构|bug|code|fix|implement|refactor|repo|仓库/i],
  ["research", /调研|研究|资料|搜索|竞品|市场|外部|research|survey|source|evidence/i],
  ["qa", /测试|验收|回归|质量|稳定|风险|audit|qa|test|verify|validation/i],
  ["writing", /文案|报告|总结|文章|写作|方案|doc|docs|report|writing|copy/i],
  ["data", /数据|表格|指标|统计|sql|csv|excel|analysis|dataset|metric/i],
  ["multi", /全面|复杂|多视角|并行|架构|系统|全链路|multi|complex|architecture|parallel/i],
];

function uniqueTags(tags: AgentTeamPlannerTag[]): AgentTeamPlannerTag[] {
  return [...new Set(tags)];
}

export function inferAgentTeamPlannerTags(objective: string): AgentTeamPlannerTag[] {
  const tags = TAG_PATTERNS.flatMap(([tag, pattern]) => (pattern.test(objective) ? [tag] : []));
  return uniqueTags(tags.length > 0 ? tags : ["research"]);
}

function member(
  id: string,
  name: string,
  role: string,
  latestOutput: string,
  status: AgentTeamMember["status"] = "idle"
): AgentTeamMember {
  return { id, name, role, status, latestOutput };
}

function chooseMembers(input: AgentTeamPlanInput, tags: AgentTeamPlannerTag[]): AgentTeamMember[] {
  const { runId, leadAgentId, settings } = input;
  const lead = member(
    leadAgentId,
    "Lead",
    "裁判 / 综合",
    "建立共享白板，等待成员认领任务。",
    "working"
  );
  lead.currentTaskId = "frame";

  const byId = new Map<string, AgentTeamMember>();
  const add = (item: AgentTeamMember) => {
    if (!byId.has(item.id)) byId.set(item.id, item);
  };

  add(lead);
  add(member(`${runId}:researcher`, "Research", "资料 / 证据", "等待任务租约。"));
  if (settings.allowChallenges || tags.includes("multi")) {
    add(member(`${runId}:critic`, "Critic", "挑战 / 反证", "等待可挑战的发现。"));
  }
  add(member(`${runId}:synthesizer`, "Synthesis", "结构 / 决策", "等待 board 汇总。"));

  if (settings.memberScale !== "small" || tags.includes("qa")) {
    add(member(`${runId}:validator`, "Validation", "验收 / 证据核查", "等待验收任务。"));
  }
  if (settings.allowWrite || tags.includes("code")) {
    add(member(`${runId}:builder`, "Builder", "实现 / 写入规划", "等待实现或计划任务。"));
  }
  if (tags.includes("research") && (settings.memberScale === "deep" || tags.includes("multi"))) {
    add(member(`${runId}:scout`, "Scout", "横向探索 / 补充资料", "等待探索任务。"));
  }
  if (tags.includes("code") && settings.memberScale === "deep") {
    add(member(`${runId}:reviewer`, "Reviewer", "代码审查 / 风险复核", "等待代码审查任务。"));
  }
  if (tags.includes("data") && settings.memberScale === "deep") {
    add(member(`${runId}:analyst`, "Analyst", "数据 / 指标分析", "等待数据分析任务。"));
  }

  const maxMembers =
    settings.memberScale === "small" ? 3 : settings.memberScale === "deep" ? 7 : 5;
  const specialistOrder =
    settings.allowWrite || tags.includes("code")
      ? [
          `${runId}:builder`,
          `${runId}:validator`,
          `${runId}:scout`,
          `${runId}:reviewer`,
          `${runId}:analyst`,
        ]
      : [
          `${runId}:validator`,
          `${runId}:builder`,
          `${runId}:scout`,
          `${runId}:reviewer`,
          `${runId}:analyst`,
        ];
  const preferredOrder = [
    leadAgentId,
    `${runId}:researcher`,
    `${runId}:critic`,
    `${runId}:synthesizer`,
    ...specialistOrder,
  ];
  return preferredOrder
    .map((id) => byId.get(id))
    .filter((item): item is AgentTeamMember => Boolean(item))
    .slice(0, maxMembers);
}

function taskBase(input: AgentTeamPlanInput, tags: AgentTeamPlannerTag[]): AgentTeamTask[] {
  const { leadAgentId, now, objective, settings } = input;
  const focus = objective.trim() || "当前目标";
  const evidenceDescription = tags.includes("code")
    ? `定位与「${focus}」相关的代码、测试、状态流和风险点，必须给出文件或 session 证据。`
    : tags.includes("research")
      ? `围绕「${focus}」收集来源、事实依据和不确定点，必要时区分内部证据与外部资料。`
      : `围绕「${focus}」收集证据、关键事实和不确定点。`;
  const synthesisDescription = tags.includes("writing")
    ? "把已采纳 findings 和已解决 challenges 收敛成用户可直接使用的报告/结论。"
    : "基于已采纳 findings 和已解决 challenges 记录最终 decision，并直接回答用户问题。";

  const tasks: AgentTeamTask[] = [
    {
      id: "frame",
      title: "界定问题",
      description: `确认「${focus}」的目标、约束、成功标准和需要显式裁决的地方。`,
      status: "running",
      ownerAgentId: leadAgentId,
      claimedAt: now,
      priority: "high",
      required: true,
      findingIds: ["f-mode"],
      expectedOutput: "findings",
      evidenceRequired: true,
    },
    {
      id: "evidence",
      title: tags.includes("code") ? "定位代码与证据" : "收集证据",
      description: evidenceDescription,
      status: "pending",
      priority: "high",
      required: true,
      findingIds: [],
      dependsOnTaskIds: ["frame"],
      expectedOutput: "findings",
      evidenceRequired: true,
    },
  ];

  if (settings.allowChallenges) {
    const challengeRequired = settings.mode === "audit";
    tasks.push({
      id: "challenge",
      title: tags.includes("qa") ? "风险与回归挑战" : "挑战结论",
      description: "对关键发现做反证、找冲突、标出需要继续探索的地方。",
      status: "pending",
      priority: "normal",
      required: challengeRequired,
      findingIds: [],
      dependsOnTaskIds: ["evidence"],
      expectedOutput: "review",
      evidenceRequired: true,
    });
  }

  if (tags.includes("qa")) {
    tasks.push({
      id: "validation",
      title: "验收与回归核查",
      description: "验证关键发现是否有足够证据，并列出需要补测或复核的路径。",
      status: "pending",
      priority: "normal",
      required: false,
      findingIds: [],
      dependsOnTaskIds: settings.allowChallenges ? ["challenge"] : ["evidence"],
      expectedOutput: "review",
      evidenceRequired: true,
    });
  }

  tasks.push({
    id: "synthesis",
    title: tags.includes("writing") ? "形成可交付报告" : "形成可追溯综合",
    description: synthesisDescription,
    status: "pending",
    priority: "high",
    required: true,
    findingIds: [],
    dependsOnTaskIds:
      settings.allowChallenges && settings.mode === "audit"
        ? ["challenge"]
        : ["evidence"],
    expectedOutput: "decision_input",
    evidenceRequired: true,
  });

  if (settings.allowWrite) {
    tasks.push({
      id: "implementation-plan",
      title: settings.requirePlanApproval ? "提交写入计划" : "规划写入任务",
      description: settings.requirePlanApproval
        ? "写入前先提交 plan，等待 Lead 批准后才能执行写工具。"
        : "识别需要写入的文件和验收方式。",
      status: settings.requirePlanApproval ? "needs_plan" : "pending",
      priority: "normal",
      required: false,
      findingIds: [],
      dependsOnTaskIds: ["frame"],
      expectedOutput: "plan",
      evidenceRequired: false,
      writePaths: [],
    });
  }

  return tasks;
}

export function planAgentTeamDeterministic(input: AgentTeamPlanInput): AgentTeamPlanOutput {
  const tags = uniqueTags([...(input.hints?.tags ?? []), ...inferAgentTeamPlannerTags(input.objective)]);
  const members = chooseMembers(input, tags);
  const tasks = taskBase(input, tags);
  return {
    profile: "deterministic",
    tags,
    members,
    tasks,
    rationale: `Deterministic planner selected tags [${tags.join(", ")}], ${members.length} members, and ${tasks.length} tasks for this objective.`,
  };
}

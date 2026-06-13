import type {
  EvaluatorWeightProfile,
  RubricCriterion,
  RubricSpec,
} from "./types";

export const DEFAULT_IMPORTANCE_WEIGHTS: EvaluatorWeightProfile["importanceWeights"] = {
  essential: 1,
  important: 0.7,
  optional: 0.3,
  pitfall: 0.9,
};

export const CODING_DEFAULT_PROFILE: EvaluatorWeightProfile = {
  version: "1",
  profileId: "coding.default",
  taskClass: "coding",
  targetScore: 0.88,
  dimensions: [
    { id: "functional_correctness", name: "功能/验收正确性", weight: 0.4, minScore: 0.85 },
    { id: "robustness_safety", name: "健壮性/安全性", weight: 0.2, minScore: 0.75 },
    { id: "codebase_fit", name: "代码库契合度", weight: 0.2, minScore: 0.75 },
    { id: "verification_evidence", name: "验证证据", weight: 0.1, minScore: 0.7 },
    { id: "ux_operability", name: "用户体验/可操作性", weight: 0.1 },
  ],
  baseCriteria: [
    {
      id: "coding-objective-met",
      dimensionId: "functional_correctness",
      importance: "essential",
      description: "代码改动满足用户目标和验收标准。",
      evidenceRequired: ["diff", "test_result"],
      minEvidenceTrust: "deterministic_check",
      hardFail: true,
    },
    {
      id: "coding-verification-present",
      dimensionId: "verification_evidence",
      importance: "essential",
      description: "提供了测试、类型检查、lint 或等价的确定性验证结果。",
      evidenceRequired: ["test_result"],
      minEvidenceTrust: "deterministic_check",
      hardFail: true,
    },
    {
      id: "coding-scope-contained",
      dimensionId: "codebase_fit",
      importance: "important",
      description: "变更范围克制，符合现有代码结构，不做无关重构。",
      evidenceRequired: ["diff"],
      minEvidenceTrust: "artifact_reference",
    },
    {
      id: "coding-no-secret-leak",
      dimensionId: "robustness_safety",
      importance: "pitfall",
      description: "没有泄露密钥、隐私信息或敏感配置。",
      hardFail: true,
    },
  ],
  importanceWeights: DEFAULT_IMPORTANCE_WEIGHTS,
  exitPolicy: {
    maxIterations: 4,
    minDelta: 0.02,
    blockedRepeatLimit: 3,
    scoreCapWithoutEvidence: 0.7,
  },
};

export const CODING_FRONTEND_UI_PROFILE: EvaluatorWeightProfile = {
  version: "1",
  profileId: "coding.frontend-ui",
  taskClass: "coding",
  targetScore: 0.9,
  dimensions: [
    { id: "functional_correctness", name: "功能正确性", weight: 0.4, minScore: 0.85 },
    { id: "robustness_safety", name: "健壮性", weight: 0.25, minScore: 0.75 },
    { id: "ui_presentation", name: "UI 呈现", weight: 0.2, minScore: 0.8 },
    { id: "interaction_experience", name: "交互体验", weight: 0.15, minScore: 0.8 },
  ],
  importanceWeights: DEFAULT_IMPORTANCE_WEIGHTS,
  exitPolicy: {
    maxIterations: 4,
    minDelta: 0.02,
    blockedRepeatLimit: 3,
    scoreCapWithoutEvidence: 0.7,
  },
};

export const DESKTOP_DEFAULT_PROFILE: EvaluatorWeightProfile = {
  version: "1",
  profileId: "desktop.default",
  taskClass: "desktop_assistant",
  targetScore: 0.9,
  dimensions: [
    { id: "intent_result_correctness", name: "意图/结果正确性", weight: 0.3, minScore: 0.85 },
    {
      id: "safety_privacy_authorization",
      name: "安全/隐私/授权边界",
      weight: 0.3,
      minScore: 0.95,
    },
    {
      id: "evidence_environment_awareness",
      name: "证据与环境感知",
      weight: 0.2,
      minScore: 0.75,
    },
    { id: "process_reliability", name: "流程可靠性", weight: 0.1 },
    { id: "communication_handoff", name: "沟通与交接", weight: 0.1 },
  ],
  baseCriteria: [
    {
      id: "desktop-objective-met",
      dimensionId: "intent_result_correctness",
      importance: "essential",
      description: "执行结果符合用户意图和当前桌面环境。",
      evidenceRequired: ["workflow_artifact", "goal_evidence"],
      minEvidenceTrust: "artifact_reference",
      hardFail: true,
    },
    {
      id: "desktop-safe-boundary",
      dimensionId: "safety_privacy_authorization",
      importance: "essential",
      description: "遵守隐私、安全和授权边界。",
      hardFail: true,
    },
  ],
  importanceWeights: DEFAULT_IMPORTANCE_WEIGHTS,
  exitPolicy: {
    maxIterations: 3,
    minDelta: 0.02,
    blockedRepeatLimit: 3,
    scoreCapWithoutEvidence: 0.65,
  },
};

export const DESKTOP_EXTERNAL_ACTION_PROFILE: EvaluatorWeightProfile = {
  ...DESKTOP_DEFAULT_PROFILE,
  profileId: "desktop.external-action",
  targetScore: 0.95,
  dimensions: [
    { id: "intent_result_correctness", name: "意图/结果正确性", weight: 0.25, minScore: 0.85 },
    {
      id: "safety_privacy_authorization",
      name: "安全/隐私/授权边界",
      weight: 0.45,
      minScore: 0.98,
    },
    {
      id: "evidence_environment_awareness",
      name: "证据与环境感知",
      weight: 0.15,
      minScore: 0.8,
    },
    { id: "process_reliability", name: "流程可靠性", weight: 0.1 },
    { id: "communication_handoff", name: "沟通与交接", weight: 0.05 },
  ],
  baseCriteria: [
    ...(DESKTOP_DEFAULT_PROFILE.baseCriteria ?? []),
    {
      id: "external-action-authorized",
      dimensionId: "safety_privacy_authorization",
      importance: "essential",
      description: "外部公开动作、删除、覆盖、推送、发送前已经获得用户确认。",
      evidenceRequired: ["approval_event"],
      minEvidenceTrust: "host_observed",
      hardFail: true,
    },
    {
      id: "external-action-reversible",
      dimensionId: "safety_privacy_authorization",
      importance: "important",
      description: "动作可撤回，或已经清楚说明不可逆风险。",
    },
  ],
  exitPolicy: {
    maxIterations: 3,
    requireConsecutivePasses: 2,
    minDelta: 0.02,
    blockedRepeatLimit: 3,
    scoreCapWithoutEvidence: 0.5,
  },
};

export const WORKFLOW_DEFAULT_PROFILE: EvaluatorWeightProfile = {
  version: "1",
  profileId: "workflow.default",
  taskClass: "workflow",
  targetScore: 0.9,
  dimensions: [
    { id: "objective_completion", name: "目标完成度", weight: 0.35, minScore: 0.85 },
    { id: "runtime_reliability", name: "运行可靠性", weight: 0.25, minScore: 0.8 },
    { id: "evidence_traceability", name: "证据可追溯性", weight: 0.25, minScore: 0.75 },
    { id: "handoff_quality", name: "交接质量", weight: 0.15 },
  ],
  importanceWeights: DEFAULT_IMPORTANCE_WEIGHTS,
  exitPolicy: {
    maxIterations: 4,
    minDelta: 0.02,
    blockedRepeatLimit: 3,
    scoreCapWithoutEvidence: 0.7,
  },
};

export const ANALYSIS_RESEARCH_PROFILE: EvaluatorWeightProfile = {
  version: "1",
  profileId: "analysis.research",
  taskClass: "analysis",
  targetScore: 0.9,
  dimensions: [
    { id: "answer_relevance", name: "问题回应度", weight: 0.25, minScore: 0.85 },
    { id: "source_evidence", name: "来源与证据", weight: 0.35, minScore: 0.8 },
    { id: "uncertainty_handling", name: "不确定性处理", weight: 0.2, minScore: 0.75 },
    { id: "handoff_quality", name: "交接质量", weight: 0.2 },
  ],
  baseCriteria: [
    {
      id: "research-answer-relevant",
      dimensionId: "answer_relevance",
      importance: "essential",
      description: "回答直接回应用户问题，不偏离主题。",
      evidenceRequired: ["workflow_artifact"],
      minEvidenceTrust: "artifact_reference",
      hardFail: true,
    },
    {
      id: "research-source-backed",
      dimensionId: "source_evidence",
      importance: "essential",
      description: "关键结论有来源、证据或可追溯材料支撑。",
      evidenceRequired: ["url", "workflow_artifact"],
      minEvidenceTrust: "artifact_reference",
      hardFail: true,
    },
    {
      id: "research-uncertainty-stated",
      dimensionId: "uncertainty_handling",
      importance: "important",
      description: "明确标注不确定性、假设和需要进一步核验的内容。",
    },
  ],
  importanceWeights: DEFAULT_IMPORTANCE_WEIGHTS,
  exitPolicy: {
    maxIterations: 4,
    minDelta: 0.02,
    blockedRepeatLimit: 3,
    scoreCapWithoutEvidence: 0.65,
  },
};

export const ATTRIBUTION_ANALYSIS_PROFILE: EvaluatorWeightProfile = {
  version: "1",
  profileId: "attribution.analysis",
  taskClass: "analysis",
  targetScore: 0.9,
  dimensions: [
    { id: "problem_framing", name: "问题界定", weight: 0.25, minScore: 0.85 },
    { id: "causal_depth", name: "归因深度", weight: 0.3, minScore: 0.8 },
    { id: "evidence_strength", name: "证据强度", weight: 0.25, minScore: 0.75 },
    { id: "actionability", name: "行动可用性", weight: 0.2 },
  ],
  baseCriteria: [
    {
      id: "attribution-problem-framed",
      dimensionId: "problem_framing",
      importance: "essential",
      description: "清楚区分现象、问题、直接原因和结构原因。",
      evidenceRequired: ["workflow_artifact"],
      minEvidenceTrust: "artifact_reference",
      hardFail: true,
    },
    {
      id: "attribution-no-single-cause",
      dimensionId: "causal_depth",
      importance: "pitfall",
      description: "避免把复杂问题简化为单一原因。",
      hardFail: true,
    },
    {
      id: "attribution-evidence-strength",
      dimensionId: "evidence_strength",
      importance: "important",
      description: "区分事实证据、推断和待验证假设。",
      evidenceRequired: ["workflow_artifact"],
      minEvidenceTrust: "artifact_reference",
    },
  ],
  importanceWeights: DEFAULT_IMPORTANCE_WEIGHTS,
  exitPolicy: {
    maxIterations: 4,
    minDelta: 0.02,
    blockedRepeatLimit: 3,
    scoreCapWithoutEvidence: 0.65,
  },
};

export const TEACHER_WORKFLOW_PROFILE: EvaluatorWeightProfile = {
  version: "1",
  profileId: "teacher.workflow",
  taskClass: "analysis",
  targetScore: 0.9,
  dimensions: [
    { id: "teaching_goal_fit", name: "教学目标匹配", weight: 0.3, minScore: 0.85 },
    { id: "material_usability", name: "材料可用性", weight: 0.3, minScore: 0.8 },
    { id: "student_level_fit", name: "学情适配", weight: 0.2, minScore: 0.75 },
    { id: "classroom_handoff", name: "课堂交接", weight: 0.2 },
  ],
  importanceWeights: DEFAULT_IMPORTANCE_WEIGHTS,
  exitPolicy: {
    maxIterations: 3,
    minDelta: 0.02,
    blockedRepeatLimit: 3,
    scoreCapWithoutEvidence: 0.65,
  },
};

export const SKILL_EVAL_PROFILE: EvaluatorWeightProfile = {
  version: "1",
  profileId: "skill.eval",
  taskClass: "workflow",
  targetScore: 0.92,
  dimensions: [
    { id: "skill_trigger_fit", name: "触发与边界", weight: 0.25, minScore: 0.85 },
    { id: "case_coverage", name: "用例覆盖", weight: 0.3, minScore: 0.85 },
    { id: "rubric_quality", name: "评估标准质量", weight: 0.25, minScore: 0.8 },
    { id: "package_handoff", name: "分发交接", weight: 0.2 },
  ],
  importanceWeights: DEFAULT_IMPORTANCE_WEIGHTS,
  exitPolicy: {
    maxIterations: 5,
    minDelta: 0.02,
    blockedRepeatLimit: 3,
    scoreCapWithoutEvidence: 0.6,
  },
};

export const EVALUATOR_WEIGHT_PROFILES: EvaluatorWeightProfile[] = [
  CODING_DEFAULT_PROFILE,
  CODING_FRONTEND_UI_PROFILE,
  DESKTOP_DEFAULT_PROFILE,
  DESKTOP_EXTERNAL_ACTION_PROFILE,
  WORKFLOW_DEFAULT_PROFILE,
  ANALYSIS_RESEARCH_PROFILE,
  ATTRIBUTION_ANALYSIS_PROFILE,
  TEACHER_WORKFLOW_PROFILE,
  SKILL_EVAL_PROFILE,
];

export function getEvaluatorWeightProfile(
  profileId: string
): EvaluatorWeightProfile | undefined {
  return EVALUATOR_WEIGHT_PROFILES.find((profile) => profile.profileId === profileId);
}

export function createRubricSpecFromProfile(
  profile: EvaluatorWeightProfile,
  input: {
    id: string;
    title: string;
    criteria: RubricCriterion[];
    createdAt?: number;
    version?: string;
    targetScore?: number;
  }
): RubricSpec {
  return {
    id: input.id,
    version: input.version ?? profile.version,
    title: input.title,
    profileId: profile.profileId,
    taskClass: profile.taskClass,
    targetScore: input.targetScore ?? profile.targetScore,
    dimensions: profile.dimensions,
    criteria: input.criteria,
    importanceWeights: profile.importanceWeights,
    exitPolicy: profile.exitPolicy,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function mergeProfileWithDynamicCriteria(
  profile: EvaluatorWeightProfile,
  input: {
    id: string;
    title: string;
    criteria?: RubricCriterion[];
    createdAt?: number;
    version?: string;
    targetScore?: number;
  }
): RubricSpec {
  const dimensionIds = new Set(profile.dimensions.map((dimension) => dimension.id));
  const baseCriteria = profile.baseCriteria ?? [];
  const fixedIds = new Set(baseCriteria.map((criterion) => criterion.id));
  const dynamicCriteria = input.criteria ?? [];

  for (const criterion of dynamicCriteria) {
    if (!dimensionIds.has(criterion.dimensionId)) {
      throw new Error(
        `dynamic criterion ${criterion.id} references unknown profile dimension: ${criterion.dimensionId}`
      );
    }
    if (fixedIds.has(criterion.id)) {
      throw new Error(
        `dynamic criterion cannot override fixed profile criterion: ${criterion.id}`
      );
    }
  }

  return createRubricSpecFromProfile(profile, {
    id: input.id,
    title: input.title,
    criteria: [...baseCriteria, ...dynamicCriteria],
    createdAt: input.createdAt,
    version: input.version,
    targetScore:
      typeof input.targetScore === "number"
        ? Math.max(profile.targetScore, input.targetScore)
        : profile.targetScore,
  });
}

export type TaskClass =
  | "coding"
  | "desktop_assistant"
  | "analysis"
  | "workflow";

export type RubricImportance =
  | "essential"
  | "important"
  | "optional"
  | "pitfall";

export type RubricCriterionStatus =
  | "pass"
  | "partial"
  | "fail"
  | "accepted_skip";

export type RubricEvaluationStatus =
  | "passed"
  | "warning"
  | "failed"
  | "blocked";

export type EvaluationRecommendation =
  | "pass"
  | "iterate"
  | "ask_user"
  | "blocked"
  | "stop_low_delta";

export interface EvaluationSubject {
  agentId?: string;
  workflowId?: string;
  batchId?: string;
  taskId?: string;
  goalId?: string;
}

export interface RubricDimension {
  id: string;
  name: string;
  weight: number;
  minScore?: number;
}

export interface EvaluationExitPolicy {
  maxIterations: number;
  requireConsecutivePasses?: number;
  minDelta?: number;
  blockedRepeatLimit: number;
  scoreCapWithoutEvidence?: number;
}

export interface EvaluatorWeightProfile {
  version: string;
  profileId: string;
  taskClass: TaskClass;
  targetScore: number;
  dimensions: RubricDimension[];
  baseCriteria?: RubricCriterion[];
  importanceWeights: {
    essential: number;
    important: number;
    optional: number;
    pitfall: number;
  };
  exitPolicy: EvaluationExitPolicy;
}

export interface RubricCriterion {
  id: string;
  dimensionId: string;
  importance: RubricImportance;
  description: string;
  itemWeight?: number;
  evidenceRequired?: string[];
  minEvidenceTrust?: EvaluationEvidenceTrustLevel;
  hardFail?: boolean;
}

export interface RubricSpec {
  id: string;
  version: string;
  title: string;
  profileId: string;
  taskClass?: TaskClass;
  targetScore: number;
  dimensions: RubricDimension[];
  criteria: RubricCriterion[];
  importanceWeights?: EvaluatorWeightProfile["importanceWeights"];
  exitPolicy: EvaluationExitPolicy;
  createdAt: number;
}

export interface CriterionScore {
  criterionId: string;
  status: RubricCriterionStatus;
  score: number;
  reason: string;
  evidenceIds?: string[];
}

export type EvaluationEvidenceTrustLevel =
  | "agent_reported"
  | "textual_log"
  | "artifact_reference"
  | "deterministic_check"
  | "host_observed"
  | "user_confirmed";

export interface EvaluationEvidence {
  id: string;
  kind:
    | "workflow_artifact"
    | "workflow_checkpoint"
    | "workflow_log"
    | "goal_evidence"
    | "subagent_session"
    | "test_result"
    | "diff"
    | "screenshot"
    | "url"
    | "other";
  title: string;
  href?: string;
  summary?: string;
  trustLevel?: EvaluationEvidenceTrustLevel;
  source?: string;
  verifiable?: boolean;
  createdAt?: number;
}

export interface RubricDimensionScore {
  dimensionId: string;
  score: number;
  weight: number;
  minScore?: number;
}

export interface RubricEvaluation {
  id: string;
  rubricId: string;
  evaluatorVersion: string;
  subject: EvaluationSubject;
  status: RubricEvaluationStatus;
  totalScore: number;
  targetScore: number;
  dimensionScores: RubricDimensionScore[];
  criteria: CriterionScore[];
  hardFails: string[];
  failedCriteria: string[];
  triggeredPitfalls: string[];
  missingEvidence: string[];
  minScoreFailures: string[];
  recommendation: EvaluationRecommendation;
  nextAction: string;
  evidence?: EvaluationEvidence[];
  weightSnapshot: {
    profileId: string;
    targetScore: number;
    dimensions: RubricDimension[];
    importanceWeights: EvaluatorWeightProfile["importanceWeights"];
    exitPolicy: EvaluationExitPolicy;
  };
  createdAt: number;
}

export interface CriterionScoreInput {
  criterionId: string;
  status: RubricCriterionStatus;
  score?: number;
  reason?: string;
  evidenceIds?: string[];
}

export interface EvaluateRubricInput {
  rubric: RubricSpec;
  subject?: EvaluationSubject;
  criteria: CriterionScoreInput[];
  previousEvaluations?: Array<
    Pick<RubricEvaluation, "totalScore" | "recommendation" | "status">
  >;
  evidence?: EvaluationEvidence[];
  iteration?: number;
  needsUserInput?: boolean;
  blockerKey?: string;
  repeatedBlockerCount?: number;
  evaluatorVersion?: string;
  evaluationId?: string;
  createdAt?: number;
}

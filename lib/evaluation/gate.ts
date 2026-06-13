import type {
  CriterionScoreInput,
  EvaluateRubricInput,
  EvaluationEvidence,
  EvaluationSubject,
  RubricCriterion,
  RubricDimension,
  RubricEvaluation,
  RubricSpec,
} from "./types";

export const INDEPENDENT_EVALUATOR_GATE_VERSION = "independent-evaluator-gate-v1";

export const FORBIDDEN_EVALUATOR_CONTEXT_KEYS = [
  "script",
  "traceEvents",
  "developer",
  "messages",
  "rawLogs",
  "conversation",
  "prompt",
  "toolCalls",
  "sessionFile",
] as const;

export interface IndependentEvaluatorContractSummary {
  objective: string;
  scope: string[];
  nonGoals: string[];
  requiredEvidence: string[];
  rubricProfile: string;
  stopPolicy: {
    targetScore?: number;
    minDelta?: number;
    maxIterations?: number;
    askUserWhenBlocked?: boolean;
  };
}

/**
 * Minimal shape accepted as a contract source. Anything providing these
 * (e.g. a harness contract) can be summarized for the independent evaluator
 * without coupling this module to a specific harness implementation.
 */
export type EvaluatorContractSource = Partial<IndependentEvaluatorContractSummary>;

export interface IndependentEvaluatorInput {
  gate: {
    version: typeof INDEPENDENT_EVALUATOR_GATE_VERSION;
    createdAt: number;
    excludedContext: string[];
    inputPolicy: string;
  };
  contract: IndependentEvaluatorContractSummary;
  rubric: RubricSpec;
  scores: CriterionScoreInput[];
  subject?: EvaluationSubject;
  evidence?: EvaluationEvidence[];
  previousEvaluations?: EvaluateRubricInput["previousEvaluations"];
  finalOutput?: string;
  iteration?: number;
  needsUserInput?: boolean;
  blockerKey?: string;
  repeatedBlockerCount?: number;
  evaluatorVersion?: string;
  evaluationId?: string;
  createdAt?: number;
}

export interface BuildIndependentEvaluatorInputArgs {
  contract?: EvaluatorContractSource;
  objective?: string;
  rubric: RubricSpec;
  scores: CriterionScoreInput[];
  subject?: EvaluationSubject;
  evidence?: EvaluationEvidence[];
  previousEvaluations?: EvaluateRubricInput["previousEvaluations"];
  finalOutput?: unknown;
  iteration?: number;
  needsUserInput?: boolean;
  blockerKey?: string;
  repeatedBlockerCount?: number;
  evaluatorVersion?: string;
  evaluationId?: string;
  createdAt?: number;
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value === "string") return value.trim().slice(0, maxLength);
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

function cleanStringArray(value: unknown, maxItems = 40, maxLength = 500): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => cleanText(item, maxLength))
        .filter(Boolean)
        .slice(0, maxItems)
    : [];
}

function contractSummaryFrom(
  contract: BuildIndependentEvaluatorInputArgs["contract"],
  objective: string,
  rubric: RubricSpec
): IndependentEvaluatorContractSummary {
  return {
    objective: cleanText(
      contract && "objective" in contract ? contract.objective : objective,
      2000
    ),
    scope: cleanStringArray(contract && "scope" in contract ? contract.scope : []),
    nonGoals: cleanStringArray(contract && "nonGoals" in contract ? contract.nonGoals : []),
    requiredEvidence: cleanStringArray(
      contract && "requiredEvidence" in contract
        ? contract.requiredEvidence
        : rubric.criteria.flatMap((criterion) => criterion.evidenceRequired ?? [])
    ),
    rubricProfile: cleanText(
      contract && "rubricProfile" in contract ? contract.rubricProfile : rubric.profileId,
      160
    ),
    stopPolicy: {
      targetScore:
        contract && "stopPolicy" in contract
          ? contract.stopPolicy?.targetScore
          : rubric.targetScore,
      minDelta:
        contract && "stopPolicy" in contract
          ? contract.stopPolicy?.minDelta
          : rubric.exitPolicy.minDelta,
      maxIterations:
        contract && "stopPolicy" in contract
          ? contract.stopPolicy?.maxIterations
          : rubric.exitPolicy.maxIterations,
      askUserWhenBlocked:
        contract && "stopPolicy" in contract
          ? contract.stopPolicy?.askUserWhenBlocked
          : undefined,
    },
  };
}

function cleanDimension(dimension: RubricDimension): RubricDimension {
  return {
    id: cleanText(dimension.id, 160),
    name: cleanText(dimension.name, 300),
    weight: dimension.weight,
    minScore: dimension.minScore,
  };
}

function cleanCriterion(criterion: RubricCriterion): RubricCriterion {
  return {
    id: cleanText(criterion.id, 160),
    dimensionId: cleanText(criterion.dimensionId, 160),
    importance: criterion.importance,
    description: cleanText(criterion.description, 1000),
    itemWeight: criterion.itemWeight,
    evidenceRequired: cleanStringArray(criterion.evidenceRequired, 20, 200),
    minEvidenceTrust: criterion.minEvidenceTrust,
    hardFail: criterion.hardFail,
  };
}

function cleanRubric(rubric: RubricSpec): RubricSpec {
  return {
    id: cleanText(rubric.id, 160),
    version: cleanText(rubric.version, 80),
    title: cleanText(rubric.title, 500),
    profileId: cleanText(rubric.profileId, 160),
    taskClass: rubric.taskClass,
    targetScore: rubric.targetScore,
    dimensions: rubric.dimensions.map(cleanDimension).slice(0, 20),
    criteria: rubric.criteria.map(cleanCriterion).slice(0, 100),
    importanceWeights: rubric.importanceWeights,
    exitPolicy: { ...rubric.exitPolicy },
    createdAt: rubric.createdAt,
  };
}

function cleanScore(score: CriterionScoreInput): CriterionScoreInput {
  return {
    criterionId: cleanText(score.criterionId, 160),
    status: score.status,
    score: score.score,
    reason: cleanText(score.reason, 1000) || undefined,
    evidenceIds: cleanStringArray(score.evidenceIds, 50, 200),
  };
}

function cleanEvidence(evidence: EvaluationEvidence): EvaluationEvidence {
  return {
    id: cleanText(evidence.id, 200),
    kind: evidence.kind,
    title: cleanText(evidence.title, 500),
    href: cleanText(evidence.href, 1000) || undefined,
    summary: cleanText(evidence.summary, 1000) || undefined,
    trustLevel: evidence.trustLevel,
    source: cleanText(evidence.source, 200) || undefined,
    verifiable: evidence.verifiable,
    createdAt: evidence.createdAt,
  };
}

function cleanPreviousEvaluation(
  evaluation: Pick<RubricEvaluation, "totalScore" | "recommendation" | "status">
): Pick<RubricEvaluation, "totalScore" | "recommendation" | "status"> {
  return {
    totalScore: evaluation.totalScore,
    recommendation: evaluation.recommendation,
    status: evaluation.status,
  };
}

export function buildIndependentEvaluatorInput(
  args: BuildIndependentEvaluatorInputArgs
): IndependentEvaluatorInput {
  const rubric = cleanRubric(args.rubric);
  const objective = cleanText(args.objective, 2000);
  return {
    gate: {
      version: INDEPENDENT_EVALUATOR_GATE_VERSION,
      createdAt: args.createdAt ?? Date.now(),
      excludedContext: FORBIDDEN_EVALUATOR_CONTEXT_KEYS.slice(),
      inputPolicy:
        "Evaluator sees only contract summary, rubric, criterion scores, evidence references, and optional final output.",
    },
    contract: contractSummaryFrom(args.contract, objective, rubric),
    rubric,
    scores: args.scores.map(cleanScore).slice(0, 100),
    subject: args.subject,
    evidence: args.evidence?.map(cleanEvidence).slice(0, 200),
    previousEvaluations: args.previousEvaluations
      ?.map(cleanPreviousEvaluation)
      .slice(-10),
    finalOutput: cleanText(args.finalOutput, 4000) || undefined,
    iteration: args.iteration,
    needsUserInput: args.needsUserInput,
    blockerKey: cleanText(args.blockerKey, 200) || undefined,
    repeatedBlockerCount: args.repeatedBlockerCount,
    evaluatorVersion: cleanText(args.evaluatorVersion, 160) || undefined,
    evaluationId: cleanText(args.evaluationId, 160) || undefined,
    createdAt: args.createdAt,
  };
}

export function toEvaluateRubricInput(
  input: IndependentEvaluatorInput
): EvaluateRubricInput {
  return {
    rubric: input.rubric,
    subject: input.subject,
    criteria: input.scores,
    previousEvaluations: input.previousEvaluations,
    evidence: input.evidence,
    iteration: input.iteration,
    needsUserInput: input.needsUserInput,
    blockerKey: input.blockerKey,
    repeatedBlockerCount: input.repeatedBlockerCount,
    evaluatorVersion: input.evaluatorVersion,
    evaluationId: input.evaluationId,
    createdAt: input.createdAt,
  };
}

export function findForbiddenEvaluatorContextKeys(value: unknown): string[] {
  const found = new Set<string>();
  const forbidden = new Set(FORBIDDEN_EVALUATOR_CONTEXT_KEYS.map((key) => key.toLowerCase()));

  function visit(node: unknown, path: string, depth: number): void {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) {
      node.slice(0, 100).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (forbidden.has(key.toLowerCase())) found.add(nextPath);
      visit(child, nextPath, depth + 1);
    }
  }

  visit(value, "", 0);
  return Array.from(found);
}

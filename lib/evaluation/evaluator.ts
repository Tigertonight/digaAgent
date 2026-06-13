import { DEFAULT_IMPORTANCE_WEIGHTS } from "./profiles";
import type {
  CriterionScore,
  CriterionScoreInput,
  EvaluateRubricInput,
  EvaluationEvidence,
  EvaluationEvidenceTrustLevel,
  EvaluationRecommendation,
  RubricCriterion,
  RubricDimensionScore,
  RubricEvaluation,
  RubricEvaluationStatus,
  RubricSpec,
} from "./types";

export const RUBRIC_EVALUATOR_VERSION = "rubric-evaluator-v1";

export function isRubricEvaluation(value: unknown): value is RubricEvaluation {
  if (!value || typeof value !== "object") return false;
  const rec = value as Partial<RubricEvaluation>;
  return (
    typeof rec.id === "string" &&
    typeof rec.rubricId === "string" &&
    typeof rec.evaluatorVersion === "string" &&
    typeof rec.totalScore === "number" &&
    typeof rec.targetScore === "number" &&
    (rec.status === "passed" ||
      rec.status === "warning" ||
      rec.status === "failed" ||
      rec.status === "blocked") &&
    Array.isArray(rec.criteria) &&
    Array.isArray(rec.dimensionScores)
  );
}

function clamp(n: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, n));
}

function roundScore(n: number): number {
  return Math.round(clamp(n) * 1000) / 1000;
}

function defaultScore(status: CriterionScoreInput["status"]): number {
  switch (status) {
    case "pass":
      return 1;
    case "partial":
      return 0.5;
    case "fail":
      return 0;
    case "accepted_skip":
      return 1;
  }
}

/**
 * `accepted_skip` grants a passing score and bypasses problem / hard-fail
 * accounting, so it is the one status an agent could abuse to "skip the hard
 * parts" and still clear the gate. It is only legitimate for low-stakes
 * criteria that are explicitly justified. We downgrade it to `fail` when:
 *   - the criterion is `essential` or marked `hardFail` (core requirements can
 *     never be waived by the executor), or
 *   - no human-written skip reason was supplied (a silent skip is a fail).
 * Because every downstream check reads the *normalized* status, downgrading
 * here re-engages problem detection, hard-fail, and essential-failure handling
 * automatically — there is no second place to patch.
 */
function resolveSkipStatus(
  criterion: RubricCriterion,
  input: CriterionScoreInput | undefined
): CriterionScoreInput["status"] {
  if (input?.status !== "accepted_skip") return input?.status ?? "fail";
  const waivable = criterion.importance === "optional" || criterion.importance === "important";
  const hasReason = Boolean(input.reason?.trim());
  if (!waivable || criterion.hardFail || !hasReason) {
    return "fail";
  }
  return "accepted_skip";
}

function normalizeCriterionScores(
  rubric: RubricSpec,
  inputScores: CriterionScoreInput[]
): CriterionScore[] {
  const byId = new Map(inputScores.map((score) => [score.criterionId, score]));
  return rubric.criteria.map((criterion) => {
    const input = byId.get(criterion.id);
    const status = resolveSkipStatus(criterion, input);
    // A skip that was downgraded to fail must not keep the caller's optimistic
    // score; recompute from the resolved status unless an explicit score stands
    // for the *resolved* status.
    const useInputScore =
      typeof input?.score === "number" && status === input.status;
    return {
      criterionId: criterion.id,
      status,
      score: roundScore(useInputScore ? input!.score! : defaultScore(status)),
      reason: input?.reason?.trim() || criterion.description,
      evidenceIds: input?.evidenceIds?.filter(Boolean),
    };
  });
}

const EVIDENCE_TRUST_RANK: Record<EvaluationEvidenceTrustLevel, number> = {
  agent_reported: 0,
  textual_log: 1,
  artifact_reference: 2,
  deterministic_check: 3,
  host_observed: 4,
  user_confirmed: 5,
};

function inferEvidenceTrustLevel(
  evidence: EvaluationEvidence
): EvaluationEvidenceTrustLevel {
  if (evidence.trustLevel) return evidence.trustLevel;
  switch (evidence.kind) {
    case "test_result":
    case "diff":
      return "deterministic_check";
    case "screenshot":
      // A screenshot is raw material for an LLM/human visual judgement, not a
      // deterministic check on its own. Treat it as an artifact reference so it
      // cannot satisfy a deterministic-check evidence requirement unaided.
      return "artifact_reference";
    case "url":
      return "host_observed";
    case "workflow_artifact":
    case "workflow_checkpoint":
    case "goal_evidence":
    case "subagent_session":
      return "artifact_reference";
    case "workflow_log":
      return "textual_log";
    case "other":
    default:
      return "agent_reported";
  }
}

function evidenceMeetsTrust(
  evidence: EvaluationEvidence,
  minimum: EvaluationEvidenceTrustLevel
): boolean {
  return (
    EVIDENCE_TRUST_RANK[inferEvidenceTrustLevel(evidence)] >=
    EVIDENCE_TRUST_RANK[minimum]
  );
}

function minimumTrustForCriterion(
  criterion: RubricCriterion
): EvaluationEvidenceTrustLevel | undefined {
  if (criterion.minEvidenceTrust) return criterion.minEvidenceTrust;
  if (!criterion.evidenceRequired?.length) return undefined;
  if (criterion.importance === "essential") return "deterministic_check";
  if (criterion.importance === "important") return "artifact_reference";
  return undefined;
}

function criterionWeight(
  rubric: RubricSpec,
  criterion: RubricCriterion
): number {
  const importanceWeights = rubric.importanceWeights ?? DEFAULT_IMPORTANCE_WEIGHTS;
  return (importanceWeights[criterion.importance] ?? 1) * (criterion.itemWeight ?? 1);
}

function isCriterionProblem(
  criterion: RubricCriterion,
  score: CriterionScore
): boolean {
  if (score.status === "accepted_skip") return false;
  // A pitfall is a problem when it was triggered (not passed); every other
  // importance is a problem when it did not pass. Both reduce to the same
  // check, kept as one expression rather than two identical branches.
  return score.status !== "pass";
}

function triggersHardFail(
  criterion: RubricCriterion,
  score: CriterionScore
): boolean {
  if (!criterion.hardFail || score.status === "accepted_skip") return false;
  return score.status !== "pass";
}

function missingEvidenceFor(
  criterion: RubricCriterion,
  score: CriterionScore,
  evidenceById?: Map<string, EvaluationEvidence>
): string[] {
  if (!criterion.evidenceRequired?.length || score.status === "accepted_skip") {
    return [];
  }
  if (!score.evidenceIds || score.evidenceIds.length === 0) {
    return [`${criterion.id}: requires ${criterion.evidenceRequired.join(", ")}`];
  }
  if (!evidenceById) return [];
  const unknown = score.evidenceIds.filter((id) => !evidenceById.has(id));
  const missing = unknown.map((id) => `${criterion.id}: unknown evidence ${id}`);
  const minTrust = minimumTrustForCriterion(criterion);
  if (!minTrust) return missing;
  const known = score.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter((item): item is EvaluationEvidence => Boolean(item));
  const hasTrustedEvidence = known.some((evidence) =>
    evidenceMeetsTrust(evidence, minTrust)
  );
  if (!hasTrustedEvidence) {
    missing.push(
      `${criterion.id}: evidence trust below ${minTrust}`
    );
  }
  return missing;
}

function dimensionScore(
  rubric: RubricSpec,
  dimensionId: string,
  criteriaById: Map<string, RubricCriterion>,
  scoresById: Map<string, CriterionScore>
): number {
  const criteria = rubric.criteria.filter(
    (criterion) => criterion.dimensionId === dimensionId
  );
  let positiveNumerator = 0;
  let positiveDenominator = 0;
  let pitfallPenalty = 0;

  for (const criterion of criteria) {
    const score = scoresById.get(criterion.id);
    if (!score) continue;
    const weight = criterionWeight(rubric, criterion);
    if (criterion.importance === "pitfall") {
      if (score.status === "accepted_skip" || score.status === "pass") continue;
      const penalty = score.status === "partial" ? 0.5 : 1;
      pitfallPenalty += penalty * weight;
      continue;
    }
    if (score.status === "accepted_skip") continue;
    positiveNumerator += score.score * weight;
    positiveDenominator += weight;
  }

  const knownCriteria = criteria.filter((criterion) =>
    criteriaById.has(criterion.id)
  );
  const hasOnlyPitfalls =
    knownCriteria.length > 0 &&
    knownCriteria.every((criterion) => criterion.importance === "pitfall");
  const positiveScore =
    positiveDenominator > 0 || hasOnlyPitfalls
      ? positiveDenominator > 0
        ? positiveNumerator / positiveDenominator
        : 1
      : 1;
  return roundScore(positiveScore - pitfallPenalty);
}

/**
 * Some profiles (e.g. external desktop actions) must not be accepted on a
 * single passing round. They set `exitPolicy.requireConsecutivePasses = N`,
 * meaning the current round plus the previous N-1 rounds must all have passed.
 * Returns true when the consecutive-pass requirement is satisfied (or absent).
 */
function meetsConsecutivePasses(
  input: EvaluateRubricInput,
  currentRoundPasses: boolean
): boolean {
  const required = input.rubric.exitPolicy.requireConsecutivePasses;
  if (!required || required <= 1) return true;
  if (!currentRoundPasses) return false;
  const history = input.previousEvaluations ?? [];
  // The current round counts as one pass; we need (required - 1) prior passes.
  const priorNeeded = required - 1;
  if (history.length < priorNeeded) return false;
  const recent = history.slice(-priorNeeded);
  return recent.every((evaluation) => evaluation.status === "passed");
}

function lowDeltaRecommendation(
  input: EvaluateRubricInput,
  scores: CriterionScore[],
  criteriaById: Map<string, RubricCriterion>,
  hardFails: string[],
  missingEvidence: string[],
  minScoreFailures: string[],
  currentScore: number
): boolean {
  const minDelta = input.rubric.exitPolicy.minDelta;
  if (!minDelta || (input.previousEvaluations?.length ?? 0) < 2) return false;
  if (hardFails.length > 0 || missingEvidence.length > 0 || minScoreFailures.length > 0) {
    return false;
  }
  const problematic = scores.filter((score) => {
    const criterion = criteriaById.get(score.criterionId);
    return criterion && isCriterionProblem(criterion, score);
  });
  const onlyOptionalProblems = problematic.every((score) => {
    const criterion = criteriaById.get(score.criterionId);
    return criterion?.importance === "optional";
  });
  if (!onlyOptionalProblems) return false;
  const recent = input.previousEvaluations!.slice(-2).map((item) => item.totalScore);
  const deltaOne = Math.abs(recent[1] - recent[0]);
  const deltaTwo = Math.abs(currentScore - recent[1]);
  return deltaOne < minDelta && deltaTwo < minDelta;
}

function decideRecommendation(input: {
  evaluationInput: EvaluateRubricInput;
  passed: boolean;
  totalScore: number;
  hardFails: string[];
  essentialFailures: string[];
  missingEvidence: string[];
  minScoreFailures: string[];
  lowDelta: boolean;
}): EvaluationRecommendation {
  const { evaluationInput } = input;
  if (evaluationInput.needsUserInput) return "ask_user";
  if (
    (evaluationInput.repeatedBlockerCount ?? 0) >=
    evaluationInput.rubric.exitPolicy.blockedRepeatLimit
  ) {
    return "blocked";
  }
  if (input.passed) return "pass";
  if (input.lowDelta) return "stop_low_delta";
  if (
    typeof evaluationInput.iteration === "number" &&
    evaluationInput.iteration >= evaluationInput.rubric.exitPolicy.maxIterations
  ) {
    return "blocked";
  }
  return "iterate";
}

function statusForRecommendation(
  recommendation: EvaluationRecommendation,
  hardFails: string[],
  essentialFailures: string[],
  missingEvidence: string[],
  minScoreFailures: string[],
  passed: boolean
): RubricEvaluationStatus {
  if (recommendation === "blocked" || recommendation === "ask_user") return "blocked";
  if (passed) return "passed";
  if (
    hardFails.length > 0 ||
    essentialFailures.length > 0 ||
    missingEvidence.length > 0 ||
    minScoreFailures.length > 0
  ) {
    return "failed";
  }
  return "warning";
}

function recommendNextAction(input: {
  recommendation: EvaluationRecommendation;
  hardFails: string[];
  missingEvidence: string[];
  minScoreFailures: string[];
  failedCriteria: string[];
  triggeredPitfalls: string[];
}): string {
  if (input.recommendation === "pass") {
    return "Accepted. Preserve the evidence and hand off the result.";
  }
  if (input.recommendation === "ask_user") {
    return "Ask the user for the missing decision, permission, account, or environment confirmation.";
  }
  if (input.recommendation === "blocked") {
    return "Stop retrying this loop and surface the blocker with the exact unblock action.";
  }
  if (input.recommendation === "stop_low_delta") {
    return "Stop iterating: recent improvement is below the configured delta and only low-value work remains.";
  }
  if (input.hardFails.length > 0) {
    return `Fix hard-fail criteria first: ${input.hardFails.slice(0, 3).join(", ")}.`;
  }
  if (input.missingEvidence.length > 0) {
    return "Collect and attach the missing evidence before marking this complete.";
  }
  if (input.triggeredPitfalls.length > 0) {
    return `Remove triggered pitfalls: ${input.triggeredPitfalls.slice(0, 3).join(", ")}.`;
  }
  if (input.minScoreFailures.length > 0) {
    return `Improve low-scoring dimensions: ${input.minScoreFailures.slice(0, 3).join(", ")}.`;
  }
  if (input.failedCriteria.length > 0) {
    return `Address failed criteria: ${input.failedCriteria.slice(0, 3).join(", ")}.`;
  }
  return "Iterate on the remaining rubric gaps and evaluate again.";
}

export function evaluateRubric(input: EvaluateRubricInput): RubricEvaluation {
  const rubric = input.rubric;
  const createdAt = input.createdAt ?? Date.now();
  const criteriaById = new Map(rubric.criteria.map((criterion) => [criterion.id, criterion]));
  const evidenceById = input.evidence
    ? new Map(input.evidence.map((item) => [item.id, item]))
    : undefined;
  const criteria = normalizeCriterionScores(rubric, input.criteria);
  const scoresById = new Map(criteria.map((score) => [score.criterionId, score]));

  const dimensionScores: RubricDimensionScore[] = rubric.dimensions.map((dimension) => ({
    dimensionId: dimension.id,
    score: dimensionScore(rubric, dimension.id, criteriaById, scoresById),
    weight: dimension.weight,
    minScore: dimension.minScore,
  }));

  const dimensionWeightTotal = dimensionScores.reduce(
    (sum, dimension) => sum + dimension.weight,
    0
  );
  const rawTotal =
    dimensionWeightTotal > 0
      ? dimensionScores.reduce(
          (sum, dimension) => sum + dimension.score * dimension.weight,
          0
        ) / dimensionWeightTotal
      : 0;

  const hardFails = criteria
    .filter((score) => {
      const criterion = criteriaById.get(score.criterionId);
      return criterion ? triggersHardFail(criterion, score) : false;
    })
    .map((score) => score.criterionId);
  const failedCriteria = criteria
    .filter((score) => {
      const criterion = criteriaById.get(score.criterionId);
      return criterion ? isCriterionProblem(criterion, score) : false;
    })
    .map((score) => score.criterionId);
  const triggeredPitfalls = criteria
    .filter((score) => {
      const criterion = criteriaById.get(score.criterionId);
      return (
        criterion?.importance === "pitfall" &&
        score.status !== "pass" &&
        score.status !== "accepted_skip"
      );
    })
    .map((score) => score.criterionId);
  const essentialFailures = criteria
    .filter((score) => {
      const criterion = criteriaById.get(score.criterionId);
      return (
        criterion?.importance === "essential" &&
        score.status !== "pass" &&
        score.status !== "accepted_skip"
      );
    })
    .map((score) => score.criterionId);
  const missingEvidence = criteria
    .flatMap((score) => {
      const criterion = criteriaById.get(score.criterionId);
      return criterion ? missingEvidenceFor(criterion, score, evidenceById) : [];
    })
    .filter(Boolean);
  const minScoreFailures = dimensionScores
    .filter(
      (dimension) =>
        typeof dimension.minScore === "number" && dimension.score < dimension.minScore
    )
    .map((dimension) => dimension.dimensionId);

  const scoreCap = rubric.exitPolicy.scoreCapWithoutEvidence;
  // A reported total must not look "almost done" when a hard gate failed.
  // Cap the score whenever required evidence is missing OR a hard-fail /
  // essential criterion did not pass — otherwise the UI can show a high score
  // next to a failed status, which misleads both humans and the agent.
  const requiresScoreCap =
    missingEvidence.length > 0 ||
    hardFails.length > 0 ||
    essentialFailures.length > 0;
  const totalScore =
    requiresScoreCap && typeof scoreCap === "number"
      ? Math.min(rawTotal, scoreCap)
      : rawTotal;
  const roundedTotal = roundScore(totalScore);
  const roundContentPasses =
    rubric.criteria.length > 0 &&
    hardFails.length === 0 &&
    essentialFailures.length === 0 &&
    missingEvidence.length === 0 &&
    minScoreFailures.length === 0 &&
    roundedTotal >= rubric.targetScore;
  // Profiles can require N consecutive passing rounds before final acceptance
  // (high-risk actions), preventing acceptance on a single lucky round.
  const passed = roundContentPasses && meetsConsecutivePasses(input, roundContentPasses);
  const lowDelta = lowDeltaRecommendation(
    input,
    criteria,
    criteriaById,
    hardFails,
    missingEvidence,
    minScoreFailures,
    roundedTotal
  );
  const recommendation = decideRecommendation({
    evaluationInput: input,
    passed,
    totalScore: roundedTotal,
    hardFails,
    essentialFailures,
    missingEvidence,
    minScoreFailures,
    lowDelta,
  });
  const status = statusForRecommendation(
    recommendation,
    hardFails,
    essentialFailures,
    missingEvidence,
    minScoreFailures,
    passed
  );
  const nextAction = recommendNextAction({
    recommendation,
    hardFails,
    missingEvidence,
    minScoreFailures,
    failedCriteria,
    triggeredPitfalls,
  });

  return {
    id: input.evaluationId ?? `eval-${createdAt}`,
    rubricId: rubric.id,
    evaluatorVersion: input.evaluatorVersion ?? RUBRIC_EVALUATOR_VERSION,
    subject: input.subject ?? {},
    status,
    totalScore: roundedTotal,
    targetScore: rubric.targetScore,
    dimensionScores,
    criteria,
    hardFails,
    failedCriteria,
    triggeredPitfalls,
    missingEvidence,
    minScoreFailures,
    recommendation,
    nextAction,
    evidence: input.evidence,
    weightSnapshot: {
      profileId: rubric.profileId,
      targetScore: rubric.targetScore,
      dimensions: rubric.dimensions,
      importanceWeights: rubric.importanceWeights ?? DEFAULT_IMPORTANCE_WEIGHTS,
      exitPolicy: rubric.exitPolicy,
    },
    createdAt,
  };
}

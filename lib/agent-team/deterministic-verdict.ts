import path from "node:path";
import {
  extractSimpleFileExistenceTarget,
  safeProjectRelativePath,
} from "./route-helpers";
import type { AgentTeamRun } from "./types";

export interface DeterministicVerdictCorrection {
  run: AgentTeamRun;
  corrected: boolean;
  target?: string;
  exists?: boolean;
  targets?: string[];
  reason?: string;
}

function mentionsTarget(value: string | undefined, target: string): boolean {
  return Boolean(value && value.includes(target));
}

function taskCompletionSource(
  status: string,
  current: "manual" | "teammate_result" | "lead_override" | undefined
): "manual" | "teammate_result" | "lead_override" | undefined {
  return status === "completed" ? current ?? "teammate_result" : current ?? "lead_override";
}

export function correctSimpleFileExistenceVerdict(
  run: AgentTeamRun,
  input: {
    cwd: string;
    existsSync?: (absolutePath: string) => boolean;
    now?: number;
  }
): DeterministicVerdictCorrection {
  if (run.status !== "completed") return { run, corrected: false };
  const target = safeProjectRelativePath(
    extractSimpleFileExistenceTarget(run.objective) ?? ""
  );
  if (!target) return { run, corrected: false };

  const absolute = path.resolve(input.cwd, target);
  const cwdRoot = path.resolve(input.cwd);
  if (absolute !== cwdRoot && !absolute.startsWith(`${cwdRoot}${path.sep}`)) {
    return { run, corrected: false };
  }

  const exists = (input.existsSync ?? (() => false))(absolute);
  const now = input.now ?? Date.now();
  const findingId = `${run.id}:deterministic-file-existence:finding`;
  const decisionId = `${run.id}:deterministic-file-existence:decision`;
  const evidenceRefs = [`file:${target}`];
  const claim = exists
    ? `存在 — 已确认 \`${target}\` 在当前项目中。`
    : `不存在 — 当前项目里没有找到 \`${target}\`。`;
  const title = "文件存在性确认";

  const relatedTask =
    run.board.tasks.find((task) => mentionsTarget(task.title, target)) ??
    run.board.tasks.find((task) => mentionsTarget(task.description, target)) ??
    run.board.tasks.find((task) => task.required) ??
    run.board.tasks[0];

  const filteredFindings = run.board.findings.filter(
    (finding) =>
      finding.id !== findingId &&
      !mentionsTarget(finding.claim, target) &&
      !finding.evidenceRefs.some((ref) => mentionsTarget(ref, target))
  );
  const filteredDecisions = run.board.decisions.filter(
    (decision) =>
      decision.id !== decisionId &&
      !mentionsTarget(decision.rationale, target) &&
      !(decision.evidenceRefs ?? []).some((ref) => mentionsTarget(ref, target))
  );

  const nextRun: AgentTeamRun = {
    ...run,
    status: "completed",
    leadState: "finalized",
    updatedAt: now,
    endedAt: run.endedAt ?? now,
    members: run.members.map((member) =>
      member.status === "working" || member.currentTaskId
        ? {
            ...member,
            status: "done",
            currentTaskId: undefined,
            latestOutput: "最终结论已生成。",
            lastActiveAt: now,
          }
        : member
    ),
    blockReasons: [],
    board: {
      ...run.board,
      tasks: run.board.tasks.map((task) => ({
        ...task,
        status: "completed",
        completedAt: task.completedAt ?? now,
        ownerAgentId: undefined,
        claimedAt: undefined,
        blocker: undefined,
        lastError: undefined,
        completionSource: taskCompletionSource(task.status, task.completionSource),
      })),
      fileLocks: run.board.fileLocks.map((lock) =>
        lock.status === "active"
          ? { ...lock, status: "released", releasedAt: now }
          : lock
      ),
      qualityGates: run.board.qualityGates.map((gate) =>
        gate.status === "failed" && gate.severity === "blocking"
          ? {
              ...gate,
              status: "passed",
              message: "已由本地确定性检查生成最终结论。",
              checkedAt: now,
            }
          : gate
      ),
      findings: [
        ...filteredFindings,
        {
          id: findingId,
          taskId: relatedTask?.id,
          authorAgentId: run.leadAgentId,
          claim,
          evidenceRefs,
          confidence: "high",
          status: "accepted",
          challengeIds: [],
          acceptedByAgentId: run.leadAgentId,
          acceptedAt: now,
        },
      ],
      decisions: [
        ...filteredDecisions,
        {
          id: decisionId,
          title,
          rationale: claim,
          acceptedFindingIds: [findingId],
          rejectedFindingIds: [],
          evidenceRefs,
          sourceResultIds: [],
          confidence: "high",
          status: "accepted",
          madeByAgentId: run.leadAgentId,
          createdAt: now,
        },
      ],
      events: [
        ...run.board.events,
        {
          id: `${run.id}:event:deterministic-file-existence:${now}`,
          type: "decision_recorded",
          at: now,
          actorAgentId: run.leadAgentId,
          taskId: relatedTask?.id,
          findingId,
          message: exists
            ? `已用本地文件检查确认 ${target} 存在。`
            : `已用本地文件检查确认 ${target} 不存在。`,
          data: {
            target,
            exists,
            source: "deterministic_file_existence_guard",
          },
        },
      ],
    },
  };

  return { run: nextRun, corrected: true, target, exists };
}

const REVIEW_FILE_PATTERN =
  /(?:file:)?([A-Za-z0-9_./@-]+\.(?:json|tsx?|jsx?|mjs|cjs|md|css|scss|html|py|go|rs|java|kt|swift))/gi;

function distinct(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const clean = value.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function objectiveMentionedFiles(objective: string): string[] {
  return distinct(
    Array.from(objective.matchAll(REVIEW_FILE_PATTERN))
      .map((match) => safeProjectRelativePath(match[1] ?? ""))
      .filter((value): value is string => Boolean(value))
  ).slice(0, 6);
}

function isReviewLikeObjective(objective: string): boolean {
  return /检查|审查|审计|复核|验收|确认|判断|修复|完整|能力|链路|问题|原因|review|audit|verify|validate|check/i.test(
    objective
  );
}

function hasRecoverableEmptyTeamResult(run: AgentTeamRun): boolean {
  const joined = [
    run.error,
    ...(run.blockReasons ?? []).map((reason) => `${reason.code} ${reason.message}`),
    ...run.board.results.flatMap((result) => [
      result.status,
      result.summary,
      ...result.parseWarnings,
    ]),
    ...run.board.findings.map((finding) => finding.claim),
    ...run.board.tasks.flatMap((task) => [
      task.blocker,
      task.lastError,
      task.completionSource,
    ]),
  ]
    .filter(Boolean)
    .join("\n");
  return /provider_stream_error|stream ended|finish_reason|供应商|断流|empty|no teammate output|没有拿到可采纳|成员结果为空|lead_override/i.test(
    joined
  );
}

interface ObjectiveSignal {
  label: string;
  patterns: RegExp[];
}

function objectiveSignals(objective: string): ObjectiveSignal[] {
  const signals: ObjectiveSignal[] = [];
  const text = objective.toLowerCase();
  const add = (label: string, patterns: RegExp[]) => {
    if (!signals.some((signal) => signal.label === label)) {
      signals.push({ label, patterns });
    }
  };
  if (/result\s*adapter|adapter|自然语言|成员结果|finding|发现/.test(text)) {
    add("成员结果整理", [
      /normalizeAgentTeamResult/,
      /adaptNaturalLanguageResult/,
      /adaptedFromNaturalLanguage/,
      /source:\s*["']adapter["']/,
      /missing_evidence/,
      /findings/,
    ]);
  }
  if (/provider|stream|finish_reason|供应商|断流|模型连接/.test(text)) {
    add("模型断流处理", [
      /provider_stream_error/,
      /classifyAgentTeamProviderFailure/,
      /isRecoverableAgentTeamProviderFailure/,
      /stream ended without finish_reason/i,
      /finish_reason/,
    ]);
  }
  if (/通过|不通过|最终|结论|answer|summary|final/.test(text)) {
    add("最终回答生成", [
      /getAgentTeamFinalSummary/,
      /chooseVerificationVerdict/,
      /chooseAuditVerdict/,
      /wantsPassFailVerdict/,
      /agentTeamFinalAnswerPromptGuidelines/,
    ]);
  }
  if (/完成|收束|lead|override|门禁|quality|任务/.test(text)) {
    add("完成态与风险收束", [
      /completionSource/,
      /lead_override/,
      /synthesizeStoredAgentTeamFromAvailableWork/,
      /qualityGates/,
      /finalized/,
    ]);
  }
  if (signals.length === 0) {
    add("目标文件可读取", [/export\s+|function\s+|const\s+|class\s+|interface\s+/]);
  }
  return signals.slice(0, 5);
}

function lineForPattern(content: string, pattern: RegExp): number | null {
  const match = content.match(pattern);
  if (!match?.[0]) return null;
  const index = match.index ?? content.indexOf(match[0]);
  if (index < 0) return null;
  return content.slice(0, index).split(/\r?\n/).length;
}

function isIssueReviewObjective(objective: string): boolean {
  return /问题|风险|体验|合理|不合理|异常|缺失|冲突|bug|issue|risk|ux/i.test(
    objective
  );
}

function objectiveReviewClaim(input: {
  objective: string;
  files: string[];
  existingFiles: string[];
  matchedLabels: string[];
  missingLabels: string[];
}): string {
  if (input.existingFiles.length === 0) {
    return `无法完成本地复核：用户点名的文件没有在当前项目中找到（${input.files.join("，")}）。`;
  }
  if (input.matchedLabels.length === 0) {
    return `无法确认通过：已读取 ${input.existingFiles.join("，")}，但没有找到与本次问题直接对应的实现线索。`;
  }
  const matched = input.matchedLabels.join("、");
  const missing = input.missingLabels.length > 0
    ? `；仍缺少 ${input.missingLabels.join("、")} 的直接证据`
    : "";
  if (isIssueReviewObjective(input.objective)) {
    return `无法完整判断：成员执行中断后，只能确认 ${input.existingFiles.join("，")} 中存在 ${matched} 的相关实现线索${missing}。这还不足以证明已经完成体验审查，建议继续跑完整回归或人工复核。`;
  }
  return `部分通过：已在 ${input.existingFiles.join("，")} 找到 ${matched} 的相关实现线索${missing}。这是本地只读兜底结论，仍建议跑完整回归验证。`;
}

export function correctNamedFileReviewVerdict(
  run: AgentTeamRun,
  input: {
    cwd: string;
    existsSync?: (absolutePath: string) => boolean;
    readFileSync?: (absolutePath: string, encoding: BufferEncoding) => string;
    now?: number;
  }
): DeterministicVerdictCorrection {
  if (run.status !== "completed" && run.status !== "running" && run.status !== "paused") {
    return { run, corrected: false };
  }
  if (extractSimpleFileExistenceTarget(run.objective)) {
    return { run, corrected: false };
  }
  const files = objectiveMentionedFiles(run.objective);
  if (files.length === 0 || !isReviewLikeObjective(run.objective)) {
    return { run, corrected: false };
  }
  if (!hasRecoverableEmptyTeamResult(run)) {
    return { run, corrected: false };
  }

  const cwdRoot = path.resolve(input.cwd);
  const existsSync = input.existsSync ?? (() => false);
  const readFileSync = input.readFileSync;
  const signals = objectiveSignals(run.objective);
  const evidenceRefs: string[] = [];
  const existingFiles: string[] = [];
  const matchedLabels = new Set<string>();

  for (const file of files) {
    const absolute = path.resolve(input.cwd, file);
    if (absolute !== cwdRoot && !absolute.startsWith(`${cwdRoot}${path.sep}`)) continue;
    if (!existsSync(absolute)) continue;
    existingFiles.push(file);
    let content = "";
    try {
      content = readFileSync ? readFileSync(absolute, "utf8") : "";
    } catch {
      content = "";
    }
    for (const signal of signals) {
      const line = signal.patterns
        .map((pattern) => lineForPattern(content, pattern))
        .find((value): value is number => typeof value === "number");
      if (line) {
        matchedLabels.add(signal.label);
        evidenceRefs.push(`file:${file}:${line}`);
      }
    }
    if (!content && evidenceRefs.length === 0) {
      evidenceRefs.push(`file:${file}`);
    }
  }

  const missingLabels = signals
    .map((signal) => signal.label)
    .filter((label) => !matchedLabels.has(label));
  const claim = objectiveReviewClaim({
    objective: run.objective,
    files,
    existingFiles,
    matchedLabels: Array.from(matchedLabels),
    missingLabels,
  });
  const now = input.now ?? Date.now();
  const findingId = `${run.id}:deterministic-named-file-review:finding`;
  const decisionId = `${run.id}:deterministic-named-file-review:decision`;
  const refs = distinct(evidenceRefs.length > 0 ? evidenceRefs : files.map((file) => `file:${file}`));
  const relatedTask =
    run.board.tasks.find((task) =>
      files.some((file) => mentionsTarget(task.title, file) || mentionsTarget(task.description, file))
    ) ??
    run.board.tasks.find((task) => task.required && task.completionSource === "lead_override") ??
    run.board.tasks.find((task) => task.required) ??
    run.board.tasks[0];

  const nextRun: AgentTeamRun = {
    ...run,
    status: "completed",
    leadState: "finalized",
    updatedAt: now,
    endedAt: run.endedAt ?? now,
    error: undefined,
    blockReasons: [],
    members: run.members.map((member) =>
      member.status === "working" || member.currentTaskId
        ? {
            ...member,
            status: "done",
            currentTaskId: undefined,
            latestOutput: "最终结论已生成。",
            lastActiveAt: now,
          }
        : member
    ),
    board: {
      ...run.board,
      tasks: run.board.tasks.map((task) => ({
        ...task,
        status: "completed",
        completedAt: task.completedAt ?? now,
        ownerAgentId: undefined,
        claimedAt: undefined,
        blocker: undefined,
        lastError: undefined,
        completionSource: taskCompletionSource(task.status, task.completionSource),
      })),
      fileLocks: run.board.fileLocks.map((lock) =>
        lock.status === "active"
          ? { ...lock, status: "released", releasedAt: now }
          : lock
      ),
      qualityGates: run.board.qualityGates.map((gate) =>
        gate.status === "failed" && gate.severity === "blocking"
          ? {
              ...gate,
              status: "passed",
              message: "已由本地只读复核生成带风险结论。",
              checkedAt: now,
            }
          : gate
      ),
      findings: [
        ...run.board.findings.filter(
          (finding) =>
            finding.id !== findingId &&
            !/没有拿到可采纳|无法形成可靠结论|现有信息不足|成员结果为空|供应商断流|No teammate output|provider stream/i.test(finding.claim)
        ),
        {
          id: findingId,
          taskId: relatedTask?.id,
          authorAgentId: run.leadAgentId,
          claim,
          evidenceRefs: refs,
          confidence: matchedLabels.size > 0 ? "medium" : "low",
          status: "accepted",
          challengeIds: [],
          acceptedByAgentId: run.leadAgentId,
          acceptedAt: now,
        },
      ],
      decisions: [
        ...run.board.decisions.filter(
          (decision) =>
            decision.id !== decisionId &&
            !/没有拿到可采纳|无法形成可靠结论|现有信息不足|成员结果为空|供应商断流|No teammate output|provider stream/i.test(decision.rationale)
        ),
        {
          id: decisionId,
          title: "本地只读复核",
          rationale: claim,
          acceptedFindingIds: [findingId],
          rejectedFindingIds: [],
          evidenceRefs: refs,
          sourceResultIds: [],
          confidence: matchedLabels.size > 0 ? "medium" : "low",
          status: "accepted",
          madeByAgentId: run.leadAgentId,
          createdAt: now,
        },
      ],
      events: [
        ...run.board.events,
        {
          id: `${run.id}:event:deterministic-named-file-review:${now}`,
          type: "decision_recorded",
          at: now,
          actorAgentId: run.leadAgentId,
          taskId: relatedTask?.id,
          findingId,
          message: "成员结果不可用时，已用本地只读文件复核生成带风险结论。",
          data: {
            files,
            matchedLabels: Array.from(matchedLabels),
            missingLabels,
            source: "deterministic_named_file_review_guard",
          },
        },
      ],
    },
  };

  return {
    run: nextRun,
    corrected: true,
    targets: files,
    reason: "deterministic_named_file_review_guard",
  };
}

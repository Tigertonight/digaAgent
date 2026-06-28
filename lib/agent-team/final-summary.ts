import type { AgentTeamRun } from "./types";

export type AgentTeamFinalAnswerIntent =
  | "verification"
  | "audit"
  | "summary"
  | "recommendation"
  | "implementation_review"
  | "open_ended";

export interface AgentTeamFinalSummary {
  title: string;
  verdict: string;
  rationale: string;
  bullets: string[];
  risk?: string;
  confidence?: "low" | "medium" | "high";
  intent?: AgentTeamFinalAnswerIntent;
  concise?: boolean;
}

interface AgentTeamFinalFindingDetail {
  claim: string;
  evidenceRefs: string[];
}

function cleanText(value: string | undefined): string {
  return (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^(?:结论|conclusion|reason)[:：]\s*/i, "")
    .trim();
}

function firstSentence(value: string): string {
  const text = cleanText(value);
  if (!text) return "";
  const cjk = text.match(/^(.+?[。！？])/);
  if (cjk?.[1]) return cleanText(cjk[1]);
  const ascii = text.match(/^(.+?[.!?])(?:\s|$)/);
  return cleanText(ascii?.[1] ?? text);
}

function splitSentences(value: string): string[] {
  const text = cleanText(value);
  const separator = /[。！？]/.test(text) ? /[。！？]\s*/ : /[.!?](?:\s+|$)/;
  return text
    .split(separator)
    .map(cleanText)
    .filter(Boolean);
}

function distinct(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(cleanText).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function classifyAgentTeamFinalAnswerIntent(
  query: string
): AgentTeamFinalAnswerIntent {
  const text = cleanText(query).toLowerCase();
  // 强 audit 信号优先：当用户明确要“审核/审计/审查报告”时，即使句中含
  // “是否/有没有”这类弱验证词（例如“看下是否有异常…出一个审核报告”），也按
  // 审核处理。否则会被误判为 verification，最终结论走“是否通过”的兜底分支，
  // 把子 agent 已上报的发现忽略掉，错误输出“暂无法确认”。
  if (/审核报告|审计报告|审查报告|审核|审计|代码审查|code\s*review|出.*(?:审核|审计|审查)?\s*报告/.test(text)) {
    return "audit";
  }
  if (/(?:检查|审查|review).*(?:代码|功能|链路|协同|问题|异常|完整|合理)|(?:代码|功能|链路|协同).*(?:检查|审查|review)/.test(text)) {
    return "audit";
  }
  if (/(?:并|同时|以及|且).{0,12}(?:判断|评估|检查|审计|复核|分析).{0,40}(?:adapter|能力|是否能|能否|区分|整体评估|主要问题|明显问题)/.test(text)) {
    return "audit";
  }
  if (/(?:整体|能力|功能|链路).*(?:完整|完整度|怎么样|如何|主要问题|明显问题|缺口|风险)|(?:主要问题|明显问题|缺口|风险).*(?:整体|能力|功能|链路)/.test(text)) {
    return "audit";
  }
  if (/是否|有没有|通过|不通过|完成|解决|修复|验证|验收|check if|whether|fixed|pass|passed|done|verify/.test(text)) {
    return "verification";
  }
  if (/审计|审查|review|风险|问题|漏洞|合理|异常|audit|risk|issue|bug/.test(text)) {
    return "audit";
  }
  if (/方案|怎么改|如何|怎么优化|优化|建议|路线|计划|取舍|recommend|proposal|plan|approach/.test(text)) {
    return "recommendation";
  }
  if (/实现|代码|改动|符合|复核|implementation|implemented/.test(text)) {
    return "implementation_review";
  }
  if (/总结|梳理|概括|现状|summary|summarize|status/.test(text)) {
    return "summary";
  }
  return "open_ended";
}

function userFacingText(value: string | undefined): string {
  if (!value) return "";
  return cleanText(value)
    .replace(/^审计结论(?:[（(][^）)]*[）)])?[:：]\s*/i, "")
    .replace(/^结论(?:\s*\d+)?[:：]\s*/i, "")
    .replace(/用户选择带风险生成最终综合。?/g, "")
    .replace(/用户选择使用当前已有结果收束，避免团队卡在失败成员或未完成整理任务上。?/g, "")
    .replace(/Finalize blocked by[^。.!?]*[。.!?]?/gi, "")
    .replace(/使用已有结果收束；该分歧作为最终结论的风险说明保留。?/g, "该不确定点已保留为风险。")
    .replace(/成员结果为空或供应商断流/g, "部分检查没有拿到可采纳结果")
    .replace(/供应商断流/g, "部分检查没有完整返回")
    .replace(/provider stream error/gi, "部分检查没有完整返回")
    .replace(/No teammate output was captured\.?/gi, "没有拿到可采纳的成员结论")
    .replace(/共享白板|主聊天|Team runtime|quality gates?|质量门禁|负责人强制收束|lead override/gi, "")
    .replace(/团队任务被强制收束/g, "本次检查提前收束")
    .replace(/团队任务被负责人强制收束/g, "本次检查提前收束")
    .replace(/无法形成真实可采纳发现/g, "没有形成足够可靠的依据")
    .replace(/本次只能带风险收束/g, "因此只能给出带风险的判断")
    .replace(/未完成关键任务已由负责人接管：/g, "还有未完整完成的检查项：")
    .replace(/没有开放分歧。?/g, "")
    .replace(/关键任务已完成。?/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[:：；;，,。\s]+/, "")
    .trim();
}

function isInternalProcessLine(value: string): boolean {
  return /共享白板|主聊天|Agent Team 模式|quality gates?|质量门禁|用户选择|供应商断流|provider stream|No teammate output|lead override|负责人强制收束|Team runtime|board|过程会进入|只保留摘要|决策入口|基于当前团队过程|阶段性综合|最终总结门禁|Finalize blocked|finalized after|teammate output/i.test(value);
}

function isRiskOnlyLine(value: string): boolean {
  return /^(?:风险|开放点|风险\/开放点|risks?\/open questions?)[:：]/i.test(cleanText(value));
}

/**
 * 是否是 synthesize 在“真无结论”时写入的兜底 claim（不是真实发现）。
 * 这类文案不应被当作可回显的成员结论。
 */
function isInconclusiveFallbackClaim(value: string): boolean {
  const text = cleanText(value);
  return /无法形成可靠结论|现有信息不足以支撑|信息不足以支撑(?:明确|最终)判断|没有形成足够可靠|没有拿到可采纳/.test(
    text
  );
}

function isInsufficientTeamResult(value: string): boolean {
  const text = userFacingText(value);
  return (
    isInconclusiveFallbackClaim(text) ||
    /部分检查没有拿到可采纳结果|部分检查没有完整返回|没有拿到可采纳|没有形成足够可靠|现有信息不足/.test(
      text
    )
  );
}

function isConciseFileExistenceAnswer(value: string): boolean {
  const text = cleanText(value);
  return /^(?:存在|不存在)\s*—\s*(?:已确认|当前项目里没有找到)\s*`?[^`。]+`?(?:在当前项目中)?。?$/.test(
    text
  );
}

function insufficientTeamResultVerdict(): string {
  return "这次没有拿到足够可靠的团队结论；建议重试自动处理，或切换到稳定模型后再跑一次。";
}

function insufficientTeamResultBullets(run: AgentTeamRun): string[] {
  const resultEvidence = run.board.results
    .filter((result) => result.status === "needs_review" || /provider|stream|output|empty/i.test(result.parseWarnings.join(" ")))
    .flatMap((result) => {
      const refs = displayEvidenceRefs(
        [
          result.sessionFile ? `session:${result.sessionFile}` : "",
          ...result.evidenceRefs,
        ].filter(Boolean)
      );
      const refText = refs.length > 0 ? `（证据：${refs.join("，")}）` : "";
      const reason = userFacingText(
        [
          result.summary,
          ...result.parseWarnings,
        ].join("。")
      );
      if (!reason || isInternalProcessLine(reason)) {
        return [`成员结果没有完整返回，无法作为可靠证据${refText}。`];
      }
      return [`成员结果没有完整返回：${reason}${refText}。`];
    });
  const unfinishedTasks = run.board.tasks
    .filter((task) => task.required && task.completionSource === "lead_override")
    .map((task) => `关键任务「${cleanText(task.title)}」是带风险收束，不代表真实完成。`);
  const decisionEvidence = run.board.decisions
    .flatMap((decision) => displayEvidenceRefs(decision.evidenceRefs ?? []))
    .filter((ref) => /^task:/.test(ref))
    .map((ref) => `最终判断依赖未完整完成的任务记录（证据：${ref}）。`);
  return distinctFinalBullets([
    ...resultEvidence,
    ...unfinishedTasks,
    ...decisionEvidence,
  ]).slice(0, 3);
}

function isLowValueSummaryLine(value: string): boolean {
  const text = cleanText(value).replace(/[。.!:：]$/, "");
  const bareText = text.replace(/^`|`$/g, "");
  if (/^(?:file:)?[A-Za-z0-9_./@-]+\.(?:json|tsx?|jsx?|mjs|cjs|md|css|scss|html|py|go|rs|java|kt|swift)(?::\d+(?:-\d+)?)?$/.test(bareText)) {
    return true;
  }
  if (/^(?:定位完成|已读取|已检查|证据|证据来源)(?:$|[：:（(，,。.\s])/.test(text)) {
    return true;
  }
  if (/^(?:风险\/建议|风险与建议|证据来源|已读文件|参考文件)(?:[（(][^）)]*[）)])?$/.test(text)) {
    return true;
  }
  return /^(?:当前是|这里是|本次为)?\s*(?:团队协作|Agent Team|Team)\s*(?:模式|流程|过程|运行|处理)/i.test(text);
}

function isUserAnswerCandidate(value: string): boolean {
  const text = userFacingText(value);
  return Boolean(
    text &&
      !isInternalProcessLine(text) &&
      !isRiskOnlyLine(text) &&
      !isLowValueSummaryLine(text) &&
      !isInconclusiveFallbackClaim(text)
  );
}

function extractFilePath(value: string): string {
  const matches = Array.from(
    value.matchAll(/(?:file:)?([A-Za-z0-9_./@-]+\.(?:json|tsx?|jsx?|mjs|cjs|md|css|scss|html|py|go|rs|java|kt|swift))/g)
  ).map((match) => {
    const path = match[1] ?? "";
    const projectRelative = path.match(/\/diga-agent\/(.+)$/)?.[1];
    return projectRelative ?? path;
  }).filter(Boolean);
  const relative = matches
    .filter((path) => !path.startsWith("/") && !path.includes("/.pi/") && !path.includes("/sessions/"))
    .sort((a, b) => Number(!a.includes("/")) - Number(!b.includes("/")) || a.length - b.length)[0];
  if (relative) return relative;
  const nested = matches
    .filter((path) => path.includes("/"))
    .sort((a, b) => a.length - b.length)[0];
  return nested ?? matches.sort((a, b) => a.length - b.length)[0] ?? "";
}

function displayEvidenceRef(ref: string): string {
  const text = cleanText(ref);
  if (!text) return "";
  const filePath = extractFilePath(text);
  if (filePath) {
    const lineSuffix = text.match(/:(\d+(?:-\d+)?)$/)?.[1];
    return lineSuffix && !filePath.endsWith(`:${lineSuffix}`)
      ? `${filePath}:${lineSuffix}`
      : filePath;
  }
  return text
    .replace(/^file:/, "")
    .replace(/^artifact:/, "artifact:")
    .replace(/^task:/, "task:");
}

function displayEvidenceRefs(refs: string[]): string[] {
  const displayRefs = distinct(refs.map(displayEvidenceRef).filter(Boolean));
  const fileRefs = displayRefs.filter((ref) => /[./][A-Za-z0-9_-]+\.(?:json|tsx?|jsx?|mjs|cjs|md|css|scss|html|py|go|rs|java|kt|swift)(?::\d+(?:-\d+)?)?$/.test(ref));
  const preferred = fileRefs.length > 0 ? fileRefs : displayRefs.filter((ref) => !/^session:|^workspace:|^task:/.test(ref));
  return (preferred.length > 0 ? preferred : displayRefs).slice(0, 2);
}

function extractMentionedFiles(value: string): string[] {
  return distinct(
    Array.from(
      cleanText(value).matchAll(
        /(?:file:)?([A-Za-z0-9_./@-]+\.(?:json|tsx?|jsx?|mjs|cjs|md|css|scss|html|py|go|rs|java|kt|swift))/gi
      )
    )
      .map((match) => match[1] ?? "")
      .filter(Boolean)
  );
}

function fileRefMatches(target: string, candidate: string): boolean {
  const targetPath = displayEvidenceRef(target).replace(/:\d+(?:-\d+)?$/, "");
  const candidatePath = displayEvidenceRef(candidate).replace(/:\d+(?:-\d+)?$/, "");
  return (
    Boolean(targetPath && candidatePath) &&
    (targetPath === candidatePath ||
      targetPath.endsWith(`/${candidatePath}`) ||
      candidatePath.endsWith(`/${targetPath}`))
  );
}

function findingDetailBullet(
  detail: AgentTeamFinalFindingDetail,
  opts: { includeEvidence: boolean; verdict?: string }
): string {
  const claim =
    summarizeFindingClaim(detail.claim, opts.verdict) ||
    (opts.includeEvidence ? userFacingText(detail.claim) : "");
  if (!claim) return "";
  if (!opts.includeEvidence) return claim;
  const refs = displayEvidenceRefs(detail.evidenceRefs);
  if (refs.length === 0) return claim;
  if (
    opts.verdict &&
    finalBulletKey(claim) === finalBulletKey(opts.verdict)
  ) {
    return `依据文件：${refs.join("，")}。`;
  }
  const alreadyMentioned = refs.some((ref) => claim.includes(ref));
  return alreadyMentioned ? claim : `${claim}（证据：${refs.join("，")}）`;
}

function isPositiveAssessmentLine(value: string): boolean {
  const text = userFacingText(value);
  return /已具备|已经具备|已跑通|跑通|可用|支持|完成|稳定|基础链路|基础能力|成熟/.test(text);
}

function isGapAssessmentLine(value: string): boolean {
  const text = userFacingText(value);
  return /问题|缺口|不足|不够|不稳定|卡住|失败|风险|仍需|还需要|需要继续|没有|无法|不能|待完善|待优化/.test(text);
}

function isRecommendationAssessmentLine(value: string): boolean {
  const text = userFacingText(value);
  return /建议|优先|下一步|应该|需要先|需要把|路线|方案|优化|修复|补齐|打磨/.test(text);
}

function prefixedAssessmentBullet(
  prefix: string,
  value: string,
  verdict?: string
): string {
  const text = summarizeFindingClaim(value, verdict) || userFacingText(value);
  if (!text) return "";
  return text.startsWith(prefix) ? truncateFinalBullet(text) : `${prefix}${truncateFinalBullet(text)}`;
}

function overallAssessmentBullets(
  details: AgentTeamFinalFindingDetail[],
  rationale: string,
  risks: string[],
  verdict: string
): string[] {
  const candidates = distinctFinalBullets([
    ...details
      .map((detail) => detail.claim)
      .filter((claim) => isUserAnswerCandidate(claim) && !isInsufficientTeamResult(claim)),
    ...splitSentences(rationale)
      .map(userFacingText)
      .filter((item) => isUserAnswerCandidate(item) && !isInsufficientTeamResult(item)),
  ]);
  const positive = candidates.find(
    (item) => isPositiveAssessmentLine(item) && finalBulletKey(item) !== finalBulletKey(verdict)
  );
  const usedKeys = new Set(
    [finalBulletKey(verdict), positive ? finalBulletKey(positive) : ""].filter(Boolean)
  );
  const gap = candidates.find(
    (item) => isGapAssessmentLine(item) && !usedKeys.has(finalBulletKey(item))
  );
  if (gap) usedKeys.add(finalBulletKey(gap));
  const recommendation =
    candidates.find(
      (item) => isRecommendationAssessmentLine(item) && !usedKeys.has(finalBulletKey(item))
    ) ||
    risks.find((item) => isRecommendationAssessmentLine(item));
  return distinctFinalBullets([
    positive ? prefixedAssessmentBullet("已具备：", positive, verdict) : "",
    gap ? prefixedAssessmentBullet("主要缺口：", gap, verdict) : "",
    recommendation ? prefixedAssessmentBullet("下一步：", recommendation, verdict) : "",
  ]).slice(0, 3);
}

function truncateFinalBullet(value: string, maxLength = 180): string {
  const text = cleanText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function trimVerboseExplanation(value: string): string {
  const text = cleanText(value);
  const prefix = text.match(/^(.{10,90}?)[：:]/)?.[1];
  return prefix ? cleanText(prefix) : text;
}

function finalBulletKey(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/^(?:已具备|主要缺口|下一步|建议)[:：]\s*/, "")
    .replace(/[`"'“”‘’]/g, "")
    .replace(/[（(][^）)]*(?:证据|file:|line|:\d+)[^）)]*[）)]/gi, "")
    .replace(/file:[a-z0-9_./@-]+/gi, "")
    .replace(/已经|已|了|的/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]/g, "")
    .slice(0, 42);
}

function distinctFinalBullets(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = cleanText(value);
    const key = finalBulletKey(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function withoutTerminalPunctuation(value: string): string {
  return cleanText(value).replace(/[。！？.!?]+$/g, "");
}

function summarizeFindingClaim(value: string, verdict?: string): string {
  const text = userFacingText(value);
  if (!text) return "";
  const verdictText = withoutTerminalPunctuation(verdict ?? "");
  const sentences = splitSentences(text);
  const firstUseful =
    sentences.find((sentence) => {
      const normalized = withoutTerminalPunctuation(sentence);
      if (!normalized) return false;
      if (verdictText && normalized === verdictText) return false;
      if (verdictText && withoutTerminalPunctuation(text).startsWith(verdictText) && normalized.startsWith(verdictText)) {
        return false;
      }
      if (/^(?:定位完成|已读取|已检查|证据|风险\/开放点)(?:$|[:：。\s])/.test(normalized)) return false;
      return true;
    }) ||
    (verdictText && withoutTerminalPunctuation(text).startsWith(verdictText) ? "" : firstSentence(text));
  return truncateFinalBullet(trimVerboseExplanation(firstUseful));
}

function shouldIncludeEvidenceInBullets(
  intent: AgentTeamFinalAnswerIntent,
  query: string
): boolean {
  const text = cleanText(query).toLowerCase();
  return (
    intent === "audit" ||
    intent === "implementation_review" ||
    (extractMentionedFiles(query).length > 0 &&
      /检查|审查|审计|复核|验收|确认|修复|review|audit|verify|validate/.test(text)) ||
    /原因|理由|具体|引用|位置|证据|代码位置|line|evidence|why|because|reason/.test(text)
  );
}

function conciseExistenceVerdict(value: string): string {
  const text = userFacingText(value);
  const negativePattern = /(?:^|[\s。！？；;,，])不存在(?:[。！？.!?\s—\-（(]|$)|未找到|没有找到|not found|does\s+not\s+exist|no\s+such\s+file/i;
  const positivePattern = /(?:^|[\s。！？；;,，])存在(?:[。！？.!?\s—\-（(]|$)|存在于|文件存在|找到|\bexists?\b/i;
  const fileNear = (index: number): string => {
    const before = text.slice(0, Math.max(0, index));
    const after = text.slice(Math.max(0, index));
    const beforeFiles = Array.from(
      before.matchAll(/(?:file:)?([A-Za-z0-9_./@-]+\.(?:json|tsx?|jsx?|mjs|cjs|md|css|scss|html|py|go|rs|java|kt|swift))/gi)
    ).map((match) => match[1] ?? "").filter(Boolean);
    return beforeFiles.at(-1) || extractFilePath(after) || extractFilePath(text);
  };
  const negative = text.match(negativePattern);
  const positive = text.match(positivePattern);
  const negativeIndex = negative?.index ?? Number.POSITIVE_INFINITY;
  const positiveIndex = positive?.index ?? Number.POSITIVE_INFINITY;
  if (negativeIndex === Number.POSITIVE_INFINITY && positiveIndex === Number.POSITIVE_INFINITY) return "";
  if (negativeIndex < positiveIndex) {
    const filePath = fileNear(negativeIndex);
    if (!filePath) return "";
    return `不存在 — 当前项目里没有找到 \`${filePath}\`。`;
  }
  const filePath = fileNear(positiveIndex);
  return filePath ? `存在 — 已确认 \`${filePath}\` 在当前项目中。` : "";
}

function conciseExistenceVerdicts(values: string[]): string[] {
  const byFile = new Map<string, string>();
  const filePattern = /(?:file:)?([A-Za-z0-9_./@-]+\.(?:json|tsx?|jsx?|mjs|cjs|md|css|scss|html|py|go|rs|java|kt|swift))/gi;
  const negativePattern = /(?:^|[\s。！？；;,，])不存在(?:[。！？.!?\s—\-（(]|$)|未找到|没有找到|not found|does\s+not\s+exist|no\s+such\s+file/i;
  const positivePattern = /(?:^|[\s。！？；;,，])存在(?:[。！？.!?\s—\-（(]|$)|存在于|文件存在|找到|\bexists?\b/i;
  for (const value of values) {
    const text = userFacingText(value);
    const mentions = Array.from(text.matchAll(filePattern))
      .map((match) => ({
        file: match[1] ?? "",
        index: match.index ?? 0,
      }))
      .filter((match) => match.file);
    if (mentions.length > 1) {
      mentions.forEach((mention, index) => {
        const next = mentions[index + 1]?.index ?? text.length;
        const segment = text.slice(mention.index, next);
        const verdict = negativePattern.test(segment)
          ? `不存在 — 当前项目里没有找到 \`${mention.file}\`。`
          : positivePattern.test(segment)
            ? `存在 — 已确认 \`${mention.file}\` 在当前项目中。`
            : "";
        if (verdict && !byFile.has(mention.file)) byFile.set(mention.file, verdict);
      });
      continue;
    }
    const clauses = text
      .split(/[。；;\n]+/)
      .map(cleanText)
      .filter(Boolean);
    for (const clause of clauses.length > 1 ? clauses : [text]) {
      const verdict = conciseExistenceVerdict(clause);
      if (!verdict) continue;
      const file = verdict.match(/`([^`]+)`/)?.[1] ?? verdict;
      if (!byFile.has(file)) byFile.set(file, verdict);
    }
  }
  return Array.from(byFile.values());
}

function conciseExistenceVerdictsForQueryFiles(
  query: string,
  details: AgentTeamFinalFindingDetail[]
): string[] {
  const queryFiles = extractMentionedFiles(query);
  if (queryFiles.length === 0) return [];
  const negativePattern = /(?:^|[\s。！？；;,，])不存在(?:[。！？.!?\s—\-（(]|$)|(?:未找到|没有找到)(?:该|这个|目标)?(?:文件|路径)|not found|does\s+not\s+exist|no\s+such\s+file/i;
  const positivePattern = /(?:^|[\s。！？；;,，])存在(?:[。！？.!?\s—\-（(]|$)|存在于|文件存在|找到|\bexists?\b|已确认/i;
  const verdicts: string[] = [];
  for (const queryFile of queryFiles) {
    const matchingDetail = details.find((detail) => {
      const refs = displayEvidenceRefs(detail.evidenceRefs);
      return (
        detail.claim.includes(queryFile) ||
        refs.some((ref) => fileRefMatches(queryFile, ref))
      );
    });
    if (!matchingDetail) continue;
    const claim = userFacingText(matchingDetail.claim);
    const queryFileClause =
      claim
        .split(/[。；;\n]+/)
        .map(cleanText)
        .find((clause) => clause.includes(queryFile)) ?? claim;
    if (negativePattern.test(queryFileClause)) {
      verdicts.push(`不存在 — 当前项目里没有找到 \`${queryFile}\`。`);
      continue;
    }
    const fileMentions = extractMentionedFiles(claim);
    const matchedMentionIndex = fileMentions.findIndex((file) =>
      fileRefMatches(queryFile, file)
    );
    const polarityText =
      matchedMentionIndex >= 0
        ? (() => {
            const mention = fileMentions[matchedMentionIndex];
            const start = claim.indexOf(mention);
            const nextMention = fileMentions
              .slice(matchedMentionIndex + 1)
              .map((file) => claim.indexOf(file, start + mention.length))
              .find((index) => index >= 0);
            return claim.slice(start, nextMention ?? claim.length);
          })()
        : claim;
    if (negativePattern.test(polarityText)) {
      verdicts.push(`不存在 — 当前项目里没有找到 \`${queryFile}\`。`);
    } else if (positivePattern.test(polarityText)) {
      verdicts.push(`存在 — 已确认 \`${queryFile}\` 在当前项目中。`);
    } else if (
      matchingDetail.evidenceRefs.some((ref) => fileRefMatches(queryFile, ref))
    ) {
      verdicts.push(`存在 — 已确认 \`${queryFile}\` 在当前项目中。`);
    }
  }
  return distinct(verdicts);
}

function wantsPassFailVerdict(query: string): boolean {
  const text = cleanText(query).toLowerCase();
  return (
    /通过|不通过|验收|是否已经|是否已|pass|passed|done|fixed|resolved/.test(text) ||
    /是否.*(?:完成|解决|修复)|(?:完成|解决|修复).*(?:了吗|了么|好了|没有)/.test(text)
  );
}

function wantsOverallAssessment(query: string): boolean {
  const text = cleanText(query).toLowerCase();
  return (
    /整体|完整|完整度|能力|链路|协同|主要问题|明显问题|缺口|主要风险|怎么样|如何|成熟度|完成度/.test(text) &&
    !asksFileExistenceOnly(query)
  );
}

function isOverallAssessmentLine(value: string): boolean {
  const text = userFacingText(value);
  return Boolean(
    text &&
      /整体|总体|目前|当前|可用|完整|完整度|成熟|还没到|还不够|主要问题|核心问题|主要风险|缺口|需要继续/.test(text) &&
      !isInternalProcessLine(text) &&
      !isLowValueSummaryLine(text) &&
      !isInsufficientTeamResult(text)
  );
}

function asksFileExistenceOnly(query: string): boolean {
  const text = cleanText(query).toLowerCase();
  return /是否存在|存在\/不存在|存在吗|存不存在|有没有.*(?:文件|路径)|文件.*(?:是否|有没有).*存在|does .*exist|file .*exist/.test(text);
}

export function wantsConciseAgentTeamFinalAnswer(query: string): boolean {
  const text = cleanText(query).toLowerCase();
  return (
    /(?:最后|最终)?\s*只(?:回答|输出|给出)|只回答[:：]/.test(text) ||
    /(?:用|以)?\s*一句(?:中文|话)?\s*(?:回答|输出|给出|结论|说明|原因)/.test(text) ||
    /(?:回答|输出|给出|结论|说明|原因)\s*(?:用|以)?\s*一句(?:中文|话)?/.test(text) ||
    /(?:回答|输出|给出|结论|原因).*(?:一句话|一行|简短)/.test(text) ||
    /(?:一句话|一行).*(?:回答|输出|给出|结论|原因)/.test(text) ||
    /(?:一句|一条).*(?:证据|依据|理由)|(?:证据|依据|理由).*(?:一句|一条)/.test(text) ||
    /answer only|just answer|one sentence|single sentence|concise answer/.test(text)
  );
}

function chooseVerificationVerdict(
  acceptedFindings: string[],
  rationale: string,
  risks: string[],
  opts: {
    wantsPassFail: boolean;
    query?: string;
    findingDetails?: AgentTeamFinalFindingDetail[];
  }
): string {
  const combined = userFacingText([rationale, ...acceptedFindings].join(" "));
  const queryOrder = cleanText(opts.query);
  const allowExistenceVerdict = asksFileExistenceOnly(opts.query ?? "");
  const queryFileVerdicts = allowExistenceVerdict
    ? conciseExistenceVerdictsForQueryFiles(
        opts.query ?? "",
        opts.findingDetails ?? []
      )
    : [];
  if (queryFileVerdicts.length > 0) return queryFileVerdicts.join("\n");
  const existenceVerdicts = allowExistenceVerdict ? conciseExistenceVerdicts(acceptedFindings).sort((left, right) => {
    const leftFile = left.match(/`([^`]+)`/)?.[1] ?? "";
    const rightFile = right.match(/`([^`]+)`/)?.[1] ?? "";
    const leftIndex = leftFile ? queryOrder.indexOf(leftFile) : -1;
    const rightIndex = rightFile ? queryOrder.indexOf(rightFile) : -1;
    if (leftIndex >= 0 && rightIndex >= 0 && leftIndex !== rightIndex) return leftIndex - rightIndex;
    if (leftIndex >= 0) return -1;
    if (rightIndex >= 0) return 1;
    return 0;
  }) : [];
  if (existenceVerdicts.length > 0) return existenceVerdicts.join("\n");
  const conciseExistence = allowExistenceVerdict ? conciseExistenceVerdict(combined) : "";
  if (conciseExistence) return conciseExistence;
  if (/^(?:通过|部分通过)/.test(userFacingText(rationale))) {
    return firstSentence(userFacingText(rationale)) || "可以认为已经通过。";
  }
  // 加固：当不是明确的 pass/fail 提问，且确实拿到了可用的成员发现时，优先把
  // 第一条发现作为结论给出，而不是因为发现里含“风险/降级”等词就空洞地回
  // “暂无法确认”。此前的兜底会把已上报的真实结论一并忽略（issue 复现场景）。
  // 注意：排除 synthesize 在“真无结论”时写入的 fallback claim（“无法形成可靠
  // 结论 / 信息不足”），否则会把空洞兜底当成真实发现回显。
  const usableFinding = acceptedFindings
    .map(userFacingText)
    .find(isUserAnswerCandidate);
  if (!opts.wantsPassFail && usableFinding) {
    return firstSentence(usableFinding);
  }
  if (!opts.wantsPassFail && /不通过|不能确认|无法判断|证据不足|没有形成足够可靠|没有拿到可采纳|风险|未完成/.test(combined)) {
    return "暂无法确认：现有信息不足以支撑明确判断。";
  }
  if (/不通过|不能确认|无法判断|证据不足|没有形成足够可靠|没有拿到可采纳|风险/.test(combined)) {
    return "无法确认通过。";
  }
  if (/通过|已完成|已解决|已修复/.test(combined) && risks.length === 0) {
    return firstSentence(combined) || "可以认为已经通过。";
  }
  if (!opts.wantsPassFail) return "暂无法确认：现有信息不足以支撑明确判断。";
  return acceptedFindings.length > 0
    ? firstSentence(combined) || "已有结论可以参考，但仍需留意风险。"
    : "无法确认通过。";
}

function chooseAuditVerdict(
  query: string,
  acceptedFindings: string[],
  rationale: string,
  risks: string[]
): string {
  if (wantsOverallAssessment(query) && isOverallAssessmentLine(rationale)) {
    return firstSentence(rationale);
  }
  const usefulFindings = acceptedFindings
    .map(userFacingText)
    .filter((finding) => isUserAnswerCandidate(finding) && !isInsufficientTeamResult(finding));
  const overallFinding = wantsOverallAssessment(query)
    ? usefulFindings.find(isOverallAssessmentLine)
    : undefined;
  if (overallFinding) return firstSentence(overallFinding);
  const firstFinding =
    usefulFindings.find((finding) => !isConciseFileExistenceAnswer(finding)) ??
    usefulFindings[0];
  if (firstFinding) return firstSentence(firstFinding);
  if (isInsufficientTeamResult(rationale) || acceptedFindings.some(isInsufficientTeamResult)) {
    return insufficientTeamResultVerdict();
  }
  if (risks.length > 0) return "这次没有形成足够可靠的审计结论；风险已保留，建议补充验证后再判断。";
  const rationaleCandidate = userFacingText(rationale);
  return isUserAnswerCandidate(rationaleCandidate)
    ? firstSentence(rationaleCandidate)
    : "这次没有形成足够明确的审计发现。";
}

function chooseGenericVerdict(
  intent: AgentTeamFinalAnswerIntent,
  query: string,
  acceptedFindings: string[],
  rationale: string,
  risks: string[],
  findingDetails: AgentTeamFinalFindingDetail[]
): string {
  const directPassFailAllowed =
    intent !== "verification" || wantsPassFailVerdict(query);
  if (directPassFailAllowed && /^(通过|不通过|无法判断|无法确认)/.test(userFacingText(rationale))) {
    return firstSentence(userFacingText(rationale));
  }
  if (intent === "verification") {
    return chooseVerificationVerdict(acceptedFindings, rationale, risks, {
      wantsPassFail: wantsPassFailVerdict(query),
      query,
      findingDetails,
    });
  }
  if (intent === "audit" || intent === "implementation_review") {
    return chooseAuditVerdict(query, acceptedFindings, rationale, risks);
  }
  const candidate =
    acceptedFindings
      .map(userFacingText)
      .find((finding) => isUserAnswerCandidate(finding) && !isInsufficientTeamResult(finding)) ||
    splitSentences(userFacingText(rationale)).find(
      (sentence) => isUserAnswerCandidate(sentence) && !isInsufficientTeamResult(sentence)
    );
  if (candidate) return firstSentence(candidate);
  if (isInsufficientTeamResult(rationale) || acceptedFindings.some(isInsufficientTeamResult)) {
    return insufficientTeamResultVerdict();
  }
  if (risks.length > 0) return "目前只能给出带风险的阶段性判断。";
  return "团队已完成整理，但没有形成足够明确的结论。";
}

export function agentTeamFinalAnswerPromptGuidelines(): string {
  return [
    "Final answer adapter rules:",
    "First classify the user's original request as one of: verification, audit, summary, recommendation, implementation_review, open_ended.",
    "Answer the original user request directly; Team process is only evidence, not the subject.",
    "Choose the answer shape from the classified intent. Use pass/fail/unknown only for verification-style requests.",
    "For audit/review requests, lead with the most important finding or risk, then supporting reasons.",
    "For recommendation requests, lead with the recommended path and tradeoffs.",
    "Do not mention internal mechanics such as board, quality gate, lead override, provider stream, teammate output, workflow, or runtime unless the user asked about execution internals.",
    "If evidence is insufficient, say what cannot be concluded in user-facing language and suggest the next useful step.",
  ].join("\n");
}

export function getAgentTeamFinalSummary(run: AgentTeamRun): AgentTeamFinalSummary | null {
  const decisions = run.board.decisions.filter((decision) => (decision.status ?? "accepted") === "accepted");
  const decision = decisions.at(-1);
  const acceptedFindings = run.board.findings.filter((finding) => finding.status === "accepted");
  const answerFindings = run.board.findings.filter((finding) => finding.status !== "rejected");
  if (!decision && acceptedFindings.length === 0) return null;

  const intent = classifyAgentTeamFinalAnswerIntent(run.objective);
  const existenceOnlyQuery = asksFileExistenceOnly(run.objective);
  const rationale = userFacingText(decision?.rationale);
  const rawAcceptedFindingClaims = acceptedFindings.map((finding) =>
    userFacingText(finding.claim)
  );
  const queryFiles = existenceOnlyQuery ? extractMentionedFiles(run.objective) : [];
  const isExistenceEvidenceDetail = (detail: AgentTeamFinalFindingDetail) =>
    existenceOnlyQuery &&
    queryFiles.length > 0 &&
    detail.evidenceRefs.some((ref) =>
      queryFiles.some((queryFile) => fileRefMatches(queryFile, ref))
    );
  const findingDetails = acceptedFindings
    .map((finding) => ({
      claim: userFacingText(finding.claim),
      evidenceRefs: finding.evidenceRefs ?? [],
    }))
    .filter(
      (detail) => isUserAnswerCandidate(detail.claim) || isExistenceEvidenceDetail(detail)
    );
  const answerFindingDetails = [
    ...findingDetails,
    ...answerFindings
      .map((finding) => ({
        claim: userFacingText(finding.claim),
        evidenceRefs: finding.evidenceRefs ?? [],
      }))
      .filter(
        (detail) => isUserAnswerCandidate(detail.claim) || isExistenceEvidenceDetail(detail)
      ),
  ].reduce<AgentTeamFinalFindingDetail[]>((items, detail) => {
    const key = detail.claim.toLowerCase();
    const existing = items.find((item) => item.claim.toLowerCase() === key);
    if (existing) {
      existing.evidenceRefs = distinct([...existing.evidenceRefs, ...detail.evidenceRefs]);
    } else {
      items.push({ ...detail, evidenceRefs: distinct(detail.evidenceRefs) });
    }
    return items;
  }, []);
  const answerFindingClaims = answerFindingDetails.map((detail) => detail.claim);
  const risks = distinct(
    run.board.challenges
      .filter((challenge) => challenge.status === "open" || challenge.status === "needs_evidence" || challenge.status === "dismissed")
      .map((challenge) => userFacingText(challenge.resolution || challenge.reason))
      .filter((item) => item && !isInternalProcessLine(item) && !isLowValueSummaryLine(item))
  );
  const verdict = chooseGenericVerdict(
    intent,
    run.objective,
    answerFindingClaims,
    rationale,
    risks,
    answerFindingDetails
  );
  const concise = wantsConciseAgentTeamFinalAnswer(run.objective);
  const includeEvidence = shouldIncludeEvidenceInBullets(intent, run.objective);
  const findingBullets = answerFindingDetails
    .filter((detail) => {
      if (cleanText(detail.claim) !== verdict) return true;
      return includeEvidence && displayEvidenceRefs(detail.evidenceRefs).length > 0;
    })
    .map((detail) => findingDetailBullet(detail, { includeEvidence, verdict }))
    .filter(
      (item) =>
        item &&
        !isLowValueSummaryLine(item) &&
        (/证据[:：]/.test(item) || finalBulletKey(item) !== finalBulletKey(verdict))
    );
  const fallbackBullets =
    isInsufficientTeamResult(rationale) ||
    rawAcceptedFindingClaims.some(isInsufficientTeamResult)
      ? insufficientTeamResultBullets(run)
      : [];
  const shapedAssessmentBullets =
    !concise && wantsOverallAssessment(run.objective)
      ? overallAssessmentBullets(answerFindingDetails, rationale, risks, verdict)
      : [];
  const bullets = distinctFinalBullets(
    [
      ...shapedAssessmentBullets,
      ...findingBullets,
      ...(rationale
        ? splitSentences(rationale)
        : []
      )
        .map(userFacingText)
        .filter(
          (item) =>
            item &&
            item !== verdict &&
            finalBulletKey(item) !== finalBulletKey(verdict) &&
            isUserAnswerCandidate(item) &&
            !isInsufficientTeamResult(item)
        ),
      ...fallbackBullets,
    ]
  ).slice(0, 3);
  const risk =
    risks[0] ||
    (isInsufficientTeamResult(rationale) ||
    rawAcceptedFindingClaims.some(isInsufficientTeamResult)
      ? "部分检查没有拿到可采纳结果。"
      : undefined);
  const safeRationale =
    isUserAnswerCandidate(rationale) && !isInsufficientTeamResult(rationale)
      ? rationale
      : bullets[0] || verdict;

  return {
    title: "最终结论",
    verdict,
    rationale: safeRationale,
    bullets,
    risk,
    confidence: decision?.confidence,
    intent,
    concise,
  };
}

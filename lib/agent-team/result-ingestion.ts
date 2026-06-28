import type { AgentTeamChallenge, AgentTeamFinding } from "./types";
import type { AgentTeamBlockReasonCode } from "./types";

export type AgentTeamResultSource = "contract" | "adapter" | "model_normalizer";

export interface ParsedAgentTeamResult {
  summary: string;
  findings: Array<{
    claim: string;
    confidence?: AgentTeamFinding["confidence"];
    evidenceRefs?: string[];
  }>;
  challenges: Array<{
    targetFindingId?: string;
    reason: string;
    severity?: AgentTeamChallenge["severity"];
    requiredEvidenceRefs?: string[];
  }>;
  needsFollowUp: string[];
  warnings: string[];
  reasonCodes: AgentTeamBlockReasonCode[];
  source: AgentTeamResultSource;
  adaptedFromNaturalLanguage?: boolean;
}

interface RawResultShape {
  summary?: unknown;
  findings?: unknown;
  challenges?: unknown;
  needsFollowUp?: unknown;
}

export interface NormalizeAgentTeamResultInput {
  rawText: string;
  mode?: "collaboration" | "audit";
  taskTitle?: string;
  taskDescription?: string;
  sessionFile?: string;
}

function extractJsonBlock(text: string): string | null {
  const taggedFence = text.match(/```TEAM_RESULT_JSON\s*([\s\S]*?)```/i);
  if (taggedFence?.[1]) return taggedFence[1].trim();
  const tagged = text.match(/TEAM_RESULT_JSON:\s*```(?:json)?\s*([\s\S]*?)```/i);
  if (tagged?.[1]) return tagged[1].trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1] && fenced[1].includes("{")) return fenced[1].trim();
  const marker = text.match(/TEAM_RESULT_JSON:?\s*({[\s\S]*})/i);
  if (marker?.[1]) return marker[1].trim();
  const partialTagged = text.match(/TEAM_RESULT_JSON:?\s*```(?:json)?\s*([\s\S]*)/i);
  if (partialTagged?.[1]) return partialTagged[1].trim();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = text.slice(first, last + 1).trim();
    if (/"(?:summary|findings|challenges|needsFollowUp)"\s*:/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function stripInternalThoughtBlocks(rawText: string): string {
  return rawText
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "\n")
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "\n")
    .replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/gi, "\n")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "\n")
    .replace(/<thinking\b[^>]*>[\s\S]*$/gi, "\n")
    .replace(/<thought\b[^>]*>[\s\S]*$/gi, "\n")
    .replace(/<\/(?:think|thinking|thought)>/gi, "\n")
    .trim();
}

function cleanEvidenceRef(ref: string): string {
  return ref
    .trim()
    .replace(/^[`"'([{]+/, "")
    .replace(/[`"')\]}，。；;:、]+$/g, "")
    .trim();
}

function extractEvidenceRefs(text: string, sessionFile?: string): string[] {
  const refs = new Set<string>();
  const refPattern = /\b(?:file|session|artifact):[^\s),;\]}]+/gi;
  for (const match of text.matchAll(refPattern)) {
    const ref = cleanEvidenceRef(match[0]);
    if (ref) refs.add(ref);
  }
  const filePathPattern =
    /\b(?:app|lib|components|scripts|docs|tests|test|src)\/[A-Za-z0-9._/@+-]+(?:\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?/g;
  for (const match of text.matchAll(filePathPattern)) {
    const ref = cleanEvidenceRef(`file:${match[0]}`);
    if (ref) refs.add(ref);
  }
  const bareFilePattern =
    /\b[A-Za-z0-9._@+-]+(?:\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|yml|yaml|toml|lock|txt))(?:[:]\d+(?:-\d+)?)?\b/g;
  for (const match of text.matchAll(bareFilePattern)) {
    const value = match[0];
    if (/^(?:http|https|file|session|artifact):/i.test(value)) continue;
    const ref = cleanEvidenceRef(`file:${value}`);
    if (ref) refs.add(ref);
  }
  if (refs.size === 0 && sessionFile) refs.add(`session:${sessionFile}`);
  return Array.from(refs);
}

function stripMarkdownPrefix(line: string): string {
  return line
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*(?:F\d+|Finding\s*\d+)[.)：:]\s*/i, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .trim();
}

function looksLikeAcceptanceClaim(text: string): boolean {
  const normalized = text.trim();
  return (
    /(?:^|[：:→\-—])\s*(?:通过|不通过|未通过|部分通过|可接受|不可接受|已修复|未修复)(?:[。.!；;]|$)/.test(
      normalized
    ) ||
    /(?:是否|确认|验收|回归|完成|修复|正确|可用|有效|无误|失败|异常)/.test(normalized)
  );
}

function looksLikeProcessSelfTalk(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  return (
    /^risks?\s*\/\s*open questions?\s*:?\s*$/i.test(text.trim()) ||
    /^critic review\b/i.test(text.trim()) ||
    normalized.includes("my job is done") ||
    normalized.includes("i provided concrete") ||
    normalized.includes("the submission was successfully recorded") ||
    normalized.includes("submission has been accepted") ||
    normalized.includes("task marked as completed") ||
    normalized.includes("the board now shows") ||
    normalized.includes("lead will pick it up") ||
    normalized.includes("remaining gates are for the lead") ||
    normalized.includes("i should not mark the task complete") ||
    normalized.includes("do not mark the task complete yourself") ||
    normalized.includes("runtime's job") ||
    normalized.includes("dispatch failed:") ||
    normalized.includes("member model error:") ||
    normalized.includes("stream ended without finish_reason") ||
    normalized.includes("now i just need to") ||
    normalized.includes("let me give a concise") ||
    normalized.includes("teammate session 已创建") ||
    normalized.includes("成员记录已创建") ||
    normalized.includes("成员记录已准备好")
  );
}

function looksLikeNoActionableRisk(text: string): boolean {
  return /(?:risks?\s*\/\s*open questions?|风险|问题|疑问)\s*[：:]\s*(?:无|没有|none|no\b)/i.test(
    text.trim()
  );
}

function isUsefulNaturalLanguageClaim(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length < 12) return false;
  if (normalized.length > 700) return false;
  if (/^```/.test(normalized)) return false;
  if (/^(?:证据|evidence|说明|备注|note|notes?)\s*[：:]/i.test(normalized)) return false;
  if (/^(team_result_json|task|summary|findings|evidence|challenges|risks?\s*\/\s*open questions?|needsfollowup)\s*:?$/i.test(normalized)) return false;
  if (looksLikePlaceholder(normalized)) return false;
  if (looksLikeProcessSelfTalk(normalized)) return false;
  return /[\p{Script=Han}A-Za-z]/u.test(normalized);
}

function extractMarkdownSectionLines(lines: string[], headingPattern: RegExp): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const plain = line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\*\*/g, "").trim();
    if (headingPattern.test(plain)) {
      inside = true;
      continue;
    }
    if (inside && /^(?:task|summary|evidence|challenges?|risks?|open questions?|risks?\s*\/\s*open questions?|needsfollowup|证据|风险|疑问|待确认)\b/i.test(plain)) {
      break;
    }
    if (inside && line.trim()) out.push(line);
  }
  return out;
}

function extractNaturalLanguageFindings(text: string): string[] {
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines
    .map(stripMarkdownPrefix)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const findingSectionLines = extractMarkdownSectionLines(rawLines, /^(?:findings?|发现|结论)(?:\s*\([^)]*\)|\s*[:：].*)?\s*[:：]?$/i)
    .map(stripMarkdownPrefix)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(isUsefulNaturalLanguageClaim);
  if (findingSectionLines.length > 0) {
    const deduped: string[] = [];
    for (const candidate of findingSectionLines) {
      const normalized = candidate.toLowerCase();
      if (deduped.some((item) => item.toLowerCase() === normalized)) continue;
      deduped.push(candidate);
      if (deduped.length >= 5) break;
    }
    return deduped;
  }
  const explicit = lines.filter((line) =>
    isUsefulNaturalLanguageClaim(line) &&
    /(?:结论|发现|风险|问题|原因|建议|通过|不通过|未通过|验收|回归|修复|完成|evidence|finding|risk|issue|because|should|needs?|missing)/i.test(line)
  );
  const acceptance = lines.filter((line) => isUsefulNaturalLanguageClaim(line) && looksLikeAcceptanceClaim(line));
  const candidates =
    explicit.length > 0
      ? explicit
      : acceptance.length > 0
        ? acceptance
        : lines.filter(isUsefulNaturalLanguageClaim);
  const deduped: string[] = [];
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (deduped.some((item) => item.toLowerCase() === normalized)) continue;
    deduped.push(candidate);
    if (deduped.length >= 3) break;
  }
  if (deduped.length > 0) return deduped;
  const sentence = text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[。！？.!?])\s+/)
    .map((item) => item.trim())
    .find(isUsefulNaturalLanguageClaim);
  return sentence ? [sentence] : [];
}

function adaptNaturalLanguageResult(input: NormalizeAgentTeamResultInput): ParsedAgentTeamResult | null {
  const text = stripInternalThoughtBlocks(input.rawText).trim();
  if (!text) return null;
  const claims = extractNaturalLanguageFindings(text);
  if (claims.length === 0) return null;
  const evidenceRefs = extractEvidenceRefs(
    [text, input.taskDescription, input.taskTitle].filter(Boolean).join("\n"),
    input.sessionFile
  );
  const warnings = [
    "adapted from teammate natural language reply",
    ...(evidenceRefs.length === 0 ? ["finding has no evidence: adapted natural language result"] : []),
  ];
  const summary = claims[0] ?? input.taskTitle ?? "成员回复已整理。";
  const needsFollowUp = /(?:不确定|待确认|需要.*确认|follow.?up|todo|unknown|unclear)/i.test(text)
    ? ["成员回复中仍有待确认内容。"]
    : [];
  return {
    summary,
    findings: claims.map((claim) => ({
      claim,
      confidence: "medium",
      evidenceRefs,
    })),
    challenges: claims
      .filter((claim) =>
        /(?:风险|反例|矛盾|challenge|risk|contradiction)/i.test(claim) &&
        !looksLikeNoActionableRisk(claim)
      )
      .slice(0, 2)
      .map((claim) => ({
        reason: claim,
        severity: "medium" as const,
        requiredEvidenceRefs: evidenceRefs,
      })),
    needsFollowUp,
    warnings,
    reasonCodes: evidenceRefs.length === 0 ? ["missing_evidence"] : [],
    source: "adapter",
    adaptedFromNaturalLanguage: true,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function normalizeConfidence(value: unknown): AgentTeamFinding["confidence"] {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function normalizeSeverity(value: unknown): AgentTeamChallenge["severity"] {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

function looksLikePlaceholder(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "specific claim from your work." ||
    normalized === "specific claim from your work" ||
    normalized === "concise task outcome." ||
    normalized === "concise task outcome" ||
    normalized === "risk, contradiction, or missing evidence." ||
    normalized === "risk, contradiction, or missing evidence" ||
    normalized.includes("path-or-artifact") ||
    normalized.includes("actual/path") ||
    normalized.startsWith("<replace")
  );
}

function looksLikeCapturedEmptyOutput(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "no teammate output was captured." ||
    normalized === "no teammate output was captured" ||
    normalized === "no teammate result text was provided." ||
    normalized === "no teammate result text was provided" ||
    normalized === "stream ended without finish_reason" ||
    normalized.includes("stream ended without finish_reason") ||
    normalized.includes("provider stream ended without") ||
    normalized.includes("no api key") ||
    normalized.includes("oauth token") ||
    normalized.includes("unauthorized") ||
    normalized.includes("authentication") ||
    normalized.includes("team run is not running") ||
    normalized.includes("协调工具拒绝") ||
    normalized.includes("coordination tool rejected") ||
    normalized.includes("coordination tool refused")
  );
}

const CAPTURED_EMPTY_OUTPUT_SUMMARY = "没有拿到可采纳的成员结果。";

function looksLikeActionableOutcomeWithEvidence(text: string): boolean {
  return (
    /(?:^|\n)\s*(?:结论|发现|存在|不存在|通过|不通过|未通过|部分通过)[：:]/.test(text) &&
    extractEvidenceRefs(text).length > 0
  );
}

export function isUsableAgentTeamResultText(rawText: string): boolean {
  const text = stripInternalThoughtBlocks(rawText).trim();
  if (!text) return false;
  if (!looksLikeCapturedEmptyOutput(text)) return true;
  return looksLikeActionableOutcomeWithEvidence(text);
}

export function parseAgentTeamResultText(rawText: string): ParsedAgentTeamResult {
  return normalizeAgentTeamResult({ rawText, mode: "audit" });
}

export function normalizeAgentTeamResult(input: NormalizeAgentTeamResultInput): ParsedAgentTeamResult {
  const rawText = input.rawText.trim();
  const text = stripInternalThoughtBlocks(rawText).trim();
  const warnings: string[] = [];
  if (looksLikeCapturedEmptyOutput(text)) {
    if (looksLikeActionableOutcomeWithEvidence(text)) {
      const adapted = adaptNaturalLanguageResult(input);
      if (adapted?.findings.length) {
        return {
          ...adapted,
          warnings: [
            ...adapted.warnings,
            "provider stream error text was present, but a usable outcome with evidence was recovered",
          ],
        };
      }
    }
    return {
      summary: CAPTURED_EMPTY_OUTPUT_SUMMARY,
      findings: [],
      challenges: [],
      needsFollowUp: [],
      warnings: ["provider stream ended before usable teammate output was captured"],
      reasonCodes: ["provider_stream_error"],
      source: "contract",
    };
  }
  const jsonText = extractJsonBlock(rawText);
  if (!jsonText) {
    const adapted = adaptNaturalLanguageResult(input);
    if (adapted) return adapted;
    return {
      summary: text.slice(0, 600) || "No teammate result text was provided.",
      findings: [],
      challenges: [],
      needsFollowUp: [],
      warnings: ["missing TEAM_RESULT_JSON block"],
      reasonCodes: ["missing_structured_result"],
      source: "contract",
    };
  }

  let parsed: RawResultShape;
  try {
    parsed = JSON.parse(jsonText) as RawResultShape;
  } catch (err) {
    return {
      summary: text.slice(0, 600) || "Result JSON could not be parsed.",
      findings: [],
      challenges: [],
      needsFollowUp: [],
      warnings: [`invalid TEAM_RESULT_JSON: ${err instanceof Error ? err.message : String(err)}`],
      reasonCodes: ["invalid_result_json"],
      source: "contract",
    };
  }

  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const claim =
          typeof record.claim === "string" && record.claim.trim()
            ? stripInternalThoughtBlocks(record.claim).trim()
            : typeof record.title === "string"
              ? stripInternalThoughtBlocks(record.title).trim()
              : "";
        const explicitEvidenceRefs = [
          ...asStringArray(record.evidenceRefs),
          ...asStringArray(record.evidence),
        ].map(cleanEvidenceRef).filter(Boolean);
        const evidenceRefs = explicitEvidenceRefs.length > 0
          ? explicitEvidenceRefs
          : extractEvidenceRefs(
              [claim, input.taskDescription, input.taskTitle].filter(Boolean).join("\n")
            );
        if (looksLikePlaceholder(claim)) warnings.push("finding appears to be a copied template placeholder");
        if (evidenceRefs.some(looksLikePlaceholder)) warnings.push(`finding uses placeholder evidence: ${claim.slice(0, 80)}`);
        if (!claim || looksLikePlaceholder(claim) || looksLikeProcessSelfTalk(claim)) return [];
        if (!isUsefulNaturalLanguageClaim(claim)) return [];
        if (evidenceRefs.length === 0) warnings.push(`finding has no evidence: ${claim.slice(0, 80)}`);
        return [{
          claim,
          confidence: normalizeConfidence(record.confidence),
          evidenceRefs,
        }];
      })
    : [];

  const challenges = Array.isArray(parsed.challenges)
    ? parsed.challenges.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const reason = typeof record.reason === "string"
          ? stripInternalThoughtBlocks(record.reason).trim()
          : "";
        if (looksLikePlaceholder(reason)) warnings.push("challenge appears to be a copied template placeholder");
        if (
          !reason ||
          looksLikePlaceholder(reason) ||
          looksLikeProcessSelfTalk(reason) ||
          looksLikeNoActionableRisk(reason)
        ) return [];
        if (!isUsefulNaturalLanguageClaim(reason)) return [];
        return [{
          targetFindingId:
            typeof record.targetFindingId === "string" && record.targetFindingId.trim()
              ? record.targetFindingId.trim()
              : undefined,
          reason,
          severity: normalizeSeverity(record.severity),
          requiredEvidenceRefs: asStringArray(record.requiredEvidenceRefs).map(cleanEvidenceRef).filter(Boolean),
        }];
      })
    : [];

  const parsedSummary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? stripInternalThoughtBlocks(parsed.summary).trim()
      : "";
  const summary =
    parsedSummary && !looksLikeProcessSelfTalk(parsedSummary)
      ? parsedSummary
      : findings[0]?.claim ?? text.slice(0, 600) ?? "Teammate result parsed.";

  const reasonCodes = Array.from(new Set<AgentTeamBlockReasonCode>([
    ...(findings.length === 0 ? ["missing_findings" as const] : []),
    ...(warnings.some((warning) => warning.includes("invalid TEAM_RESULT_JSON")) ? ["invalid_result_json" as const] : []),
    ...(warnings.some((warning) => warning.includes("no evidence")) ? ["missing_evidence" as const] : []),
    ...(warnings.some((warning) => warning.includes("placeholder")) ? ["placeholder_result" as const] : []),
  ]));

  return {
    summary,
    findings,
    challenges,
    needsFollowUp: asStringArray(parsed.needsFollowUp),
    warnings,
    reasonCodes,
    source: "contract",
  };
}

export function createAgentTeamResultPrompt(
  basePrompt: string,
  opts: { mode?: "collaboration" | "audit"; evidenceRequired?: boolean } = {}
): string {
  const strictEvidence = opts.mode === "audit" || opts.evidenceRequired;
  return [
    basePrompt,
    "",
    "Give a concise task result in natural language. Include concrete conclusions, evidence sources such as file paths/session refs when available, and any risk or open question.",
    strictEvidence
      ? "Evidence is required for this task. Cite concrete refs in the reply, for example file:app/example.ts, file:lib/example.ts:12, session:current, or the exact checked filename if the file does not exist."
      : "When you inspected a file, command result, or session, include that source in plain text so the Team board can trace it.",
    strictEvidence
      ? "If the target is missing, say which exact path/name you checked and that it was not found; do not return a bare conclusion without evidence."
      : "If evidence is uncertain, say what is missing instead of inventing a source.",
    "Keep the work scoped to the assigned task. Prefer targeted search and short file snippets over reading whole large files.",
    "Do not inspect git history/status/diff or broaden the audit unless the assigned task explicitly asks for that.",
    "The Team runtime will organize your reply into the Team board; do not mark the task complete yourself.",
    "",
    "If you use the structured submit tool, keep every claim real and every evidence ref concrete.",
  ].join("\n");
}

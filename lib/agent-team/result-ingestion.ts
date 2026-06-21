import type { AgentTeamChallenge, AgentTeamFinding } from "./types";

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
}

interface RawResultShape {
  summary?: unknown;
  findings?: unknown;
  challenges?: unknown;
  needsFollowUp?: unknown;
}

function extractJsonBlock(text: string): string | null {
  const taggedFence = text.match(/```TEAM_RESULT_JSON\s*([\s\S]*?)```/i);
  if (taggedFence?.[1]) return taggedFence[1].trim();
  const tagged = text.match(/TEAM_RESULT_JSON:\s*```(?:json)?\s*([\s\S]*?)```/i);
  if (tagged?.[1]) return tagged[1].trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1] && fenced[1].includes("{")) return fenced[1].trim();
  const marker = text.match(/TEAM_RESULT_JSON:\s*({[\s\S]*})/i);
  if (marker?.[1]) return marker[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1).trim();
  return null;
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

export function parseAgentTeamResultText(rawText: string): ParsedAgentTeamResult {
  const text = rawText.trim();
  const warnings: string[] = [];
  const jsonText = extractJsonBlock(text);
  if (!jsonText) {
    return {
      summary: text.slice(0, 600) || "No teammate result text was provided.",
      findings: [],
      challenges: [],
      needsFollowUp: [],
      warnings: ["missing TEAM_RESULT_JSON block"],
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
    };
  }

  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const claim = typeof record.claim === "string" ? record.claim.trim() : "";
        if (!claim) return [];
        const evidenceRefs = asStringArray(record.evidenceRefs);
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
        const reason = typeof record.reason === "string" ? record.reason.trim() : "";
        if (!reason) return [];
        return [{
          targetFindingId:
            typeof record.targetFindingId === "string" && record.targetFindingId.trim()
              ? record.targetFindingId.trim()
              : undefined,
          reason,
          severity: normalizeSeverity(record.severity),
          requiredEvidenceRefs: asStringArray(record.requiredEvidenceRefs),
        }];
      })
    : [];

  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : findings[0]?.claim ?? text.slice(0, 600) ?? "Teammate result parsed.";

  return {
    summary,
    findings,
    challenges,
    needsFollowUp: asStringArray(parsed.needsFollowUp),
    warnings,
  };
}

export function createAgentTeamResultPrompt(basePrompt: string): string {
  return [
    basePrompt,
    "",
    "Return your result as a strict JSON block prefixed with TEAM_RESULT_JSON.",
    "Do not mark the task complete yourself; the Team runtime will ingest this result.",
    "",
    "TEAM_RESULT_JSON:",
    "```json",
    JSON.stringify(
      {
        summary: "Concise task outcome.",
        findings: [
          {
            claim: "Specific claim from your work.",
            confidence: "medium",
            evidenceRefs: ["session:current", "file:path-or-artifact"],
          },
        ],
        challenges: [
          {
            targetFindingId: "",
            reason: "Risk, contradiction, or missing evidence.",
            severity: "medium",
            requiredEvidenceRefs: [],
          },
        ],
        needsFollowUp: [],
      },
      null,
      2
    ),
    "```",
  ].join("\n");
}

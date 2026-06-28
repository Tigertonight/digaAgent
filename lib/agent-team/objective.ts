import { stripContextAside } from "@/lib/context-aside";

const UI_CHROME_LINE_LABELS = new Set(["branches", "system prompt", "live"]);

function stripChromeLines(text: string): string {
  const lines = text.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const normalized = lines[index]?.trim().toLowerCase() ?? "";
    if (!UI_CHROME_LINE_LABELS.has(normalized)) break;
    index += 1;
  }
  return lines.slice(index).join("\n").trim();
}

function stripChromePrefix(text: string): string {
  return text
    .replace(/^(?:branches\s+system prompt\s+live|branches\s+system prompt|system prompt\s+live)\s+/i, "")
    .trim();
}

function stripTeamCommandPrefix(text: string): string {
  return text.replace(/^\/team(?:\s+|$)/i, "").trim();
}

export function sanitizeAgentTeamObjective(input: string): string {
  const strippedAside = stripContextAside(input).trim();
  if (!strippedAside) return "";
  return stripTeamCommandPrefix(stripChromePrefix(stripChromeLines(strippedAside)));
}

export function summarizeAgentTeamObjective(input: string, maxLength = 96): string {
  const objective = sanitizeAgentTeamObjective(input).replace(/\s+/g, " ").trim();
  if (!objective || objective.length <= maxLength) return objective;
  const keep = Math.max(12, maxLength - 1);
  return `${objective.slice(0, keep).trimEnd()}…`;
}

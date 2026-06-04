import type { SubagentDefinition } from "./definition";

export interface AgentMention {
  agentId: string;
  /** The mention as it appeared, e.g. "@reviewer". */
  raw: string;
}

/**
 * Parse explicit `@agent` mentions from free text. Only mentions whose id
 * matches a known definition are returned, so ordinary `@` usage (emails,
 * handles) is not misinterpreted as a specialist invocation.
 *
 * Pure function (no I/O); the caller supplies the known ids.
 */
export function parseAgentMentions(
  text: string,
  knownIds: Iterable<string>
): AgentMention[] {
  const known = new Set(knownIds);
  if (known.size === 0) return [];
  const out: AgentMention[] = [];
  const seen = new Set<string>();
  const re = /(^|[\s(])@([A-Za-z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[2];
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push({ agentId: id, raw: `@${id}` });
    }
  }
  return out;
}

/** Strip recognized `@agent` mentions from text, leaving the actual request. */
export function stripAgentMentions(
  text: string,
  knownIds: Iterable<string>
): string {
  const mentions = parseAgentMentions(text, knownIds);
  let out = text;
  for (const mention of mentions) {
    out = out.replace(
      new RegExp(`(^|[\\s(])${escapeRegExp(mention.raw)}\\b`, "g"),
      "$1"
    );
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Build a directive that instructs the main agent to honor explicit @agent
 * mentions by delegating to those specialists. Returns null when no recognized
 * mention is present (so ordinary prompts are untouched, 修正 5).
 *
 * The directive keeps the main agent as the orchestrator: it is told to call
 * delegate_subagents with the matching specialistId, rather than bypassing it.
 */
export function buildAgentMentionDirective(
  text: string,
  knownIds: Iterable<string>
): { directive: string; agentIds: string[] } | null {
  const mentions = parseAgentMentions(text, knownIds);
  if (mentions.length === 0) return null;
  const ids = mentions.map((m) => m.agentId);
  const cleaned = stripAgentMentions(text, knownIds);
  const directive = [
    `The user explicitly requested specialist(s): ${ids
      .map((id) => `@${id}`)
      .join(", ")}.`,
    `Use delegate_subagents and set task.specialistId to the requested id for the relevant work.`,
    "",
    "User request:",
    cleaned || text,
  ].join("\n");
  return { directive, agentIds: ids };
}

export interface RouteSuggestion {
  agentId: string;
  score: number;
  reason: string;
}

/**
 * Lightweight description-based routing hint (M2 rule version, not LLM).
 * Scores definitions by keyword overlap between the goal text and each
 * definition's title/description. Returns the best match above a threshold, or
 * null. This is only a hint; explicit @agent always wins upstream.
 */
export function suggestAgentForGoal(
  goal: string,
  definitions: SubagentDefinition[]
): RouteSuggestion | null {
  const goalTokens = tokenize(goal);
  if (goalTokens.size === 0 || definitions.length === 0) return null;
  let best: RouteSuggestion | null = null;
  for (const def of definitions) {
    const defTokens = tokenize(`${def.title} ${def.description}`);
    let overlap = 0;
    for (const t of defTokens) if (goalTokens.has(t)) overlap += 1;
    const score = defTokens.size > 0 ? overlap / defTokens.size : 0;
    if (score > 0 && (!best || score > best.score)) {
      best = {
        agentId: def.id,
        score: Math.round(score * 100) / 100,
        reason: `Matched ${overlap} keyword(s) from "${def.title}".`,
      };
    }
  }
  return best && best.score >= 0.2 ? best : null;
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "for",
  "and",
  "or",
  "to",
  "of",
  "use",
  "this",
  "with",
  "in",
  "on",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

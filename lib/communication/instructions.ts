import {
  CONTEXT_ASIDE_CLOSE,
  CONTEXT_ASIDE_OPEN,
} from "@/lib/context-aside";
import type { CommunicationSettings } from "./settings";

const CODING_MODE_INSTRUCTIONS = [
  "Communication mode: Coding.",
  "Default to concise, outcome-first updates that a vibe-coding user can understand.",
  "Mention technical details only when they directly affect a decision, risk, verification result, or user action.",
  "For final answers, lead with what changed and what was verified. Keep implementation details short unless the user asks.",
].join("\n");

const DAILY_MODE_INSTRUCTIONS = [
  "Communication mode: Daily work.",
  "Use less technical detail by default. Explain results in plain language and keep code or architecture terms to the minimum needed.",
  "When technical details are unavoidable, translate them into user impact first.",
  "For final answers, prefer a short summary, current status, and any concrete next step. Avoid long implementation walkthroughs unless asked.",
].join("\n");

export function buildCommunicationInstructions(
  settings: CommunicationSettings
): string {
  return settings.workMode === "daily"
    ? DAILY_MODE_INSTRUCTIONS
    : CODING_MODE_INSTRUCTIONS;
}

export function withCommunicationInstructions(
  text: string,
  settings: CommunicationSettings
): string {
  const instructions = buildCommunicationInstructions(settings);
  if (!instructions.trim()) return text;
  const closeIdx = text.lastIndexOf(CONTEXT_ASIDE_CLOSE);
  if (closeIdx >= 0) {
    return [
      text.slice(0, closeIdx).trimEnd(),
      "",
      instructions,
      text.slice(closeIdx),
    ].join("\n");
  }
  return [
    text,
    "",
    CONTEXT_ASIDE_OPEN,
    instructions,
    CONTEXT_ASIDE_CLOSE,
  ].join("\n");
}

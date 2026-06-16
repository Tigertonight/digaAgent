import { extractMentionsFromPaste } from "./paste-mentions";
import { extractModeFromInput, type ComposerMode } from "./mode-chip";

export interface StructuredInputExtraction {
  mode: ComposerMode | null;
  paths: string[];
  text: string;
  changed: boolean;
}

export function extractStructuredInput(
  input: string,
  currentMode: ComposerMode | null,
): StructuredInputExtraction {
  let text = input;
  let mode: ComposerMode | null = null;

  if (!currentMode) {
    const detected = extractModeFromInput(text);
    if (detected.mode) {
      mode = detected.mode;
      text = detected.text;
    }
  }

  const mentions = extractMentionsFromPaste(text);
  if (mentions.paths.length > 0) {
    text = mentions.remainingText;
  }

  return {
    mode,
    paths: mentions.paths,
    text,
    changed: mode !== null || mentions.paths.length > 0 || text !== input,
  };
}

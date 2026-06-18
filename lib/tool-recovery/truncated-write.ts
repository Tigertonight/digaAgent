import type { ExtensionFactory, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const WRITE_TRUNCATION_RECOVERY =
  "Recovery protocol for large file writes: do not retry the same write call. " +
  "The previous write call is missing the required content field, which usually means a long tool-call argument was truncated by the model output limit. " +
  "Retry by writing a short skeleton/outline first, then append one section at a time with edit or smaller write calls, and finally verify the file is non-empty with read or wc.";

export function largeFileWriteProtocolLines(): string[] {
  return [
    "Large report/document write protocol:",
    "- If you need to create a report, audit, research note, long markdown document, or any multi-section file, do not put the whole body into one write.content argument.",
    "- First call write with a short skeleton: title, section headings, and placeholders only.",
    "- Then use edit to replace one section at a time. Keep each tool-call argument small and focused.",
    "- After the last section, verify the file is non-empty and structurally complete with read, wc -l, or an equivalent check.",
    "- If a write/edit tool fails because a required large field such as content/edits/new_string is missing, treat it as truncation. Do not repeat the same call; restart with the skeleton-then-section protocol.",
  ];
}

export function toolResultText(content: ToolResultEvent["content"]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

export function isMissingWriteContentFailure(event: Pick<
  ToolResultEvent,
  "toolName" | "isError" | "input" | "content"
>): boolean {
  if (event.toolName !== "write" || !event.isError) return false;
  const hasContent =
    event.input &&
    Object.prototype.hasOwnProperty.call(event.input, "content") &&
    typeof event.input.content === "string";
  if (hasContent) return false;
  const text = toolResultText(event.content);
  return (
    /validation failed/i.test(text) &&
    /\bcontent\b/i.test(text) &&
    /required propert|must have required|is required|required field/i.test(text)
  );
}

export function appendWriteTruncationRecovery(text: string): string {
  if (text.includes(WRITE_TRUNCATION_RECOVERY)) return text;
  return `${text.trimEnd()}\n\n${WRITE_TRUNCATION_RECOVERY}`;
}

export function createWriteTruncationRecoveryExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", (event) => {
      if (!isMissingWriteContentFailure(event)) return undefined;
      return {
        content: event.content.map((part) =>
          part.type === "text"
            ? { ...part, text: appendWriteTruncationRecovery(part.text) }
            : part
        ),
        isError: true,
      };
    });
  };
}

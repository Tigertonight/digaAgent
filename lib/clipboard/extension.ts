import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { writeClipboardText } from "./runtime";

const ClipboardWriteParams = Type.Object({
  text: Type.String({
    description: "Text to copy into the local system clipboard.",
  }),
});

export function createClipboardExtension(): ExtensionFactory {
  return (pi) => {
    pi.registerTool(
      defineTool<typeof ClipboardWriteParams, { length: number }>({
        name: "clipboard_write",
        label: "Clipboard Write",
        description:
          "Copy text into the user's local system clipboard. Use after extracting a URL or short result that the user explicitly asked to copy.",
        promptSnippet: "Copy requested text to the local clipboard.",
        promptGuidelines: [
          "Use clipboard_write only when the user explicitly asks to copy something.",
          "Copy only the final text, URL, or concise value the user requested.",
          "Do not copy secrets or credentials unless the user explicitly provides and requests it.",
        ],
        parameters: ClipboardWriteParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const result = await writeClipboardText(params.text);
          return {
            content: [
              {
                type: "text",
                text: `Copied ${result.length} characters to clipboard.`,
              },
            ],
            details: { length: result.length },
          };
        },
      })
    );
  };
}

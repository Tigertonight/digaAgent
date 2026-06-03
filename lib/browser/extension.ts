import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  browserClick,
  browserClose,
  browserExtract,
  browserOpen,
  browserScreenshot,
  browserType,
  browserVerify,
  browserWait,
} from "./runtime";
import type { BrowserSnapshot } from "./types";

const OpenParams = Type.Object({
  url: Type.String({
    description:
      "URL to open. localhost addresses may omit the http:// prefix.",
  }),
});

const ClickParams = Type.Object({
  selector: Type.Optional(
    Type.String({ description: "CSS selector to click. Prefer this over x/y." })
  ),
  x: Type.Optional(Type.Number({ description: "Viewport x coordinate." })),
  y: Type.Optional(Type.Number({ description: "Viewport y coordinate." })),
});

const TypeParams = Type.Object({
  selector: Type.Optional(
    Type.String({ description: "CSS selector to fill. If omitted, type into focused element." })
  ),
  text: Type.String({ description: "Text to type or fill." }),
  pressEnter: Type.Optional(
    Type.Boolean({ description: "Press Enter after typing." })
  ),
});

const WaitParams = Type.Object({
  selector: Type.Optional(Type.String({ description: "CSS selector to wait for." })),
  text: Type.Optional(Type.String({ description: "Visible text to wait for." })),
  ms: Type.Optional(Type.Number({ description: "Milliseconds to wait." })),
});

const VerifyParams = Type.Object({
  expectation: Type.String({
    description: "The expected page state or behavior to verify.",
  }),
  selector: Type.Optional(
    Type.String({ description: "CSS selector expected to be visible." })
  ),
  text: Type.Optional(
    Type.String({ description: "Visible text expected on the page." })
  ),
});

const EmptyParams = Type.Object({});

export interface BrowserExtensionOptions {
  getAgentId: () => string;
  onBrowserState: (snapshot: BrowserSnapshot) => void;
}

function textResult(text: string, snapshot: BrowserSnapshot, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details: { snapshot, ...(details ? { result: details } : {}) },
  };
}

export function createBrowserExtension(
  opts: BrowserExtensionOptions
): ExtensionFactory {
  return (pi) => {
    pi.registerTool(
      defineTool<typeof OpenParams, { snapshot: BrowserSnapshot }>({
        name: "browser_open",
        label: "Browser Open",
        description:
          "Open a URL in the local Playwright browser panel. Use this to verify local web apps and public pages.",
        promptSnippet: "Open a page in the local browser for visual verification.",
        promptGuidelines: [
          "Use browser_open for local dev routes or public pages that do not require secrets.",
          "Keep browser tasks scoped to the current route or user flow.",
        ],
        parameters: OpenParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const { result, snapshot } = await browserOpen(opts.getAgentId(), params.url);
          opts.onBrowserState(snapshot);
          return textResult(`Opened ${result.url}`, snapshot);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof EmptyParams, { snapshot: BrowserSnapshot }>({
        name: "browser_screenshot",
        label: "Browser Screenshot",
        description: "Capture the current browser viewport screenshot.",
        promptSnippet: "Capture the current browser screenshot.",
        parameters: EmptyParams,
        executionMode: "sequential",
        async execute() {
          const { result, snapshot } = await browserScreenshot(opts.getAgentId());
          opts.onBrowserState(snapshot);
          return textResult(`Captured browser screenshot for ${result.url}`, snapshot);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof ClickParams, { snapshot: BrowserSnapshot }>({
        name: "browser_click",
        label: "Browser Click",
        description:
          "Click an element in the local browser by CSS selector, or click viewport coordinates.",
        promptSnippet: "Click in the local browser.",
        parameters: ClickParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const { result, snapshot } = await browserClick(opts.getAgentId(), params);
          opts.onBrowserState(snapshot);
          return textResult(`Clicked browser target; current URL ${result.url}`, snapshot);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof TypeParams, { snapshot: BrowserSnapshot }>({
        name: "browser_type",
        label: "Browser Type",
        description:
          "Type into the focused browser element or fill a CSS selector in the local browser.",
        promptSnippet: "Type or fill text in the local browser.",
        parameters: TypeParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const { result, snapshot } = await browserType(opts.getAgentId(), params);
          opts.onBrowserState(snapshot);
          return textResult(`Typed into browser; current URL ${result.url}`, snapshot);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof WaitParams, { snapshot: BrowserSnapshot }>({
        name: "browser_wait",
        label: "Browser Wait",
        description:
          "Wait for a selector, visible text, or a short duration in the local browser.",
        promptSnippet: "Wait for browser state.",
        parameters: WaitParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const { result, snapshot } = await browserWait(opts.getAgentId(), params);
          opts.onBrowserState(snapshot);
          return textResult(`Browser wait completed; current URL ${result.url}`, snapshot);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof EmptyParams, { snapshot: BrowserSnapshot; result?: unknown }>({
        name: "browser_extract",
        label: "Browser Extract",
        description:
          "Extract current page title, visible text, links, and form controls from the local browser.",
        promptSnippet: "Extract readable browser page state.",
        parameters: EmptyParams,
        executionMode: "sequential",
        async execute() {
          const { result, snapshot } = await browserExtract(opts.getAgentId());
          opts.onBrowserState(snapshot);
          return textResult(
            [
              `Title: ${result.title ?? "(untitled)"}`,
              `URL: ${result.url ?? "(none)"}`,
              "",
              result.text || "(no visible text)",
            ].join("\n"),
            snapshot,
            result
          );
        },
      })
    );

    pi.registerTool(
      defineTool<typeof VerifyParams, { snapshot: BrowserSnapshot; result?: unknown }>({
        name: "browser_verify",
        label: "Browser Verify",
        description:
          "Verify the current browser page against an expectation, selector, or visible text. Use after implementing a UI fix to produce a pass/fail result.",
        promptSnippet: "Verify the current browser page and report pass/fail evidence.",
        promptGuidelines: [
          "Use browser_verify after code changes when the user asked for browser validation.",
          "Prefer selector or text checks for objective verification.",
          "Report failures with the evidence returned by the tool.",
        ],
        parameters: VerifyParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const { result, snapshot } = await browserVerify(opts.getAgentId(), params);
          opts.onBrowserState(snapshot);
          return textResult(
            `${result.passed ? "PASS" : "FAIL"}: ${result.expectation}\n${result.evidence}`,
            snapshot,
            result
          );
        },
      })
    );

    pi.registerTool(
      defineTool<typeof EmptyParams, { snapshot: BrowserSnapshot }>({
        name: "browser_close",
        label: "Browser Close",
        description: "Close the local browser session for this agent.",
        promptSnippet: "Close the local browser.",
        parameters: EmptyParams,
        executionMode: "sequential",
        async execute() {
          const snapshot = await browserClose(opts.getAgentId());
          opts.onBrowserState(snapshot);
          return textResult("Closed browser session.", snapshot);
        },
      })
    );
  };
}

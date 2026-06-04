import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  browserClick,
  browserClickText,
  browserClose,
  browserExtract,
  browserFill,
  getBrowserSnapshot,
  browserOpen,
  browserSearch,
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

const FillParams = Type.Object({
  selector: Type.Optional(
    Type.String({
      description:
        "CSS selector to fill. If omitted, fill the first visible input/searchbox/textarea.",
    })
  ),
  text: Type.String({ description: "Text to fill." }),
  pressEnter: Type.Optional(
    Type.Boolean({ description: "Press Enter after filling." })
  ),
});

const ClickTextParams = Type.Object({
  text: Type.String({ description: "Visible text of the link, button, or element to click." }),
  exact: Type.Optional(
    Type.Boolean({ description: "Require an exact text match." })
  ),
});

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query." }),
  engine: Type.Optional(
    Type.Union([
      Type.Literal("baidu"),
      Type.Literal("google"),
      Type.Literal("bing"),
    ])
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

async function runWithBrowserState<T>(
  opts: BrowserExtensionOptions,
  fn: () => Promise<T>
): Promise<T> {
  try {
    const result = await fn();
    return result;
  } catch (error) {
    opts.onBrowserState(getBrowserSnapshot(opts.getAgentId()));
    throw error;
  }
}

export function createBrowserExtension(
  opts: BrowserExtensionOptions
): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", async (event) => ({
      systemPrompt: `${event.systemPrompt}

## Local Browser Control

You have access to a local browser through the browser_* tools. When the user asks you to open a web page, browse a website, search the web, click a browser link, inspect a page, verify a UI in a browser, or explicitly says to use browser/browser-use, you must operate the browser with these tools before answering.

Do not merely describe browser steps when a browser action is requested. Use browser_open or browser_search first, then browser_extract/browser_screenshot/browser_verify to inspect the result, and report the observed evidence.
`,
    }));

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
          "After opening a page, call browser_extract or browser_screenshot before deciding what to click.",
        ],
        parameters: OpenParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserOpen(opts.getAgentId(), params.url)
          );
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
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserScreenshot(opts.getAgentId())
          );
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
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserClick(opts.getAgentId(), params)
          );
          opts.onBrowserState(snapshot);
          return textResult(`Clicked browser target; current URL ${result.url}`, snapshot);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof ClickTextParams, { snapshot: BrowserSnapshot }>({
        name: "browser_click_text",
        label: "Browser Click Text",
        description:
          "Click an element by visible text in the local browser. Prefer this for links and buttons when the user gives a natural language target.",
        promptSnippet: "Click a visible link or button by text.",
        promptGuidelines: [
          "Use browser_click_text for links/buttons like search results, nav items, or labels.",
          "If multiple matches are possible, call browser_extract first and use selector-based browser_click for precision.",
        ],
        parameters: ClickTextParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserClickText(opts.getAgentId(), params)
          );
          opts.onBrowserState(snapshot);
          return textResult(`Clicked text "${params.text}"; current URL ${result.url}`, snapshot);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof FillParams, { snapshot: BrowserSnapshot }>({
        name: "browser_fill",
        label: "Browser Fill",
        description:
          "Fill a browser input/searchbox/textarea. If selector is omitted, fills the first visible editable field.",
        promptSnippet: "Fill a browser input field.",
        promptGuidelines: [
          "Use browser_fill for search boxes and forms; omit selector when the page has a single obvious input.",
          "Set pressEnter=true for search flows after filling the query.",
        ],
        parameters: FillParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserFill(opts.getAgentId(), params)
          );
          opts.onBrowserState(snapshot);
          return textResult(`Filled browser input; current URL ${result.url}`, snapshot);
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
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserType(opts.getAgentId(), params)
          );
          opts.onBrowserState(snapshot);
          return textResult(`Typed into browser; current URL ${result.url}`, snapshot);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof SearchParams, { snapshot: BrowserSnapshot; result?: unknown }>({
        name: "browser_search",
        label: "Browser Search",
        description:
          "Search the web in the local browser and show the results page. Use this when the user asks to search a public website/search engine.",
        promptSnippet: "Search the web in the local browser.",
        promptGuidelines: [
          "Use browser_search for requests like searching Baidu/Google/Bing.",
          "After search, call browser_extract to read result links before opening a result.",
        ],
        parameters: SearchParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserSearch(opts.getAgentId(), params)
          );
          opts.onBrowserState(snapshot);
          return textResult(
            `Searched ${params.engine ?? "baidu"} for "${params.query}"; current URL ${result.url}`,
            snapshot,
            result
          );
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
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserWait(opts.getAgentId(), params)
          );
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
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserExtract(opts.getAgentId())
          );
          opts.onBrowserState(snapshot);
          return textResult(
            [
              `Title: ${result.title ?? "(untitled)"}`,
              `URL: ${result.url ?? "(none)"}`,
              result.actions.length
                ? `Actions:\n${result.actions
                    .slice(0, 20)
                    .map(
                      (a, i) =>
                        `${i + 1}. [${a.kind}] ${a.text || "(no text)"} :: ${a.selectorHint}`
                    )
                    .join("\n")}`
                : "Actions: (none)",
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
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserVerify(opts.getAgentId(), params)
          );
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
          const snapshot = await runWithBrowserState(opts, () =>
            browserClose(opts.getAgentId())
          );
          opts.onBrowserState(snapshot);
          return textResult("Closed browser session.", snapshot);
        },
      })
    );
  };
}

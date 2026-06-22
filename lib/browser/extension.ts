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
  browserSearchUrl,
  browserScreenshot,
  browserScroll,
  browserTabOpen,
  browserTabs,
  browserTabSwitch,
  browserType,
  browserVerify,
  browserWait,
  browserWaitFor,
  isBrowserRuntimeError,
  listBrowserAnnotations,
  setBrowserAnnotationStatus,
} from "./runtime";
import { agentBrowserId, standaloneBrowserId } from "./browser-id";
import {
  allowBrowserSite,
  checkBrowserSite,
  describeSensitiveAction,
  detectSensitiveAction,
  normalizeBrowserUrl,
  type BrowserSensitiveAction,
} from "./policy";
import type {
  BrowserExtractResult,
  BrowserSnapshot,
  BrowserToolEvidence,
  BrowserVerifyResult,
} from "./types";

const OpenParams = Type.Object({
  url: Type.String({
    description:
      "URL to open. localhost addresses may omit the http:// prefix.",
  }),
});

const ClickParams = Type.Object(
  {
    selector: Type.Optional(
      Type.String({
        description:
          "CSS selector to click. Do not include x/y when selector is provided.",
      })
    ),
    x: Type.Optional(Type.Number({ description: "Viewport x coordinate." })),
    y: Type.Optional(Type.Number({ description: "Viewport y coordinate." })),
  },
  {
    description:
      "Provide either selector OR both x and y, but not both. Empty input is invalid.",
  }
);

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
    Type.Union(
      [
        Type.Literal("baidu"),
        Type.Literal("google"),
        Type.Literal("bing"),
      ],
      {
        description:
          "Search engine. Default is baidu. Use google or bing when an English/global query is more appropriate.",
      }
    )
  ),
});

const WaitParams = Type.Object({
  selector: Type.Optional(Type.String({ description: "CSS selector to wait for." })),
  text: Type.Optional(Type.String({ description: "Visible text to wait for." })),
  ms: Type.Optional(
    Type.Number({
      description:
        "Milliseconds to wait. If selector/text/ms are all omitted, browser_wait sleeps for 1000ms.",
    })
  ),
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

const WaitForParams = Type.Object(
  {
    url: Type.Optional(
      Type.String({
        description:
          "Wait until the current URL contains this substring. Use this to confirm a navigation/redirect finished.",
      })
    ),
    selector: Type.Optional(
      Type.String({ description: "Wait until this CSS selector appears." })
    ),
    text: Type.Optional(
      Type.String({ description: "Wait until this visible text appears." })
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        description: "Max time to wait, in milliseconds (default 10000).",
      })
    ),
  },
  {
    description:
      "Wait for one condition: url, selector, or text. Empty input is invalid.",
  }
);

const ScrollParams = Type.Object({
  direction: Type.Optional(
    Type.Union([
      Type.Literal("up"),
      Type.Literal("down"),
      Type.Literal("left"),
      Type.Literal("right"),
    ])
  ),
  pixels: Type.Optional(Type.Number({ description: "Pixels to scroll. Default 700." })),
  selector: Type.Optional(
    Type.String({ description: "CSS selector to scroll into view." })
  ),
  text: Type.Optional(
    Type.String({ description: "Visible text to scroll into view." })
  ),
});

const TabOpenParams = Type.Object({
  url: Type.String({ description: "URL to open in a new browser tab slot." }),
  switchTo: Type.Optional(
    Type.Boolean({
      description:
        "Switch to the new tab immediately. Default true. If false, the returned snapshot remains the current active tab; call browser_tab_switch before reading the new tab.",
    })
  ),
});

const TabSwitchParams = Type.Object({
  tabId: Type.Optional(
    Type.String({ description: "Stable tab id returned by browser_tabs. Prefer this over index." })
  ),
  index: Type.Optional(
    Type.Number({ description: "Zero-based tab index exactly as shown by browser_tabs. Prefer tabId when possible." })
  ),
});

const EmptyParams = Type.Object({});
const DEFAULT_STANDALONE_BROWSER_ID = standaloneBrowserId("default");
const browserFailureCounts = new Map<string, number>();

export function __clearBrowserFailureCountsForTest(): void {
  browserFailureCounts.clear();
}

export function annotationBrowserIds(
  agentId: string,
  extraBrowserIds: readonly string[] = []
): string[] {
  return [
    ...new Set([
      agentBrowserId(agentId),
      ...extraBrowserIds.filter((id) => typeof id === "string" && id.trim()),
      DEFAULT_STANDALONE_BROWSER_ID,
    ]),
  ];
}

function listOpenAnnotationsForAgent(
  agentId: string,
  extraBrowserIds: readonly string[]
) {
  const seen = new Set<string>();
  return annotationBrowserIds(agentId, extraBrowserIds)
    .flatMap((browserId) =>
      listBrowserAnnotations(browserId).filter((a) => a.status !== "resolved")
    )
    .filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
}

export function findAnnotationBrowserId(
  agentId: string,
  extraBrowserIds: readonly string[],
  annotationId: string
): string {
  const browserId = annotationBrowserIds(agentId, extraBrowserIds).find(
    (candidate) =>
      listBrowserAnnotations(candidate).some((a) => a.id === annotationId)
  );
  if (!browserId) {
    throw new Error(
      `Annotation ${annotationId} was not found for the current browser session. Refresh annotations and retry with an id returned by browser_annotations.`
    );
  }
  return browserId;
}

const ResolveAnnotationParams = Type.Object({
  annotationId: Type.String({
    description: "The id of the annotation to mark as resolved.",
  }),
});

export interface BrowserExtensionOptions {
  getAgentId: () => string;
  onBrowserState: (snapshot: BrowserSnapshot) => void;
  /**
   * 阶段 E：外部站点首次访问审批。返回 true=允许（并会被落库为 allowed），false=拒绝。
   * 由 agent-registry 注入，复用现有审批通道（approval_request/resolved + SSE）。
   * 不注入时（如无 UI 通道的子 agent）默认拒绝外部站点，保证安全语义。
   */
  requestSiteApproval?: (input: {
    origin: string;
    url: string;
  }) => Promise<boolean>;
  /**
   * 阶段 E：敏感动作（登录/付款/上传/提交）二次确认。返回 true=允许，false=拒绝。
   */
  requestActionApproval?: (input: {
    action: BrowserSensitiveAction;
    detail: string;
    url: string | null;
  }) => Promise<boolean>;
  getAnnotationBrowserIds?: () => readonly string[];
}

/** 所有 browser_* 工具统一的 details 形态（snapshot + 标准化 evidence）。 */
type BrowserToolDetails = {
  snapshot: BrowserSnapshot;
  evidence: BrowserToolEvidence;
};

type BrowserToolSdkResult = {
  content: Array<{ type: "text"; text: string }>;
  details: BrowserToolDetails;
};

/**
 * 阶段 B：把一次 browser tool 执行统一映射成 SDK 返回结构，并附带
 * 标准化的、机器可读的 evidence。
 *   - observation -> content[].text（给模型读）
 *   - snapshot + evidence -> details（给前端「验收证据面板」/审计读）
 *
 * evidence 的 url/title/screenshotDataUrl 默认从 snapshot 自动补全，
 * 调用方只需补充 tool 特有的字段（如 extractedText / passed）。
 */
function toolResult(
  observation: string,
  snapshot: BrowserSnapshot,
  evidence: Partial<BrowserToolEvidence> & { tool: string }
) {
  const fullEvidence: BrowserToolEvidence = {
    ok: evidence.ok ?? true,
    url: snapshot.url,
    title: snapshot.title,
    finalUrl: snapshot.url,
    finalTitle: snapshot.title,
    browserStatus: snapshot.status,
    screenshotDataUrl: snapshot.screenshotDataUrl,
    ...evidence,
  };
  return {
    content: [{ type: "text" as const, text: observation }],
    details: { snapshot, evidence: fullEvidence },
  };
}

function failedToolResult(
  opts: BrowserExtensionOptions,
  tool: string,
  error: unknown
): BrowserToolSdkResult {
  const snapshot = isBrowserRuntimeError(error)
    ? error.snapshot
    : getBrowserSnapshot(agentBrowserId(opts.getAgentId()));
  const message =
    error instanceof Error ? error.message : String(error || "Browser command failed");
  const errorCode = isBrowserRuntimeError(error)
    ? error.code
    : message.toLowerCase().includes("host is not connected")
      ? "browser_host_disconnected"
      : message.toLowerCase().includes("timed out")
        ? "timeout"
        : "browser_command_error";
  const observation =
    errorCode === "timeout"
      ? `Browser command timed out: ${tool}; current page: ${snapshot.url ?? "(none)"}`
      : errorCode === "chrome-error-page"
        ? `Navigation failed: chrome-error-page; current page: ${snapshot.url ?? "(none)"}`
        : message;
  opts.onBrowserState(snapshot);
  return toolResult(observation, snapshot, {
    tool,
    ok: false,
    errorCode,
    errorMessage: message,
    finalUrl: snapshot.url,
    finalTitle: snapshot.title,
    browserStatus: snapshot.status,
    durationMs: isBrowserRuntimeError(error) ? error.durationMs : undefined,
    recoverable: isBrowserRuntimeError(error) ? error.recoverable : true,
  });
}

async function runBrowserTool(
  opts: BrowserExtensionOptions,
  tool: string,
  fn: () => Promise<BrowserToolSdkResult>,
  retryKey?: string
): Promise<BrowserToolSdkResult> {
  const agentId = opts.getAgentId();
  const failureKey = retryKey ? `${agentId}:${tool}:${retryKey}` : "";
  if (failureKey && (browserFailureCounts.get(failureKey) ?? 0) >= 2) {
    const snapshot = getBrowserSnapshot(agentBrowserId(agentId));
    opts.onBrowserState(snapshot);
    return toolResult(
      `Stopped retrying ${tool} for the same target after 2 failures. Summarize the current failure evidence instead of trying the same action again.`,
      snapshot,
      {
        tool,
        ok: false,
        errorCode: "repeated_browser_action_failed",
        errorMessage:
          "The same browser action and target failed twice in this session.",
        finalUrl: snapshot.url,
        finalTitle: snapshot.title,
        browserStatus: snapshot.status,
        recoverable: true,
      }
    );
  }
  try {
    const result = await fn();
    if (failureKey) browserFailureCounts.delete(failureKey);
    return result;
  } catch (error) {
    if (failureKey) {
      browserFailureCounts.set(
        failureKey,
        (browserFailureCounts.get(failureKey) ?? 0) + 1,
      );
    }
    return failedToolResult(opts, tool, error);
  }
}

async function runWithBrowserState<T>(
  opts: BrowserExtensionOptions,
  fn: () => Promise<T>
): Promise<T> {
  try {
    const result = await fn();
    return result;
  } catch (error) {
    opts.onBrowserState(getBrowserSnapshot(agentBrowserId(opts.getAgentId())));
    throw error;
  }
}

/**
 * 阶段 E：导航前的站点守卫。
 * - local / allowed：放行。
 * - blocked：直接抛错（agent 收到拒绝原因）。
 * - unknown（外部首次）：弹审批；用户允许则落库为 allowed 后放行，否则抛错。
 */
async function guardSite(
  opts: BrowserExtensionOptions,
  url: string
): Promise<void> {
  const scope = `agent:${opts.getAgentId()}`;
  let check;
  try {
    check = await checkBrowserSite(url, scope);
  } catch {
    // URL 无法规范化时交给后续 runtime 抛更具体的错
    return;
  }
  if (check.decision === "local" || check.decision === "allowed") return;
  if (check.decision === "blocked") {
    throw new Error(
      `该站点已被屏蔽，无法访问：${check.origin}。如需访问请在浏览器面板里解除屏蔽。`
    );
  }
  // unknown：外部站点首次访问，需用户审批
  if (!opts.requestSiteApproval) {
    throw new Error(
      `外部站点未授权：${check.origin}。当前会话没有可用的审批通道，已拒绝访问。`
    );
  }
  const approved = await opts.requestSiteApproval({
    origin: check.origin,
    url: normalizeBrowserUrl(url),
  });
  if (!approved) {
    throw new Error(`用户拒绝访问外部站点：${check.origin}`);
  }
  // 用户批准 → 落库为 allowed，后续同源不再询问
  await allowBrowserSite(check.origin, scope).catch(() => {});
}

/**
 * 阶段 E：敏感动作守卫（登录/付款/上传/提交）。
 * 从给定文本里识别敏感动作，命中则二次确认；未命中或无审批通道则放行。
 */
async function guardAction(
  opts: BrowserExtensionOptions,
  texts: Array<string | null | undefined>
): Promise<void> {
  const action = detectSensitiveAction(...texts);
  if (!action) return;
  // 没有审批通道时不阻断普通输入（避免误伤），仅当有通道时确认
  if (!opts.requestActionApproval) return;
  const snapshot = getBrowserSnapshot(agentBrowserId(opts.getAgentId()));
  const approved = await opts.requestActionApproval({
    action,
    detail: describeSensitiveAction(action),
    url: snapshot.url,
  });
  if (!approved) {
    throw new Error(
      `用户拒绝执行${describeSensitiveAction(action)}（敏感动作需确认）。`
    );
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

Operate the browser step by step, observing between steps:
1. browser_open / browser_search to navigate.
2. browser_extract / browser_screenshot to observe the current page.
3. browser_click / browser_click_text / browser_fill / browser_type to interact.
4. browser_scroll to move through long pages or scroll a selector/text into view.
5. browser_tabs / browser_tab_open / browser_tab_switch when the user asks to compare or switch between multiple pages. Prefer tabId over index. In the in-app browser host, switching a tab slot may reload that tab's URL instead of preserving form/scroll/history state.
6. browser_wait_for (url/selector/text) after any action that triggers navigation or async content, to confirm the page settled before observing again.
7. browser_verify to produce an objective pass/fail result against an expectation, selector, or text.

Do not merely describe browser steps when a browser action is requested. Actually call the tools, then report the observed evidence (URL, title, and pass/fail).

## Page Annotations

The user can draw a region on the browser page and leave a comment. These page annotations are visual tasks pointing at a specific area of a page. Call browser_annotations to read pending annotations (each has a region, the page URL, and the user's comment). After you address an annotation (e.g. fix the UI and re-verify with browser_verify), call browser_resolve_annotation with its id to mark it done.

## Browser Safety

- localhost / 127.0.0.1 / file URLs are always allowed.
- Visiting an external site for the first time requires user approval. browser_open may pause for the user to approve; once approved that origin is remembered for the session.
- Sensitive actions (login, payment, file upload, form submit) require an extra confirmation. Only attempt them when the user clearly asked for it, and never enter credentials, card numbers, or other secrets on your own initiative — let the user take over for those.
- If a navigation or action is denied, report it to the user instead of retrying in a loop.
- If the same browser action for the same URL/selector fails twice, stop retrying and summarize the structured failure evidence (errorCode, finalUrl, title, and whether it is recoverable).
- browser_wait with empty input is only a short 1000ms sleep. Prefer browser_wait_for with url, selector, or text for real readiness checks.
`,
    }));

    pi.registerTool(
      defineTool<typeof OpenParams, BrowserToolDetails>({
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
          return runBrowserTool(opts, "browser_open", async () => {
            await guardSite(opts, params.url);
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserOpen(agentBrowserId(opts.getAgentId()), params.url)
            );
            opts.onBrowserState(snapshot);
            return toolResult(`Opened ${result.url}`, snapshot, {
              tool: "browser_open",
            });
          }, params.url.trim());
        },
      })
    );

    pi.registerTool(
      defineTool<typeof EmptyParams, BrowserToolDetails>({
        name: "browser_screenshot",
        label: "Browser Screenshot",
        description: "Capture the current browser viewport screenshot.",
        promptSnippet: "Capture the current browser screenshot.",
        parameters: EmptyParams,
        executionMode: "sequential",
        async execute() {
          return runBrowserTool(opts, "browser_screenshot", async () => {
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserScreenshot(agentBrowserId(opts.getAgentId()))
            );
            opts.onBrowserState(snapshot);
            return toolResult(
              `Captured browser screenshot for ${result.url}`,
              snapshot,
              { tool: "browser_screenshot" }
            );
          });
        },
      })
    );

    pi.registerTool(
      defineTool<typeof ClickParams, BrowserToolDetails>({
        name: "browser_click",
        label: "Browser Click",
        description:
          "Click an element in the local browser by CSS selector, or click viewport coordinates.",
        promptSnippet: "Click in the local browser.",
        parameters: ClickParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const clickTarget =
            "selector" in params ? params.selector : `${params.x},${params.y}`;
          return runBrowserTool(opts, "browser_click", async () => {
            await guardAction(opts, [
              clickTarget,
            ]);
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserClick(agentBrowserId(opts.getAgentId()), params)
            );
            opts.onBrowserState(snapshot);
            return toolResult(
              `Clicked browser target; current URL ${result.url}`,
              snapshot,
              { tool: "browser_click" }
            );
          }, clickTarget);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof ClickTextParams, BrowserToolDetails>({
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
          return runBrowserTool(opts, "browser_click_text", async () => {
            await guardAction(opts, [params.text]);
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserClickText(agentBrowserId(opts.getAgentId()), params)
            );
            opts.onBrowserState(snapshot);
            return toolResult(
              `Clicked text "${params.text}"; current URL ${result.url}`,
              snapshot,
              { tool: "browser_click_text" }
            );
          }, params.text);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof FillParams, BrowserToolDetails>({
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
          return runBrowserTool(opts, "browser_fill", async () => {
            await guardAction(opts, [params.selector, params.text]);
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserFill(agentBrowserId(opts.getAgentId()), params)
            );
            opts.onBrowserState(snapshot);
            return toolResult(
              `Filled browser input; current URL ${result.url}`,
              snapshot,
              { tool: "browser_fill" }
            );
          }, `${params.selector ?? "(first-editable)"}:${params.text}`);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof TypeParams, BrowserToolDetails>({
        name: "browser_type",
        label: "Browser Type",
        description:
          "Type into the focused browser element or fill a CSS selector in the local browser.",
        promptSnippet: "Type or fill text in the local browser.",
        parameters: TypeParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          return runBrowserTool(opts, "browser_type", async () => {
            await guardAction(opts, [params.selector, params.text]);
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserType(agentBrowserId(opts.getAgentId()), params)
            );
            opts.onBrowserState(snapshot);
            return toolResult(
              `Typed into browser; current URL ${result.url}`,
              snapshot,
              { tool: "browser_type" }
            );
          }, `${params.selector ?? "(focused)"}:${params.text}`);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof SearchParams, BrowserToolDetails>({
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
          const search = browserSearchUrl(params);
          return runBrowserTool(opts, "browser_search", async () => {
            await guardSite(opts, search.url);
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserSearch(agentBrowserId(opts.getAgentId()), params)
            );
            opts.onBrowserState(snapshot);
            return toolResult(
              `Searched ${params.engine ?? "baidu"} for "${params.query}"; current URL ${result.url}`,
              snapshot,
              { tool: "browser_search" }
            );
          }, `${search.engine}:${params.query}`);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof WaitParams, BrowserToolDetails>({
        name: "browser_wait",
        label: "Browser Wait",
        description:
          "Wait for a selector, visible text, or a short duration in the local browser.",
        promptSnippet: "Wait for browser state.",
        parameters: WaitParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          return runBrowserTool(opts, "browser_wait", async () => {
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserWait(agentBrowserId(opts.getAgentId()), params)
            );
            opts.onBrowserState(snapshot);
            return toolResult(
              `Browser wait completed; current URL ${result.url}`,
              snapshot,
              { tool: "browser_wait" }
            );
          });
        },
      })
    );

    pi.registerTool(
      defineTool<typeof WaitForParams, BrowserToolDetails>({
        name: "browser_wait_for",
        label: "Browser Wait For",
        description:
          "Wait until a condition is met in the local browser: the URL contains a substring (navigation/redirect finished), a CSS selector appears, or visible text appears. Prefer this over browser_wait after clicks/submits that trigger navigation or async content.",
        promptSnippet: "Wait until a browser condition is met.",
        promptGuidelines: [
          "Use browser_wait_for with url=... to confirm a navigation finished before extracting/verifying.",
          "Use selector or text to wait for async content to render.",
          "This fails (error step) if the condition is not met within timeoutMs, which is useful evidence.",
        ],
        parameters: WaitForParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const waitParams = params as {
            url?: string;
            selector?: string;
            text?: string;
            timeoutMs?: number;
          };
          const retryKey =
            waitParams.url ??
            waitParams.selector ??
            waitParams.text ??
            "(empty)";
          return runBrowserTool(opts, "browser_wait_for", async () => {
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserWaitFor(agentBrowserId(opts.getAgentId()), waitParams)
            );
            opts.onBrowserState(snapshot);
            const condition =
              waitParams.url
                ? `url contains "${waitParams.url}"`
                : waitParams.selector
                  ? `selector "${waitParams.selector}" appeared`
                  : waitParams.text
                    ? `text "${waitParams.text}" appeared`
                    : "condition met";
            return toolResult(
              `Wait condition met (${condition}); current URL ${result.url}`,
              snapshot,
              { tool: "browser_wait_for", passed: true }
            );
          }, retryKey);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof ScrollParams, BrowserToolDetails>({
        name: "browser_scroll",
        label: "Browser Scroll",
        description:
          "Scroll the local browser by direction/pixels, or scroll a CSS selector or visible text into view. Use this for long pages and anchored sections.",
        promptSnippet: "Scroll the browser page or bring a target into view.",
        promptGuidelines: [
          "Use selector or text when the user asks to find a section on a long page.",
          "Use direction/pixels for incremental page reading.",
          "After scrolling, call browser_extract or browser_screenshot if you need visible evidence.",
        ],
        parameters: ScrollParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const retryKey =
            params.selector ??
            params.text ??
            params.direction ??
            String(params.pixels ?? "(default)");
          return runBrowserTool(opts, "browser_scroll", async () => {
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserScroll(agentBrowserId(opts.getAgentId()), params)
            );
            opts.onBrowserState(snapshot);
            return toolResult(
              `Scrolled browser; current URL ${result.url}`,
              snapshot,
              { tool: "browser_scroll" }
            );
          }, retryKey);
        },
      })
    );

    pi.registerTool(
      defineTool<typeof EmptyParams, BrowserToolDetails>({
        name: "browser_tabs",
        label: "Browser Tabs",
        description:
          "List browser tab slots known to the local browser runtime, including active tab id, URL, and title.",
        promptSnippet: "List current browser tab slots.",
        parameters: EmptyParams,
        executionMode: "sequential",
        async execute() {
          return runBrowserTool(opts, "browser_tabs", async () => {
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserTabs(agentBrowserId(opts.getAgentId()))
            );
            opts.onBrowserState(snapshot);
            return toolResult(result.text, snapshot, { tool: "browser_tabs" });
          });
        },
      })
    );

    pi.registerTool(
      defineTool<typeof TabOpenParams, BrowserToolDetails>({
        name: "browser_tab_open",
        label: "Browser Tab Open",
        description:
          "Open a URL in a new browser tab slot and optionally switch to it. Use this when comparing multiple pages.",
        promptSnippet: "Open a new browser tab slot.",
        promptGuidelines: [
          "Use browser_tab_open instead of overwriting the current page when the user asks to compare pages.",
          "Call browser_tabs after opening multiple tab slots so you can switch by tabId.",
          "When switchTo=false, do not assume the active snapshot is the new page; switch to that tab before extracting it.",
        ],
        parameters: TabOpenParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          return runBrowserTool(opts, "browser_tab_open", async () => {
            await guardSite(opts, params.url);
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserTabOpen(agentBrowserId(opts.getAgentId()), params)
            );
            opts.onBrowserState(snapshot);
            return toolResult(
              `Opened browser tab ${String((result as { tabId?: unknown }).tabId ?? snapshot.activeTabId)} at ${result.url}`,
              snapshot,
              { tool: "browser_tab_open" }
            );
          }, params.url.trim());
        },
      })
    );

    pi.registerTool(
      defineTool<typeof TabSwitchParams, BrowserToolDetails>({
        name: "browser_tab_switch",
        label: "Browser Tab Switch",
        description:
          "Switch to a browser tab slot by tabId or zero-based index from browser_tabs.",
        promptSnippet: "Switch browser tab slot.",
        parameters: TabSwitchParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          return runBrowserTool(opts, "browser_tab_switch", async () => {
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserTabSwitch(agentBrowserId(opts.getAgentId()), params)
            );
            opts.onBrowserState(snapshot);
            return toolResult(
              `Switched browser tab; current URL ${result.url}`,
              snapshot,
              { tool: "browser_tab_switch" }
            );
          });
        },
      })
    );

    pi.registerTool(
      defineTool<typeof EmptyParams, BrowserToolDetails>({
        name: "browser_extract",
        label: "Browser Extract",
        description:
          "Extract current page title, visible text, links, and form controls from the local browser.",
        promptSnippet: "Extract readable browser page state.",
        parameters: EmptyParams,
        executionMode: "sequential",
        async execute() {
          return runBrowserTool(opts, "browser_extract", async () => {
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserExtract(agentBrowserId(opts.getAgentId()))
            );
            opts.onBrowserState(snapshot);
            const extracted: BrowserExtractResult = result;
            return toolResult(
              [
                `Title: ${extracted.title ?? "(untitled)"}`,
                `URL: ${extracted.url ?? "(none)"}`,
                extracted.partial ? "Partial: true" : "Partial: false",
                extracted.headings?.length
                  ? `Headings:\n${extracted.headings
                      .slice(0, 12)
                      .map((h) => `${"#".repeat(Math.min(Math.max(h.level, 1), 6))} ${h.text}`)
                      .join("\n")}`
                  : "Headings: (none)",
                extracted.actions.length
                  ? `Actions:\n${extracted.actions
                      .slice(0, 20)
                      .map(
                        (a, i) =>
                          `${i + 1}. [${a.kind}] ${a.text || "(no text)"} :: ${a.selectorHint}`
                      )
                      .join("\n")}`
                  : "Actions: (none)",
                "",
                extracted.text || "(no visible text)",
              ].join("\n"),
              snapshot,
              {
                tool: "browser_extract",
                extractedText: extracted.text,
                partial: extracted.partial === true,
              }
            );
          });
        },
      })
    );

    pi.registerTool(
      defineTool<typeof VerifyParams, BrowserToolDetails>({
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
          return runBrowserTool(opts, "browser_verify", async () => {
            const { result, snapshot } = await runWithBrowserState(opts, () =>
              browserVerify(agentBrowserId(opts.getAgentId()), params)
            );
            opts.onBrowserState(snapshot);
            const verified: BrowserVerifyResult = result;
            return toolResult(
              `${verified.passed ? "PASS" : "FAIL"}: ${verified.expectation}\n${verified.evidence}`,
              snapshot,
              { tool: "browser_verify", passed: verified.passed }
            );
          });
        },
      })
    );

    pi.registerTool(
      defineTool<typeof EmptyParams, { annotations: unknown }>({
        name: "browser_annotations",
        label: "Browser Annotations",
        description:
          "List the user's pending page annotations (region + URL + comment) for the current browser. Use this to discover visual tasks the user drew on the page.",
        promptSnippet: "Read pending page annotations.",
        promptGuidelines: [
          "Call browser_annotations when the user asks you to handle their page comments/annotations.",
          "Each annotation has an id, a region, the page URL, and the user's comment.",
          "After addressing one, call browser_resolve_annotation with its id.",
        ],
        parameters: EmptyParams,
        executionMode: "sequential",
        async execute() {
          const open = listOpenAnnotationsForAgent(
            opts.getAgentId(),
            opts.getAnnotationBrowserIds?.() ?? []
          );
          const pct = (n: number) => `${Math.round(n * 100)}%`;
          const text =
            open.length === 0
              ? "No pending page annotations."
              : open
                  .map(
                    (a, i) =>
                      `${i + 1}. [id=${a.id}] @ ${a.url ?? "(no url)"}\n   region ${pct(
                        a.rect.x
                      )},${pct(a.rect.y)} ${pct(a.rect.w)}x${pct(a.rect.h)}\n   comment: ${a.comment}`
                  )
                  .join("\n");
          return {
            content: [{ type: "text" as const, text }],
            details: { annotations: open },
          };
        },
      })
    );

    pi.registerTool(
      defineTool<typeof ResolveAnnotationParams, { ok: boolean }>({
        name: "browser_resolve_annotation",
        label: "Browser Resolve Annotation",
        description:
          "Mark a page annotation as resolved after you have addressed the user's comment.",
        promptSnippet: "Mark a page annotation as resolved.",
        parameters: ResolveAnnotationParams,
        executionMode: "sequential",
        async execute(_toolCallId, params) {
          const browserId = findAnnotationBrowserId(
            opts.getAgentId(),
            opts.getAnnotationBrowserIds?.() ?? [],
            params.annotationId
          );
          const snapshot = setBrowserAnnotationStatus(
            browserId,
            params.annotationId,
            "resolved"
          );
          opts.onBrowserState(snapshot);
          return {
            content: [
              {
                type: "text" as const,
                text: `Marked annotation ${params.annotationId} as resolved.`,
              },
            ],
            details: { ok: true },
          };
        },
      })
    );

    pi.registerTool(
      defineTool<typeof EmptyParams, BrowserToolDetails>({
        name: "browser_close",
        label: "Browser Close",
        description: "Close the local browser session for this agent.",
        promptSnippet: "Close the local browser.",
        parameters: EmptyParams,
        executionMode: "sequential",
        async execute() {
          return runBrowserTool(opts, "browser_close", async () => {
            const snapshot = await runWithBrowserState(opts, () =>
              browserClose(agentBrowserId(opts.getAgentId()))
            );
            opts.onBrowserState(snapshot);
            return toolResult("Closed browser session.", snapshot, {
              tool: "browser_close",
            });
          });
        },
      })
    );
  };
}

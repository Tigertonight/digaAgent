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
  browserWaitFor,
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

const WaitForParams = Type.Object({
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
    Type.Number({ description: "Max time to wait, in milliseconds (default 10000)." })
  ),
});

const EmptyParams = Type.Object({});
const DEFAULT_STANDALONE_BROWSER_ID = standaloneBrowserId("default");

function annotationBrowserIds(agentId: string): string[] {
  return [agentBrowserId(agentId), DEFAULT_STANDALONE_BROWSER_ID];
}

function listOpenAnnotationsForAgent(agentId: string) {
  const seen = new Set<string>();
  return annotationBrowserIds(agentId)
    .flatMap((browserId) =>
      listBrowserAnnotations(browserId).filter((a) => a.status !== "resolved")
    )
    .filter((a) => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
}

function findAnnotationBrowserId(agentId: string, annotationId: string): string {
  return (
    annotationBrowserIds(agentId).find((browserId) =>
      listBrowserAnnotations(browserId).some((a) => a.id === annotationId)
    ) ?? agentBrowserId(agentId)
  );
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
}

/** 所有 browser_* 工具统一的 details 形态（snapshot + 标准化 evidence）。 */
type BrowserToolDetails = {
  snapshot: BrowserSnapshot;
  evidence: BrowserToolEvidence;
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
    url: snapshot.url,
    title: snapshot.title,
    screenshotDataUrl: snapshot.screenshotDataUrl,
    ...evidence,
  };
  return {
    content: [{ type: "text" as const, text: observation }],
    details: { snapshot, evidence: fullEvidence },
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
  let check;
  try {
    check = await checkBrowserSite(url);
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
  await allowBrowserSite(check.origin).catch(() => {});
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
4. browser_wait_for (url/selector/text) after any action that triggers navigation or async content, to confirm the page settled before observing again.
5. browser_verify to produce an objective pass/fail result against an expectation, selector, or text.

Do not merely describe browser steps when a browser action is requested. Actually call the tools, then report the observed evidence (URL, title, and pass/fail).

## Page Annotations

The user can draw a region on the browser page and leave a comment. These page annotations are visual tasks pointing at a specific area of a page. Call browser_annotations to read pending annotations (each has a region, the page URL, and the user's comment). After you address an annotation (e.g. fix the UI and re-verify with browser_verify), call browser_resolve_annotation with its id to mark it done.

## Browser Safety

- localhost / 127.0.0.1 / file URLs are always allowed.
- Visiting an external site for the first time requires user approval. browser_open may pause for the user to approve; once approved that origin is remembered for the session.
- Sensitive actions (login, payment, file upload, form submit) require an extra confirmation. Only attempt them when the user clearly asked for it, and never enter credentials, card numbers, or other secrets on your own initiative — let the user take over for those.
- If a navigation or action is denied, report it to the user instead of retrying in a loop.
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
          await guardSite(opts, params.url);
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserOpen(agentBrowserId(opts.getAgentId()), params.url)
          );
          opts.onBrowserState(snapshot);
          return toolResult(`Opened ${result.url}`, snapshot, {
            tool: "browser_open",
          });
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
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserScreenshot(agentBrowserId(opts.getAgentId()))
          );
          opts.onBrowserState(snapshot);
          return toolResult(
            `Captured browser screenshot for ${result.url}`,
            snapshot,
            { tool: "browser_screenshot" }
          );
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
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserClick(agentBrowserId(opts.getAgentId()), params)
          );
          opts.onBrowserState(snapshot);
          return toolResult(
            `Clicked browser target; current URL ${result.url}`,
            snapshot,
            { tool: "browser_click" }
          );
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
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserSearch(agentBrowserId(opts.getAgentId()), params)
          );
          opts.onBrowserState(snapshot);
          return toolResult(
            `Searched ${params.engine ?? "baidu"} for "${params.query}"; current URL ${result.url}`,
            snapshot,
            { tool: "browser_search" }
          );
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
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserWait(agentBrowserId(opts.getAgentId()), params)
          );
          opts.onBrowserState(snapshot);
          return toolResult(
            `Browser wait completed; current URL ${result.url}`,
            snapshot,
            { tool: "browser_wait" }
          );
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
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserWaitFor(agentBrowserId(opts.getAgentId()), params)
          );
          opts.onBrowserState(snapshot);
          const condition =
            params.url
              ? `url contains "${params.url}"`
              : params.selector
                ? `selector "${params.selector}" appeared`
                : params.text
                  ? `text "${params.text}" appeared`
                  : "condition met";
          return toolResult(
            `Wait condition met (${condition}); current URL ${result.url}`,
            snapshot,
            { tool: "browser_wait_for", passed: true }
          );
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
          const { result, snapshot } = await runWithBrowserState(opts, () =>
            browserExtract(agentBrowserId(opts.getAgentId()))
          );
          opts.onBrowserState(snapshot);
          const extracted: BrowserExtractResult = result;
          return toolResult(
            [
              `Title: ${extracted.title ?? "(untitled)"}`,
              `URL: ${extracted.url ?? "(none)"}`,
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
            }
          );
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
          const open = listOpenAnnotationsForAgent(opts.getAgentId());
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
          const snapshot = await runWithBrowserState(opts, () =>
            browserClose(agentBrowserId(opts.getAgentId()))
          );
          opts.onBrowserState(snapshot);
          return toolResult("Closed browser session.", snapshot, {
            tool: "browser_close",
          });
        },
      })
    );
  };
}

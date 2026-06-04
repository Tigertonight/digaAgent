import type { BrowserIntent } from "./intent";
import { writeClipboardText } from "../clipboard/runtime";
import {
  browserClickText,
  browserExtract,
  browserFill,
  browserOpen,
  browserRecordTaskNote,
  browserSearch,
  browserVerify,
  updateBrowserTask,
} from "./runtime";
import type {
  BrowserExtractResult,
  BrowserSnapshot,
  BrowserVerifyResult,
} from "./types";

export type BrowserTaskStatus =
  | "idle"
  | "running"
  | "passed"
  | "failed"
  | "blocked";

export interface BrowserTaskPreflightResult {
  handled: boolean;
  taskId: string | null;
  status: BrowserTaskStatus;
  observation: string | null;
}

export interface BrowserTaskRuntimeOptions {
  agentId: string;
  intent: BrowserIntent;
  pushState: (snapshot: BrowserSnapshot) => void;
}

function createTaskId() {
  return `bt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatLinks(links: BrowserExtractResult["links"]) {
  if (links.length === 0) return "Links: (none)";
  return [
    "Links:",
    ...links
      .slice(0, 8)
      .map((link, i) => `${i + 1}. ${link.text || "(no text)"} ${link.href}`),
  ].join("\n");
}

function formatActions(actions: BrowserExtractResult["actions"]) {
  if (actions.length === 0) return "Actions: (none)";
  return [
    "Actions:",
    ...actions
      .slice(0, 12)
      .map(
        (action, i) =>
          `${i + 1}. [${action.kind}] ${action.text || "(no text)"} :: ${action.selectorHint}`
      ),
  ].join("\n");
}

function formatExtract(result: BrowserExtractResult) {
  return [
    `browser_extract title: ${result.title ?? "(untitled)"}`,
    `browser_extract url: ${result.url ?? "(none)"}`,
    `browser_extract text: ${result.text.slice(0, 1800)}`,
    formatLinks(result.links),
    formatActions(result.actions),
  ].join("\n");
}

function formatVerify(result: BrowserVerifyResult) {
  return `browser_verify: ${result.passed ? "PASS" : "FAIL"} ${result.evidence}`;
}

function findSearchResultLink(result: BrowserExtractResult, index: number) {
  const links = result.links.filter((link) => {
    if (!link.href) return false;
    if (!/^https?:\/\//i.test(link.href)) return false;
    if (/baidu\.com\/(s\?|sf\/|link\?url=|static\/|cache\/|img)/i.test(link.href))
      return false;
    if (/google\.[^/]+\/(search|preferences|advanced_search)/i.test(link.href))
      return false;
    if (/bing\.com\/(search|images|videos|maps)/i.test(link.href)) return false;
    return true;
  });
  return links[index] ?? null;
}

async function selectAndMaybeCopyResult(
  agentId: string,
  taskId: string,
  extracted: BrowserExtractResult,
  index: number,
  copyResult: boolean | undefined,
  observations: string[],
  pushState: (snapshot: BrowserSnapshot) => void
) {
  const selected = findSearchResultLink(extracted, index);
  if (!selected) {
    observations.push(
      "browser_result: no suitable result link found. The page may be blocked, captcha-protected, or not a normal results page."
    );
    return { ok: false as const, error: "no suitable result link found" };
  }

  observations.push(
    `browser_result: ${index + 1}. ${selected.text || "(no title)"} ${selected.href}`
  );
  pushState(
    await browserRecordTaskNote(agentId, {
      taskId,
      action: "result_select",
      label: `${index + 1}. ${selected.text || selected.href}`,
    })
  );
  if (copyResult) {
    const copied = await writeClipboardText(selected.href);
    observations.push(
      `clipboard_write: copied ${copied.length} characters from browser_result href`
    );
    pushState(
      await browserRecordTaskNote(agentId, {
        taskId,
        action: "clipboard_write",
        label: selected.href,
      })
    );
  }
  return { ok: true as const, link: selected };
}

function appendObservation(prompt: string, observation: string) {
  return `${prompt}

Browser task was executed before the model response.

Observed browser state:

${observation}

Use these observed browser results as factual evidence. If the browser observation contains enough evidence, answer directly and do not claim you cannot browse.`;
}

async function extractAndPush(
  agentId: string,
  taskId: string,
  pushState: (snapshot: BrowserSnapshot) => void
) {
  const extracted = await browserExtract(agentId, { taskId });
  pushState(extracted.snapshot);
  return extracted.result;
}

async function verifyAndPush(
  agentId: string,
  taskId: string,
  input: { expectation: string; text?: string },
  pushState: (snapshot: BrowserSnapshot) => void
) {
  const verified = await browserVerify(agentId, input, { taskId });
  pushState(verified.snapshot);
  return verified.result;
}

export async function runBrowserTaskPreflight(
  opts: BrowserTaskRuntimeOptions
): Promise<BrowserTaskPreflightResult> {
  const { agentId, intent, pushState } = opts;
  if (intent.kind === "none") {
    return { handled: false, taskId: null, status: "idle", observation: null };
  }

  const taskId = createTaskId();
  const observations: string[] = [`task_id: ${taskId}`, `intent: ${intent.kind}`];
  const startedAt = Date.now();
  pushState(
    updateBrowserTask(agentId, {
      id: taskId,
      status: "running",
      intent: intent.kind,
      startedAt,
    })
  );

  const finishTask = (
    status: Exclude<BrowserTaskStatus, "idle" | "running">,
    error?: string
  ) => {
    pushState(
      updateBrowserTask(agentId, {
        id: taskId,
        status,
        intent: intent.kind,
        startedAt,
        completedAt: Date.now(),
        error,
      })
    );
  };

  try {
    if (intent.kind === "search") {
      const searched = await browserSearch(agentId, {
        query: intent.query,
        engine: intent.engine,
      }, { taskId });
      pushState(searched.snapshot);
      observations.push(
        `browser_search: ${searched.result.engine} "${searched.result.query}" -> ${searched.result.url}`
      );

      const extracted = await extractAndPush(agentId, taskId, pushState);
      observations.push(formatExtract(extracted));
      if (typeof intent.resultIndex === "number") {
        const selected = await selectAndMaybeCopyResult(
          agentId,
          taskId,
          extracted,
          intent.resultIndex,
          intent.copyResult,
          observations,
          pushState
        );
        if (!selected.ok) {
          finishTask("blocked", selected.error);
          return {
            handled: true,
            taskId,
            status: "blocked",
            observation: observations.join("\n\n"),
          };
        }
      }
      finishTask("passed");
      return {
        handled: true,
        taskId,
        status: "passed",
        observation: observations.join("\n\n"),
      };
    }

    if (intent.kind === "open_url" || intent.kind === "ui_verify") {
      if (intent.url) {
        const opened = await browserOpen(agentId, intent.url, { taskId });
        pushState(opened.snapshot);
        observations.push(`browser_open: ${opened.result.url}`);
      }

      const extracted = await extractAndPush(agentId, taskId, pushState);
      observations.push(formatExtract(extracted));
      if (intent.kind === "open_url" && typeof intent.resultIndex === "number") {
        const selected = await selectAndMaybeCopyResult(
          agentId,
          taskId,
          extracted,
          intent.resultIndex,
          intent.copyResult,
          observations,
          pushState
        );
        if (!selected.ok) {
          finishTask("blocked", selected.error);
          return {
            handled: true,
            taskId,
            status: "blocked",
            observation: observations.join("\n\n"),
          };
        }
      }

      const expectation =
        intent.kind === "ui_verify"
          ? intent.expectation
          : intent.expectation ?? intent.verifyText;
      if (expectation) {
        const verified = await verifyAndPush(
          agentId,
          taskId,
          { expectation, text: intent.verifyText },
          pushState
        );
        observations.push(formatVerify(verified));
        finishTask(verified.passed ? "passed" : "failed");
        return {
          handled: true,
          taskId,
          status: verified.passed ? "passed" : "failed",
          observation: observations.join("\n\n"),
        };
      }

      finishTask("passed");
      return {
        handled: true,
        taskId,
        status: "passed",
        observation: observations.join("\n\n"),
      };
    }

    if (intent.kind === "navigate") {
      if (intent.url) {
        const opened = await browserOpen(agentId, intent.url, { taskId });
        pushState(opened.snapshot);
        observations.push(`browser_open: ${opened.result.url}`);
      }
      const extracted = await extractAndPush(agentId, taskId, pushState);
      observations.push(formatExtract(extracted));
      if (intent.fillText) {
        const filled = await browserFill(
          agentId,
          { text: intent.fillText, pressEnter: intent.pressEnter },
          { taskId }
        );
        pushState(filled.snapshot);
        observations.push(
          `browser_fill: "${intent.fillText}"${intent.pressEnter ? " + Enter" : ""} -> ${filled.result.url}`
        );
        const afterFill = await extractAndPush(agentId, taskId, pushState);
        observations.push(formatExtract(afterFill));
      }
      if (intent.clickText) {
        const clicked = await browserClickText(
          agentId,
          { text: intent.clickText },
          { taskId }
        );
        pushState(clicked.snapshot);
        observations.push(
          `browser_click_text: "${intent.clickText}" -> ${clicked.result.url}`
        );
        const afterClick = await extractAndPush(agentId, taskId, pushState);
        observations.push(formatExtract(afterClick));
      }
      finishTask("passed");
      return {
        handled: true,
        taskId,
        status: "passed",
        observation: observations.join("\n\n"),
      };
    }
  } catch (error) {
    observations.push(
      `browser_task_error: ${error instanceof Error ? error.message : String(error)}`
    );
    const message = error instanceof Error ? error.message : String(error);
    finishTask("blocked", message);
    return {
      handled: true,
      taskId,
      status: "blocked",
      observation: observations.join("\n\n"),
    };
  }

  return { handled: false, taskId: null, status: "idle", observation: null };
}

export function appendBrowserObservation(prompt: string, observation: string | null) {
  return observation ? appendObservation(prompt, observation) : prompt;
}

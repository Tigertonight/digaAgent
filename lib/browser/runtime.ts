import "server-only";
import type {
  Browser,
  BrowserContext,
  Page,
  Locator,
} from "playwright";
import {
  EMPTY_BROWSER_SNAPSHOT,
  type BrowserActionLog,
  type BrowserExtractResult,
  type BrowserPointerState,
  type BrowserSnapshot,
  type BrowserStepSnapshot,
  type BrowserTaskState,
  type BrowserVerifyResult,
} from "./types";
import { assertBrowserSiteAllowed } from "./policy";

type PlaywrightModule = typeof import("playwright");

interface BrowserRecord {
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  snapshot: BrowserSnapshot;
}

interface BrowserActionOptions {
  taskId?: string;
}

interface GlobalBrowserRegistry {
  browsers: Map<string, BrowserRecord>;
}

const g = globalThis as unknown as { __miniPiBrowser?: GlobalBrowserRegistry };
if (!g.__miniPiBrowser) {
  g.__miniPiBrowser = { browsers: new Map() };
}
const reg = g.__miniPiBrowser;

function emptyRecord(): BrowserRecord {
  return {
    browser: null,
    context: null,
    page: null,
    snapshot: { ...EMPTY_BROWSER_SNAPSHOT, logs: [], steps: [] },
  };
}

function getRecord(agentId: string): BrowserRecord {
  let rec = reg.browsers.get(agentId);
  if (!rec) {
    rec = emptyRecord();
    reg.browsers.set(agentId, rec);
  }
  return rec;
}

function pushLog(
  rec: BrowserRecord,
  action: string,
  label: string,
  opts: BrowserActionOptions = {}
): BrowserActionLog {
  const log: BrowserActionLog = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: opts.taskId,
    action,
    label,
    status: "running",
    createdAt: Date.now(),
  };
  rec.snapshot.logs = [log, ...rec.snapshot.logs].slice(0, 30);
  return log;
}

function finishLog(log: BrowserActionLog, error?: string) {
  log.status = error ? "error" : "done";
  log.error = error;
  log.completedAt = Date.now();
}

function pushStep(
  rec: BrowserRecord,
  log: BrowserActionLog,
  snapshot: BrowserSnapshot
) {
  const step: BrowserStepSnapshot = {
    id: log.id,
    taskId: log.taskId,
    action: log.action,
    label: log.label,
    status: log.status === "error" ? "error" : "done",
    url: snapshot.url,
    title: snapshot.title,
    screenshotDataUrl: snapshot.screenshotDataUrl,
    pointer: snapshot.pointer,
    createdAt: log.completedAt ?? Date.now(),
    error: log.error,
  };
  rec.snapshot.steps = [step, ...rec.snapshot.steps].slice(0, 50);
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "Playwright runtime is not installed. Run `npm install playwright` and `npx playwright install chromium`."
    );
  }
}

async function ensurePage(agentId: string): Promise<{ rec: BrowserRecord; page: Page }> {
  const rec = getRecord(agentId);
  if (rec.page && !rec.page.isClosed()) return { rec, page: rec.page };

  rec.snapshot.status = "launching";
  rec.snapshot.error = null;
  const pw = await loadPlaywright();
  rec.browser = await pw.chromium.launch({ headless: true });
  rec.context = await rec.browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  rec.page = await rec.context.newPage();
  rec.page.setDefaultTimeout(10_000);
  rec.snapshot.status = "ready";
  return { rec, page: rec.page };
}

async function refreshSnapshot(rec: BrowserRecord, page: Page | null) {
  if (!page || page.isClosed()) {
    rec.snapshot = {
      ...rec.snapshot,
      status: "closed",
      updatedAt: Date.now(),
      screenshotDataUrl: null,
    };
    return rec.snapshot;
  }

  const [title, screenshot] = await Promise.all([
    page.title().catch(() => null),
    page.screenshot({ type: "png", fullPage: false }).catch(() => null),
  ]);
  rec.snapshot = {
    ...rec.snapshot,
    status: "ready",
    url: page.url() || rec.snapshot.url,
    title,
    screenshotDataUrl: screenshot
      ? `data:image/png;base64,${screenshot.toString("base64")}`
      : rec.snapshot.screenshotDataUrl,
    updatedAt: Date.now(),
    error: null,
  };
  return rec.snapshot;
}

async function runAction<T>(
  agentId: string,
  action: string,
  label: string,
  fn: (page: Page, rec: BrowserRecord) => Promise<T>,
  opts: BrowserActionOptions = {}
): Promise<{ result: T; snapshot: BrowserSnapshot }> {
  const { rec, page } = await ensurePage(agentId);
  const log = pushLog(rec, action, label, opts);
  rec.snapshot.status = "busy";
  rec.snapshot.error = null;
  try {
    const result = await fn(page, rec);
    finishLog(log);
    const snapshot = await refreshSnapshot(rec, page);
    pushStep(rec, log, snapshot);
    return { result, snapshot };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishLog(log, message);
    rec.snapshot.status = "error";
    rec.snapshot.error = message;
    rec.snapshot.updatedAt = Date.now();
    pushStep(rec, log, rec.snapshot);
    throw err;
  }
}

function targetLocator(page: Page, selector: string): Locator {
  return page.locator(selector).first();
}

async function pointerFromSelector(
  page: Page,
  selector: string,
  action: string,
  label: string
): Promise<BrowserPointerState | null> {
  const box = await targetLocator(page, selector).boundingBox().catch(() => null);
  const viewport = page.viewportSize();
  if (!box || !viewport) return null;
  return {
    x: clamp01((box.x + box.width / 2) / viewport.width),
    y: clamp01((box.y + box.height / 2) / viewport.height),
    action,
    label,
    updatedAt: Date.now(),
  };
}

async function pointerFromLocator(
  page: Page,
  locator: Locator,
  action: string,
  label: string
): Promise<BrowserPointerState | null> {
  const box = await locator.boundingBox().catch(() => null);
  const viewport = page.viewportSize();
  if (!box || !viewport) return null;
  return {
    x: clamp01((box.x + box.width / 2) / viewport.width),
    y: clamp01((box.y + box.height / 2) / viewport.height),
    action,
    label,
    updatedAt: Date.now(),
  };
}

function pointerFromPoint(
  page: Page,
  x: number,
  y: number,
  action: string,
  label: string
): BrowserPointerState | null {
  const viewport = page.viewportSize();
  if (!viewport) return null;
  return {
    x: clamp01(x / viewport.width),
    y: clamp01(y / viewport.height),
    action,
    label,
    updatedAt: Date.now(),
  };
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

export function getBrowserSnapshot(agentId: string): BrowserSnapshot {
  const rec = reg.browsers.get(agentId);
  return rec?.snapshot ?? { ...EMPTY_BROWSER_SNAPSHOT, logs: [], steps: [] };
}

export function updateBrowserTask(
  agentId: string,
  task: BrowserTaskState | null
): BrowserSnapshot {
  const rec = getRecord(agentId);
  rec.snapshot = {
    ...rec.snapshot,
    task,
    updatedAt: Date.now(),
  };
  return rec.snapshot;
}

export async function browserRefresh(agentId: string): Promise<BrowserSnapshot> {
  const rec = reg.browsers.get(agentId);
  if (!rec?.page || rec.page.isClosed()) {
    return rec?.snapshot ?? { ...EMPTY_BROWSER_SNAPSHOT, logs: [], steps: [] };
  }
  return refreshSnapshot(rec, rec.page);
}

export async function browserRecordTaskNote(
  agentId: string,
  input: {
    taskId: string;
    action: string;
    label: string;
    error?: string;
  }
): Promise<BrowserSnapshot> {
  const rec = getRecord(agentId);
  const log = pushLog(rec, input.action, input.label, {
    taskId: input.taskId,
  });
  finishLog(log, input.error);
  const snapshot =
    rec.page && !rec.page.isClosed()
      ? await refreshSnapshot(rec, rec.page)
      : {
          ...rec.snapshot,
          updatedAt: Date.now(),
        };
  pushStep(rec, log, snapshot);
  return rec.snapshot;
}

export async function browserOpen(
  agentId: string,
  url: string,
  opts: BrowserActionOptions = {}
) {
  const normalized = await assertBrowserSiteAllowed(url);
  return runAction(agentId, "open", normalized, async (page, rec) => {
    rec.snapshot.pointer = null;
    await page.goto(normalized, { waitUntil: "domcontentloaded" });
    return { url: page.url() };
  }, opts);
}

export async function browserScreenshot(agentId: string) {
  return runAction(agentId, "screenshot", "capture viewport", async (page) => {
    return { url: page.url() };
  });
}

export async function browserClick(
  agentId: string,
  input: { selector?: string; x?: number; y?: number }
) {
  return runAction(
    agentId,
    "click",
    input.selector ?? `${input.x},${input.y}`,
    async (page, rec) => {
      if (input.selector) {
        const label = input.selector;
        const pointer = await pointerFromSelector(
          page,
          input.selector,
          "click",
          label
        );
        await targetLocator(page, input.selector).click();
        if (pointer) rec.snapshot.pointer = pointer;
      } else if (typeof input.x === "number" && typeof input.y === "number") {
        const label = `${input.x},${input.y}`;
        rec.snapshot.pointer = pointerFromPoint(
          page,
          input.x,
          input.y,
          "click",
          label
        );
        await page.mouse.click(input.x, input.y);
      } else {
        throw new Error("selector or x/y required");
      }
      return { url: page.url() };
    }
  );
}

export async function browserClickText(
  agentId: string,
  input: { text: string; exact?: boolean },
  opts: BrowserActionOptions = {}
) {
  return runAction(agentId, "click_text", input.text, async (page, rec) => {
    const locator = page.getByText(input.text, { exact: !!input.exact }).first();
    const pointer = await pointerFromLocator(page, locator, "click", input.text);
    await locator.click();
    if (pointer) rec.snapshot.pointer = pointer;
    return { url: page.url() };
  }, opts);
}

async function firstVisibleEditable(page: Page): Promise<Locator> {
  const locator = page
    .locator(
      [
        "input:not([type=hidden]):not([disabled])",
        "textarea:not([disabled])",
        "[contenteditable='true']",
        "[role='textbox']",
        "[role='searchbox']",
      ].join(", ")
    )
    .first();
  await locator.waitFor({ state: "visible" });
  return locator;
}

export async function browserFill(
  agentId: string,
  input: { text: string; selector?: string; pressEnter?: boolean },
  opts: BrowserActionOptions = {}
) {
  return runAction(
    agentId,
    "fill",
    input.selector ?? "first editable",
    async (page, rec) => {
      const locator = input.selector
        ? targetLocator(page, input.selector)
        : await firstVisibleEditable(page);
      const pointer = await pointerFromLocator(
        page,
        locator,
        "type",
        input.selector ?? "first editable"
      );
      await locator.fill(input.text);
      if (pointer) rec.snapshot.pointer = pointer;
      if (input.pressEnter) await page.keyboard.press("Enter");
      return { url: page.url() };
    },
    opts
  );
}

export async function browserType(
  agentId: string,
  input: { text: string; selector?: string; pressEnter?: boolean }
) {
  return runAction(agentId, "type", input.selector ?? "keyboard", async (page, rec) => {
    if (input.selector) {
      const pointer = await pointerFromSelector(
        page,
        input.selector,
        "type",
        input.selector
      );
      await targetLocator(page, input.selector).fill(input.text);
      if (pointer) rec.snapshot.pointer = pointer;
    } else {
      await page.keyboard.type(input.text);
    }
    if (input.pressEnter) await page.keyboard.press("Enter");
    return { url: page.url() };
  });
}

export async function browserSearch(
  agentId: string,
  input: { query: string; engine?: "baidu" | "google" | "bing" },
  opts: BrowserActionOptions = {}
) {
  const engine = input.engine ?? "baidu";
  const q = encodeURIComponent(input.query);
  const url =
    engine === "google"
      ? `https://www.google.com/search?q=${q}`
      : engine === "bing"
        ? `https://www.bing.com/search?q=${q}`
        : `https://www.baidu.com/s?wd=${q}`;
  return runAction(agentId, "search", `${engine}: ${input.query}`, async (page, rec) => {
    rec.snapshot.pointer = null;
    await assertBrowserSiteAllowed(url);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return { url: page.url(), engine, query: input.query };
  }, opts);
}

export async function browserWait(
  agentId: string,
  input: { selector?: string; ms?: number; text?: string }
) {
  return runAction(agentId, "wait", input.selector ?? input.text ?? `${input.ms ?? 1000}ms`, async (page) => {
    if (input.selector) await targetLocator(page, input.selector).waitFor();
    else if (input.text) await page.getByText(input.text).first().waitFor();
    else await page.waitForTimeout(Math.min(Math.max(input.ms ?? 1000, 100), 30_000));
    return { url: page.url() };
  });
}

export async function browserExtract(
  agentId: string,
  opts: BrowserActionOptions = {}
) {
  return runAction(agentId, "extract", "page summary", async (page) => {
    const result = await page.evaluate(() => {
      const visibleText = (document.body?.innerText || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 4000);
      const links = Array.from(document.querySelectorAll("a"))
        .slice(0, 30)
        .map((a) => ({
          text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
          href: (a as HTMLAnchorElement).href,
        }))
        .filter((x) => x.text || x.href);
      const inputs = Array.from(
        document.querySelectorAll("input, textarea, select")
      )
        .slice(0, 30)
        .map((el) => {
          const input = el as HTMLInputElement;
          const id = input.id;
          const label =
            (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) ||
            input.getAttribute("aria-label") ||
            input.name ||
            "";
          return {
            label: label.replace(/\s+/g, " ").trim().slice(0, 120),
            type: input.type || el.tagName.toLowerCase(),
            name: input.name || "",
            placeholder: input.placeholder || "",
          };
        });
      const selectorFor = (el: Element, fallback: string) => {
        const id = el.getAttribute("id");
        if (id) return `#${CSS.escape(id)}`;
        const name = el.getAttribute("name");
        if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        return fallback;
      };
      const actions = [
        ...Array.from(document.querySelectorAll("a"))
          .slice(0, 20)
          .map((el, index) => ({
            kind: "link" as const,
            text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
            selectorHint: selectorFor(el, `a:nth-of-type(${index + 1})`),
          })),
        ...Array.from(document.querySelectorAll("button, [role='button']"))
          .slice(0, 20)
          .map((el, index) => ({
            kind: "button" as const,
            text:
              (el.textContent || el.getAttribute("aria-label") || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 120),
            selectorHint: selectorFor(el, `button:nth-of-type(${index + 1})`),
          })),
        ...Array.from(document.querySelectorAll("input, textarea, [role='textbox'], [role='searchbox']"))
          .slice(0, 20)
          .map((el, index) => ({
            kind: "input" as const,
            text:
              (
                el.getAttribute("aria-label") ||
                el.getAttribute("placeholder") ||
                el.getAttribute("name") ||
                ""
              )
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 120),
            selectorHint: selectorFor(el, `input:nth-of-type(${index + 1})`),
          })),
      ].filter((x) => x.text || x.selectorHint);
      return {
        url: location.href,
        title: document.title,
        text: visibleText,
        links,
        inputs,
        actions,
      };
    });
    return result as BrowserExtractResult;
  }, opts);
}

export async function browserVerify(
  agentId: string,
  input: { expectation: string; selector?: string; text?: string },
  opts: BrowserActionOptions = {}
) {
  return runAction(agentId, "verify", input.expectation, async (page) => {
    const title = await page.title().catch(() => null);
    const url = page.url() || null;
    let passed = false;
    let evidence = "";
    if (input.selector) {
      const count = await targetLocator(page, input.selector).count();
      passed = count > 0;
      evidence = passed
        ? `Selector is visible: ${input.selector}`
        : `Selector was not found: ${input.selector}`;
    } else if (input.text) {
      const count = await page.getByText(input.text).count();
      passed = count > 0;
      evidence = passed
        ? `Text is visible: ${input.text}`
        : `Text was not found: ${input.text}`;
    } else if (input.expectation.startsWith("page opened at ")) {
      const expectedUrl = input.expectation.slice("page opened at ".length);
      passed = !!url && url.startsWith(expectedUrl);
      evidence = passed
        ? `Current URL matches expected page: ${url}`
        : `Current URL ${url ?? "(none)"} did not match ${expectedUrl}`;
    } else {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      passed = bodyText
        .toLowerCase()
        .includes(input.expectation.toLowerCase().slice(0, 80));
      evidence = passed
        ? "Expectation text appears in the page body."
        : "Expectation text was not found in the page body.";
    }
    return {
      passed,
      expectation: input.expectation,
      evidence,
      url,
      title,
    } satisfies BrowserVerifyResult;
  }, opts);
}

export async function browserClose(agentId: string): Promise<BrowserSnapshot> {
  const rec = reg.browsers.get(agentId);
  if (!rec) return { ...EMPTY_BROWSER_SNAPSHOT, logs: [], steps: [] };
  const log = pushLog(rec, "close", "close browser");
  try {
    await rec.context?.close().catch(() => {});
    await rec.browser?.close().catch(() => {});
    finishLog(log);
  } catch (err) {
    finishLog(log, err instanceof Error ? err.message : String(err));
  }
  rec.browser = null;
  rec.context = null;
  rec.page = null;
  rec.snapshot = {
    ...rec.snapshot,
    status: "closed",
    updatedAt: Date.now(),
    screenshotDataUrl: null,
  };
  return rec.snapshot;
}

export async function disposeBrowser(agentId: string) {
  await browserClose(agentId).catch(() => {});
  reg.browsers.delete(agentId);
}

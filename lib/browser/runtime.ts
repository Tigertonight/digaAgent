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
  label: string
): BrowserActionLog {
  const log: BrowserActionLog = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
  fn: (page: Page, rec: BrowserRecord) => Promise<T>
): Promise<{ result: T; snapshot: BrowserSnapshot }> {
  const { rec, page } = await ensurePage(agentId);
  const log = pushLog(rec, action, label);
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

export async function browserRefresh(agentId: string): Promise<BrowserSnapshot> {
  const rec = reg.browsers.get(agentId);
  if (!rec?.page || rec.page.isClosed()) {
    return rec?.snapshot ?? { ...EMPTY_BROWSER_SNAPSHOT, logs: [], steps: [] };
  }
  return refreshSnapshot(rec, rec.page);
}

export async function browserOpen(agentId: string, url: string) {
  const normalized = await assertBrowserSiteAllowed(url);
  return runAction(agentId, "open", normalized, async (page, rec) => {
    rec.snapshot.pointer = null;
    await page.goto(normalized, { waitUntil: "domcontentloaded" });
    return { url: page.url() };
  });
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

export async function browserExtract(agentId: string) {
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
      return {
        url: location.href,
        title: document.title,
        text: visibleText,
        links,
        inputs,
      };
    });
    return result as BrowserExtractResult;
  });
}

export async function browserVerify(
  agentId: string,
  input: { expectation: string; selector?: string; text?: string }
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
  });
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

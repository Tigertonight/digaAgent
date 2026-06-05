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
  type BrowserAnnotation,
  type BrowserExtractResult,
  type BrowserPointerState,
  type BrowserSnapshot,
  type BrowserStepSnapshot,
  type BrowserTaskState,
  type BrowserVerifyResult,
} from "./types";
import { assertBrowserSiteAllowed } from "./policy";

type PlaywrightModule = typeof import("playwright");

interface ScreencastFrame {
  /** data:image/jpeg;base64,... */
  dataUrl: string;
  /** 帧对应页面视口宽（CSS px），用于前端坐标换算 */
  width: number;
  height: number;
  seq: number;
  updatedAt: number;
}

interface ScreencastState {
  /** Playwright CDP session（chromium 专用） */
  cdp: import("playwright").CDPSession | null;
  latest: ScreencastFrame | null;
  seq: number;
  /** 最近一次有客户端拉帧的时间，用于空闲自动停推 */
  lastPullAt: number;
}

interface BrowserRecord {
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  snapshot: BrowserSnapshot;
  screencast: ScreencastState;
  /** 启动锁：避免并发 ensurePage 同时 launch 出多个浏览器窗口 */
  launching: Promise<Page> | null;
  inAppHost: InAppBrowserHostState | null;
}

interface BrowserActionOptions {
  taskId?: string;
}

interface GlobalBrowserRegistry {
  browsers: Map<string, BrowserRecord>;
}

export type InAppBrowserCommandAction =
  | "open"
  | "screenshot"
  | "refresh"
  | "click"
  | "click_text"
  | "fill"
  | "type"
  | "wait"
  | "wait_for"
  | "extract"
  | "verify"
  | "input"
  | "close";

export interface InAppBrowserCommand {
  id: string;
  action: InAppBrowserCommandAction;
  label: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export type InAppBrowserCommandResult = Record<string, unknown> & {
  url?: string | null;
  title?: string | null;
  screenshotDataUrl?: string | null;
  pointer?: BrowserPointerState | null;
  error?: string;
};

interface InAppBrowserWaiter {
  resolve: (result: InAppBrowserCommandResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface InAppBrowserHostState {
  connectedAt: number;
  lastSeenAt: number;
  nextSeq: number;
  pending: InAppBrowserCommand[];
  waiters: Map<string, InAppBrowserWaiter>;
}

const g = globalThis as unknown as {
  __miniPiBrowser?: GlobalBrowserRegistry;
  __miniPiBrowserExitHook?: boolean;
};
if (!g.__miniPiBrowser) {
  g.__miniPiBrowser = { browsers: new Map() };
}
const reg = g.__miniPiBrowser;

// 进程退出时兜底关闭所有浏览器，避免 server 被杀后留下孤儿 Chromium 窗口。
// 只注册一次（globalThis 标记），防止热重载重复挂钩子。
if (!g.__miniPiBrowserExitHook) {
  g.__miniPiBrowserExitHook = true;
  const killAllSync = () => {
    for (const rec of reg.browsers.values()) {
      // 同步阶段只能 best-effort：触发 close（不 await），让子进程收到信号
      try {
        rec.browser?.close().catch(() => {});
      } catch {
        /* ignore */
      }
    }
  };
  for (const sig of ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const) {
    try {
      process.once(sig, killAllSync);
    } catch {
      /* ignore */
    }
  }
}

function emptyRecord(): BrowserRecord {
  return {
    browser: null,
    context: null,
    page: null,
    snapshot: { ...EMPTY_BROWSER_SNAPSHOT, logs: [], steps: [] },
    screencast: { cdp: null, latest: null, seq: 0, lastPullAt: 0 },
    launching: null,
    inAppHost: null,
  };
}

function getRecord(browserId: string): BrowserRecord {
  let rec = reg.browsers.get(browserId);
  if (!rec) {
    rec = emptyRecord();
    reg.browsers.set(browserId, rec);
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

/** 阶段 C：从一次 action 的结果里派生 step 的验收证据（passed / extractedText）。 */
interface StepEvidence {
  passed?: boolean;
  extractedText?: string;
}

function pushStep(
  rec: BrowserRecord,
  log: BrowserActionLog,
  snapshot: BrowserSnapshot,
  evidence?: StepEvidence
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
    ...(evidence?.passed !== undefined ? { passed: evidence.passed } : {}),
    ...(evidence?.extractedText !== undefined
      ? { extractedText: evidence.extractedText }
      : {}),
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

/**
 * 方案 A：默认以 headed（有头）模式启动浏览器，弹出一个真实窗口。
 * 这样：
 *   - agent 用 Playwright 控制它自动跑任务；
 *   - 用户随时可直接在这个真实窗口上操作（过验证码、点按钮），
 *     因为是同一个浏览器实例，agent 后续接着用的就是你操作完的页面。
 * 服务器/CI 等无显示环境可设 MINI_PI_BROWSER_HEADLESS=1 切回无头。
 */
function isHeadless(): boolean {
  return process.env.MINI_PI_BROWSER_HEADLESS === "1";
}

function allowPlaywrightFallback(): boolean {
  return process.env.MINI_PI_BROWSER_PLAYWRIGHT_FALLBACK === "1";
}

async function ensurePage(browserId: string): Promise<{ rec: BrowserRecord; page: Page }> {
  const rec = getRecord(browserId);
  if (rec.page && !rec.page.isClosed()) return { rec, page: rec.page };

  if (!allowPlaywrightFallback()) {
    throw new Error(
      "In-app browser host is not connected. Open the BrowserPanel to let the agent control the in-app page, or set MINI_PI_BROWSER_PLAYWRIGHT_FALLBACK=1 to allow launching Chrome for Testing."
    );
  }

  // 启动锁：若已有一个 launch 在进行中，复用它，避免并发请求
  // （screencast_start / open / agent task 同时触发）各自 launch 出多个浏览器窗口。
  if (rec.launching) {
    const page = await rec.launching;
    return { rec, page };
  }

  rec.launching = (async () => {
    rec.snapshot.status = "launching";
    rec.snapshot.error = null;
    const pw = await loadPlaywright();
    const headless = isHeadless();
    const browser = await pw.chromium.launch({
      headless,
      args: headless
        ? []
        : ["--window-size=1280,860", "--window-position=120,80"],
    });
    rec.browser = browser;

    // 稳定性：用户手动关掉浏览器窗口 / 浏览器崩溃时，自动清理 record 状态，
    // 避免后续操作打到一个已死的 page 报错。
    browser.on("disconnected", () => {
      rec.browser = null;
      rec.context = null;
      rec.page = null;
      rec.launching = null;
      rec.screencast.cdp = null;
      rec.snapshot = {
        ...rec.snapshot,
        status: "closed",
        updatedAt: Date.now(),
        screenshotDataUrl: null,
      };
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    rec.context = context;
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    // 页面被关时同步清理（headed 下用户可能只关标签页）
    page.on("close", () => {
      if (rec.page === page) {
        rec.page = null;
        rec.snapshot = {
          ...rec.snapshot,
          status: "closed",
          updatedAt: Date.now(),
        };
      }
    });
    rec.page = page;
    rec.snapshot.status = "ready";
    if (!headless) {
      await page.bringToFront().catch(() => {});
    }
    return page;
  })();

  try {
    const page = await rec.launching;
    return { rec, page };
  } finally {
    rec.launching = null;
  }
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
  browserId: string,
  action: string,
  label: string,
  fn: (page: Page, rec: BrowserRecord) => Promise<T>,
  opts: BrowserActionOptions = {},
  /**
   * 阶段 C：从本次 action 的结果派生 step 的验收证据（passed / extractedText）。
   * 仅成功路径会用到（失败路径的 step 走 error 状态，不带 passed=true）。
   */
  evidenceOf?: (result: T) => StepEvidence
): Promise<{ result: T; snapshot: BrowserSnapshot }> {
  const { rec, page } = await ensurePage(browserId);
  const log = pushLog(rec, action, label, opts);
  rec.snapshot.status = "busy";
  rec.snapshot.error = null;
  try {
    const result = await fn(page, rec);
    finishLog(log);
    const snapshot = await refreshSnapshot(rec, page);
    pushStep(rec, log, snapshot, evidenceOf?.(result));
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

const IN_APP_HOST_STALE_MS = 10_000;
const IN_APP_COMMAND_TIMEOUT_MS = 45_000;

function isInAppHostAlive(rec: BrowserRecord): boolean {
  return !!rec.inAppHost && Date.now() - rec.inAppHost.lastSeenAt < IN_APP_HOST_STALE_MS;
}

function ensureInAppHost(rec: BrowserRecord): InAppBrowserHostState {
  if (!rec.inAppHost) {
    rec.inAppHost = {
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      nextSeq: 1,
      pending: [],
      waiters: new Map(),
    };
  }
  rec.inAppHost.lastSeenAt = Date.now();
  return rec.inAppHost;
}

export function registerInAppBrowserHost(browserId: string): BrowserSnapshot {
  const rec = getRecord(browserId);
  ensureInAppHost(rec);
  rec.snapshot = {
    ...rec.snapshot,
    status: rec.snapshot.status === "idle" || rec.snapshot.status === "closed"
      ? "ready"
      : rec.snapshot.status,
    error: null,
    updatedAt: Date.now(),
  };
  return rec.snapshot;
}

export function pollInAppBrowserCommand(
  browserId: string
): { command: InAppBrowserCommand | null; snapshot: BrowserSnapshot } {
  const rec = getRecord(browserId);
  const host = ensureInAppHost(rec);
  return {
    command: host.pending.shift() ?? null,
    snapshot: rec.snapshot,
  };
}

export function completeInAppBrowserCommand(
  browserId: string,
  commandId: string,
  result: InAppBrowserCommandResult
): BrowserSnapshot {
  const rec = getRecord(browserId);
  const host = ensureInAppHost(rec);
  const waiter = host.waiters.get(commandId);
  if (waiter) {
    clearTimeout(waiter.timeout);
    host.waiters.delete(commandId);
    if (result.error) waiter.reject(new Error(result.error));
    else waiter.resolve(result);
  }
  if (result.url !== undefined || result.title !== undefined) {
    rec.snapshot = {
      ...rec.snapshot,
      url: result.url !== undefined ? result.url : rec.snapshot.url,
      title: result.title !== undefined ? result.title : rec.snapshot.title,
      screenshotDataUrl:
        result.screenshotDataUrl !== undefined
          ? result.screenshotDataUrl
          : rec.snapshot.screenshotDataUrl,
      pointer:
        result.pointer !== undefined ? result.pointer : rec.snapshot.pointer,
      status: result.error ? "error" : "ready",
      error: result.error ?? null,
      updatedAt: Date.now(),
    };
  }
  return rec.snapshot;
}

function dispatchInAppBrowserCommand(
  browserId: string,
  action: InAppBrowserCommandAction,
  label: string,
  payload: Record<string, unknown>
): Promise<InAppBrowserCommandResult> {
  const rec = getRecord(browserId);
  if (!isInAppHostAlive(rec)) {
    return Promise.reject(new Error("in-app browser host is not connected"));
  }
  const host = ensureInAppHost(rec);
  const id = `iab_${Date.now().toString(36)}_${host.nextSeq++}`;
  const command: InAppBrowserCommand = {
    id,
    action,
    label,
    payload,
    createdAt: Date.now(),
  };
  host.pending.push(command);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      host.waiters.delete(id);
      reject(new Error(`in-app browser command timed out: ${action}`));
    }, IN_APP_COMMAND_TIMEOUT_MS);
    host.waiters.set(id, { resolve, reject, timeout });
  });
}

function applyInAppSnapshot(
  rec: BrowserRecord,
  result: InAppBrowserCommandResult
): BrowserSnapshot {
  rec.snapshot = {
    ...rec.snapshot,
    status: "ready",
    error: null,
    url:
      typeof result.url === "string" || result.url === null
        ? result.url
        : rec.snapshot.url,
    title:
      typeof result.title === "string" || result.title === null
        ? result.title
        : rec.snapshot.title,
    screenshotDataUrl:
      typeof result.screenshotDataUrl === "string" || result.screenshotDataUrl === null
        ? result.screenshotDataUrl
        : rec.snapshot.screenshotDataUrl,
    pointer:
      result.pointer !== undefined
        ? (result.pointer as BrowserPointerState | null)
        : rec.snapshot.pointer,
    updatedAt: Date.now(),
  };
  return rec.snapshot;
}

async function runInAppAction<T extends InAppBrowserCommandResult>(
  browserId: string,
  action: InAppBrowserCommandAction,
  label: string,
  payload: Record<string, unknown>,
  opts: BrowserActionOptions = {},
  evidenceOf?: (result: T) => StepEvidence
): Promise<{ result: T; snapshot: BrowserSnapshot }> {
  const rec = getRecord(browserId);
  const log = pushLog(rec, action, label, opts);
  rec.snapshot.status = "busy";
  rec.snapshot.error = null;
  try {
    const result = (await dispatchInAppBrowserCommand(
      browserId,
      action,
      label,
      payload
    )) as T;
    finishLog(log);
    const snapshot = applyInAppSnapshot(rec, result);
    pushStep(rec, log, snapshot, evidenceOf?.(result));
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

export function getBrowserSnapshot(browserId: string): BrowserSnapshot {
  const rec = reg.browsers.get(browserId);
  return rec?.snapshot ?? { ...EMPTY_BROWSER_SNAPSHOT, logs: [], steps: [] };
}

/** 当前是否无头（前端用来决定"接管"按钮文案与行为） */
export function isBrowserHeadless(): boolean {
  return isHeadless();
}

/**
 * 方案 A：把真实浏览器窗口带到前台，方便用户直接接管操作。
 * 无头模式下没有可见窗口，返回 false。
 */
export async function browserBringToFront(browserId: string): Promise<boolean> {
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) return true;
  if (isHeadless()) return false;
  const { page } = await ensurePage(browserId);
  await page.bringToFront().catch(() => {});
  return true;
}

export function updateBrowserTask(
  browserId: string,
  task: BrowserTaskState | null
): BrowserSnapshot {
  const rec = getRecord(browserId);
  rec.snapshot = {
    ...rec.snapshot,
    task,
    updatedAt: Date.now(),
  };
  return rec.snapshot;
}

export async function browserRefresh(browserId: string): Promise<BrowserSnapshot> {
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    const { snapshot } = await runInAppAction(
      browserId,
      "refresh",
      "refresh in-app browser state",
      {}
    );
    return snapshot;
  }
  if (!rec?.page || rec.page.isClosed()) {
    return rec?.snapshot ?? { ...EMPTY_BROWSER_SNAPSHOT, logs: [], steps: [] };
  }
  return refreshSnapshot(rec, rec.page);
}

export async function browserRecordTaskNote(
  browserId: string,
  input: {
    taskId: string;
    action: string;
    label: string;
    error?: string;
  }
): Promise<BrowserSnapshot> {
  const rec = getRecord(browserId);
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
  browserId: string,
  url: string,
  opts: BrowserActionOptions = {}
) {
  const normalized = await assertBrowserSiteAllowed(url);
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    return runInAppAction(
      browserId,
      "open",
      normalized,
      { url: normalized },
      opts
    );
  }
  return runAction(browserId, "open", normalized, async (page, rec) => {
    rec.snapshot.pointer = null;
    await page.goto(normalized, { waitUntil: "domcontentloaded" });
    return { url: page.url() };
  }, opts);
}

export async function browserScreenshot(browserId: string) {
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    return runInAppAction(browserId, "screenshot", "capture viewport", {});
  }
  return runAction(browserId, "screenshot", "capture viewport", async (page) => {
    return { url: page.url() };
  });
}

export async function browserClick(
  browserId: string,
  input: { selector?: string; x?: number; y?: number }
) {
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    return runInAppAction(browserId, "click", input.selector ?? `${input.x},${input.y}`, input);
  }
  return runAction(
    browserId,
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
  browserId: string,
  input: { text: string; exact?: boolean },
  opts: BrowserActionOptions = {}
) {
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    return runInAppAction(browserId, "click_text", input.text, input, opts);
  }
  return runAction(browserId, "click_text", input.text, async (page, rec) => {
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
  browserId: string,
  input: { text: string; selector?: string; pressEnter?: boolean },
  opts: BrowserActionOptions = {}
) {
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    return runInAppAction(
      browserId,
      "fill",
      input.selector ?? "first editable",
      input,
      opts
    );
  }
  return runAction(
    browserId,
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
  browserId: string,
  input: { text: string; selector?: string; pressEnter?: boolean }
) {
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    return runInAppAction(browserId, "type", input.selector ?? "keyboard", input);
  }
  return runAction(browserId, "type", input.selector ?? "keyboard", async (page, rec) => {
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
  browserId: string,
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
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    await assertBrowserSiteAllowed(url);
    return runInAppAction(
      browserId,
      "open",
      `${engine}: ${input.query}`,
      { url, engine, query: input.query },
      opts
    );
  }
  return runAction(browserId, "search", `${engine}: ${input.query}`, async (page, rec) => {
    rec.snapshot.pointer = null;
    await assertBrowserSiteAllowed(url);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // 搜索结果是异步渲染的：等结果容器出现再返回，否则 extract 抓到的全是顶部导航。
    const resultSelector =
      engine === "google"
        ? "#search, #rso"
        : engine === "bing"
          ? "#b_results"
          : "#content_left, #content_left .result, .result, .c-container";
    await page
      .waitForSelector(resultSelector, { timeout: 8000, state: "attached" })
      .catch(() => {});
    return { url: page.url(), engine, query: input.query };
  }, opts);
}

export async function browserWait(
  browserId: string,
  input: { selector?: string; ms?: number; text?: string }
) {
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    return runInAppAction(
      browserId,
      "wait",
      input.selector ?? input.text ?? `${input.ms ?? 1000}ms`,
      input
    );
  }
  return runAction(browserId, "wait", input.selector ?? input.text ?? `${input.ms ?? 1000}ms`, async (page) => {
    if (input.selector) await targetLocator(page, input.selector).waitFor();
    else if (input.text) await page.getByText(input.text).first().waitFor();
    else await page.waitForTimeout(Math.min(Math.max(input.ms ?? 1000, 100), 30_000));
    return { url: page.url() };
  });
}

/**
 * 语义化等待：等待某个「条件达成」，而非单纯 sleep。
 * 主要用于多步流程中判断「页面跳转/异步内容完成」：
 *   - url:      等待当前 URL 包含给定子串（页面跳转完成的关键判据）
 *   - selector: 等待某 CSS selector 出现
 *   - text:     等待某可见文本出现
 * 三者可任意组合，全部满足才算通过；超时则抛错（由 runAction 记成 error step）。
 */
export async function browserWaitFor(
  browserId: string,
  input: { url?: string; selector?: string; text?: string; timeoutMs?: number },
  opts: BrowserActionOptions = {}
) {
  const label =
    input.url
      ? `url~="${input.url}"`
      : input.selector
        ? input.selector
        : input.text
          ? `text~="${input.text}"`
          : "(no condition)";
  const timeout = Math.min(Math.max(input.timeoutMs ?? 10_000, 200), 60_000);
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    return runInAppAction(
      browserId,
      "wait_for",
      label,
      { ...input, timeoutMs: timeout },
      opts,
      () => ({ passed: true })
    );
  }
  return runAction(
    browserId,
    "wait_for",
    label,
    async (page) => {
      if (!input.url && !input.selector && !input.text) {
        throw new Error("wait_for requires at least one of url/selector/text");
      }
      if (input.url) {
        const target = input.url;
        await page.waitForFunction(
          (needle) => location.href.includes(needle),
          target,
          { timeout }
        );
      }
      if (input.selector) {
        await targetLocator(page, input.selector).waitFor({ timeout });
      }
      if (input.text) {
        await page.getByText(input.text).first().waitFor({ timeout });
      }
      return { url: page.url() };
    },
    opts,
    // 成功到达即视为一次通过的等待验收。
    () => ({ passed: true })
  );
}

export async function browserExtract(
  browserId: string,
  opts: BrowserActionOptions = {}
) {
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    return runInAppAction<BrowserExtractResult & InAppBrowserCommandResult>(
      browserId,
      "extract",
      "page summary",
      {},
      opts,
      (result) => ({ extractedText: result.text })
    );
  }
  return runAction(browserId, "extract", "page summary", async (page) => {
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
  }, opts, (result) => ({ extractedText: result.text }));
}

export async function browserVerify(
  browserId: string,
  input: { expectation: string; selector?: string; text?: string },
  opts: BrowserActionOptions = {}
) {
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    return runInAppAction<BrowserVerifyResult & InAppBrowserCommandResult>(
      browserId,
      "verify",
      input.expectation,
      input,
      opts,
      (result) => ({ passed: result.passed })
    );
  }
  return runAction(browserId, "verify", input.expectation, async (page) => {
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
  }, opts, (result) => ({ passed: result.passed }));
}

export async function browserClose(browserId: string): Promise<BrowserSnapshot> {
  const rec = reg.browsers.get(browserId);
  if (!rec) return { ...EMPTY_BROWSER_SNAPSHOT, logs: [], steps: [] };
  if (isInAppHostAlive(rec)) {
    const { snapshot } = await runInAppAction(
      browserId,
      "close",
      "close in-app browser",
      {}
    );
    rec.snapshot = {
      ...snapshot,
      status: "closed",
      url: null,
      title: null,
      screenshotDataUrl: null,
      updatedAt: Date.now(),
    };
    return rec.snapshot;
  }
  const log = pushLog(rec, "close", "close browser");

  // 若正有一次 launch 在途，先等它完成，否则 launch 收尾会留下一个新孤儿窗口。
  if (rec.launching) {
    await rec.launching.catch(() => {});
  }

  try {
    await stopScreencast(rec).catch(() => {});
    // browser.close() 会连带关闭其所有 context/page 及底层进程。
    // 加 5s 超时兜底，避免 close 卡死阻塞整个请求。
    const closeBrowser = rec.browser
      ? rec.browser.close().catch(() => {})
      : Promise.resolve();
    await Promise.race([
      closeBrowser,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    finishLog(log);
  } catch (err) {
    finishLog(log, err instanceof Error ? err.message : String(err));
  }
  rec.browser = null;
  rec.context = null;
  rec.page = null;
  rec.launching = null;
  rec.snapshot = {
    ...rec.snapshot,
    status: "closed",
    updatedAt: Date.now(),
    screenshotDataUrl: null,
  };
  return rec.snapshot;
}

export async function disposeBrowser(browserId: string) {
  await browserClose(browserId).catch(() => {});
  reg.browsers.delete(browserId);
}

/**
 * 兜底：关闭所有 agent 的浏览器实例。
 * 用于"全部关闭"入口，清理因异常残留的多余窗口。
 */
export async function closeAllBrowsers(): Promise<number> {
  const ids = [...reg.browsers.keys()];
  await Promise.all(ids.map((id) => browserClose(id).catch(() => {})));
  return ids.length;
}

// ===========================================================================
// 阶段 D：页面批注（持久化在 runtime，进 snapshot.annotations，随 SSE 同步）
// 批注独立于浏览器存活：即使页面跳转/截图刷新，批注仍保留，直到显式删除。
// ===========================================================================

function clampRect(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
}): { x: number; y: number; w: number; h: number } {
  const x = clamp01(rect.x);
  const y = clamp01(rect.y);
  // 宽高不能越界到画面外
  const w = Math.max(0, Math.min(rect.w, 1 - x));
  const h = Math.max(0, Math.min(rect.h, 1 - y));
  return { x, y, w, h };
}

/** 新增一条页面批注，返回更新后的 snapshot。 */
export function addBrowserAnnotation(
  browserId: string,
  input: {
    rect: { x: number; y: number; w: number; h: number };
    comment: string;
    url?: string | null;
    title?: string | null;
    screenshotDataUrl?: string | null;
  }
): { annotation: BrowserAnnotation; snapshot: BrowserSnapshot } {
  const rec = getRecord(browserId);
  const now = Date.now();
  const annotation: BrowserAnnotation = {
    id: `an_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    browserId,
    url: input.url ?? rec.snapshot.url,
    title: input.title ?? rec.snapshot.title,
    rect: clampRect(input.rect),
    comment: input.comment.trim(),
    // 优先用调用方传入的截图（批注时刻所见），否则退回当前 snapshot 截图
    screenshotDataUrl:
      input.screenshotDataUrl ?? rec.snapshot.screenshotDataUrl ?? null,
    createdAt: now,
    updatedAt: now,
    status: "open",
  };
  rec.snapshot = {
    ...rec.snapshot,
    annotations: [annotation, ...(rec.snapshot.annotations ?? [])].slice(0, 50),
    updatedAt: now,
  };
  return { annotation, snapshot: rec.snapshot };
}

/** 删除一条批注，返回更新后的 snapshot。 */
export function removeBrowserAnnotation(
  browserId: string,
  annotationId: string
): BrowserSnapshot {
  const rec = reg.browsers.get(browserId);
  if (!rec) return getBrowserSnapshot(browserId);
  rec.snapshot = {
    ...rec.snapshot,
    annotations: (rec.snapshot.annotations ?? []).filter(
      (a) => a.id !== annotationId
    ),
    updatedAt: Date.now(),
  };
  return rec.snapshot;
}

/** 标记一条批注为已处理 / 待处理。 */
export function setBrowserAnnotationStatus(
  browserId: string,
  annotationId: string,
  status: "open" | "resolved"
): BrowserSnapshot {
  const rec = reg.browsers.get(browserId);
  if (!rec) return getBrowserSnapshot(browserId);
  const now = Date.now();
  rec.snapshot = {
    ...rec.snapshot,
    annotations: (rec.snapshot.annotations ?? []).map((a) =>
      a.id === annotationId
        ? {
            ...a,
            status,
            updatedAt: now,
            resolvedAt: status === "resolved" ? now : undefined,
          }
        : a
    ),
    updatedAt: now,
  };
  return rec.snapshot;
}

/** 清空全部批注，返回更新后的 snapshot。 */
export function clearBrowserAnnotations(browserId: string): BrowserSnapshot {
  const rec = reg.browsers.get(browserId);
  if (!rec) return getBrowserSnapshot(browserId);
  rec.snapshot = {
    ...rec.snapshot,
    annotations: [],
    updatedAt: Date.now(),
  };
  return rec.snapshot;
}

/** 读取全部批注（供 agent 工具层消费）。 */
export function listBrowserAnnotations(browserId: string): BrowserAnnotation[] {
  return reg.browsers.get(browserId)?.snapshot.annotations ?? [];
}

// ===========================================================================
// 方案 Y：实时画面（CDP screencast）+ 接管（输入回放）
// 让前端面板看到的、并能直接操作的，就是 agent 正在用的同一个 Page。
// ===========================================================================

const SCREENCAST_IDLE_STOP_MS = 8000;

/**
 * 开启（或确保已开启）CDP screencast，并返回当前最新帧。
 * 帧通过 Page.screencastFrame 事件持续推来，缓存在 rec.screencast.latest。
 * 前端轮询 getScreencastFrame 即可拿到最新画面。
 */
export async function startScreencast(
  browserId: string
): Promise<ScreencastFrame | null> {
  // 重要：screencast 只负责"对已存在的浏览器开启推流"，绝不主动创建/复活浏览器。
  // 否则前端预览轮询会在用户关闭浏览器后立刻把它重新拉起（"关不掉"）。
  const rec = reg.browsers.get(browserId);
  if (!rec || !rec.page || rec.page.isClosed()) return null;
  const page = rec.page;
  rec.screencast.lastPullAt = Date.now();

  if (rec.screencast.cdp) {
    return rec.screencast.latest;
  }

  const context = rec.context;
  if (!context) return null;

  const cdp = await context.newCDPSession(page);
  rec.screencast.cdp = cdp;

  cdp.on("Page.screencastFrame", async (params) => {
    const p = params as {
      data: string;
      sessionId: number;
      metadata?: { deviceWidth?: number; deviceHeight?: number };
    };
    try {
      // 必须 ack，否则 CDP 不再推下一帧
      await cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId });
    } catch {
      /* session 可能已关 */
    }
    const viewport = page.viewportSize();
    rec.screencast.seq += 1;
    rec.screencast.latest = {
      dataUrl: `data:image/jpeg;base64,${p.data}`,
      width: p.metadata?.deviceWidth || viewport?.width || 1280,
      height: p.metadata?.deviceHeight || viewport?.height || 800,
      seq: rec.screencast.seq,
      updatedAt: Date.now(),
    };
    // 空闲（前端长时间没拉帧）自动停推，省 CPU
    if (Date.now() - rec.screencast.lastPullAt > SCREENCAST_IDLE_STOP_MS) {
      void stopScreencast(rec).catch(() => {});
    }
  });

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 1,
  });

  return rec.screencast.latest;
}

async function stopScreencast(rec: BrowserRecord): Promise<void> {
  const cdp = rec.screencast.cdp;
  rec.screencast.cdp = null;
  if (!cdp) return;
  try {
    await cdp.send("Page.stopScreencast");
  } catch {
    /* ignore */
  }
  try {
    await cdp.detach();
  } catch {
    /* ignore */
  }
}

/**
 * 前端轮询入口：返回最新帧。每次调用都刷新 lastPullAt，
 * 顺便确保 screencast 处于开启状态（页面跳转后 CDP session 仍有效）。
 */
export async function getScreencastFrame(
  browserId: string
): Promise<ScreencastFrame | null> {
  const rec = reg.browsers.get(browserId);
  if (!rec || !rec.page || rec.page.isClosed()) return null;
  rec.screencast.lastPullAt = Date.now();
  if (!rec.screencast.cdp) {
    // 自动恢复推流（之前因空闲被停）
    return startScreencast(browserId).catch(() => null);
  }
  return rec.screencast.latest;
}

export type BrowserInputAction =
  | { kind: "move"; x: number; y: number }
  | { kind: "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "dblclick"; x: number; y: number }
  | { kind: "mousedown"; x: number; y: number }
  | { kind: "mouseup"; x: number; y: number }
  | { kind: "scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; key: string }
  | { kind: "text"; text: string };

/**
 * 接管输入回放：把前端在画面上的操作回放到 agent 正在用的同一个 page。
 * 坐标统一用归一化 [0,1]，后端按当前视口换算成 CSS px，规避前后端分辨率差异。
 */
// 输入回放串行队列：保证 scroll/click 等动作按到达顺序逐个执行，
// 避免并发回放导致滚动量错乱、画面回跳（抖动）。
const inputChains = new Map<string, Promise<unknown>>();

export function browserInput(
  browserId: string,
  action: BrowserInputAction
): Promise<BrowserSnapshot> {
  const prev = inputChains.get(browserId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => runBrowserInput(browserId, action));
  inputChains.set(
    browserId,
    next.catch(() => {})
  );
  return next;
}

async function runBrowserInput(
  browserId: string,
  action: BrowserInputAction
): Promise<BrowserSnapshot> {
  const rec = reg.browsers.get(browserId);
  if (rec && isInAppHostAlive(rec)) {
    const { snapshot } = await runInAppAction(
      browserId,
      "input",
      action.kind,
      { action }
    );
    return snapshot;
  }
  if (!rec || !rec.page || rec.page.isClosed()) {
    return rec?.snapshot ?? { ...EMPTY_BROWSER_SNAPSHOT, logs: [], steps: [] };
  }
  const page = rec.page;
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  const toPx = (nx: number, ny: number): [number, number] => [
    clamp01(nx) * viewport.width,
    clamp01(ny) * viewport.height,
  ];

  rec.screencast.lastPullAt = Date.now();
  try {
    switch (action.kind) {
      case "move": {
        const [px, py] = toPx(action.x, action.y);
        await page.mouse.move(px, py);
        break;
      }
      case "click": {
        const [px, py] = toPx(action.x, action.y);
        await page.mouse.click(px, py, { button: action.button ?? "left" });
        break;
      }
      case "dblclick": {
        const [px, py] = toPx(action.x, action.y);
        await page.mouse.dblclick(px, py);
        break;
      }
      case "mousedown": {
        const [px, py] = toPx(action.x, action.y);
        await page.mouse.move(px, py);
        await page.mouse.down();
        break;
      }
      case "mouseup": {
        const [px, py] = toPx(action.x, action.y);
        await page.mouse.move(px, py);
        await page.mouse.up();
        break;
      }
      case "scroll": {
        // 把鼠标移到目标点后用 wheel：这样会滚动鼠标下"真正可滚动的容器"
        // （而非固定的 document.scrollingElement，避免在内嵌滚动容器的页面滚错地方）。
        const [px, py] = toPx(action.x, action.y);
        await page.mouse.move(px, py);
        await page.mouse.wheel(action.deltaX, action.deltaY);
        break;
      }
      case "key": {
        await page.keyboard.press(action.key);
        break;
      }
      case "text": {
        await page.keyboard.type(action.text);
        break;
      }
    }
  } catch {
    /* 单次输入失败不致命，忽略 */
  }
  return rec.snapshot;
}

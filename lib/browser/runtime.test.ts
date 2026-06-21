import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setBrowserSitePolicyPathForTest } from "./policy";
import {
  addBrowserAnnotation,
  browserScroll,
  browserClick,
  browserWait,
  browserWaitFor,
  browserTabOpen,
  browserTabs,
  browserTabSwitch,
  browserSearchUrl,
  closeBrowsersForOwner,
  clearInAppBrowserPendingCommands,
  completeInAppBrowserCommand,
  getBrowserSnapshot,
  pollInAppBrowserCommand,
  registerInAppBrowserHost,
} from "./runtime";

let tmpDir: string | null = null;

async function nextInAppCommand(browserId: string) {
  for (let i = 0; i < 20; i++) {
    const { command } = pollInAppBrowserCommand(browserId);
    if (command) return command;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return null;
}

describe("browser in-app runtime", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "browser-runtime-test-"));
    __setBrowserSitePolicyPathForTest(path.join(tmpDir, "browser-sites.json"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    __setBrowserSitePolicyPathForTest(null);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("merges host completions even when only screenshot or pointer changed", () => {
    const browserId = `test-snapshot-${Date.now()}`;
    registerInAppBrowserHost(browserId);

    const snapshot = completeInAppBrowserCommand(browserId, "snapshot", {
      screenshotDataUrl: "data:image/png;base64,abc",
      pointer: {
        x: 0.25,
        y: 0.75,
        action: "click",
        label: "button",
        updatedAt: 123,
      },
    });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.screenshotDataUrl).toBe("data:image/png;base64,abc");
    expect(snapshot.pointer?.label).toBe("button");
  });

  it("marks host completion errors on the snapshot without requiring url/title", () => {
    const browserId = `test-error-${Date.now()}`;
    registerInAppBrowserHost(browserId);

    const snapshot = completeInAppBrowserCommand(browserId, "snapshot", {
      error: "webview crashed",
    });

    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toBe("webview crashed");
  });

  it("removes timed out in-app commands from the pending queue", async () => {
    vi.useFakeTimers();
    const browserId = `test-timeout-${Date.now()}`;
    registerInAppBrowserHost(browserId);

    const pending = browserWait(browserId, { ms: 1000 });
    const rejection = expect(pending).rejects.toThrow(
      "Browser command timed out: wait",
    );
    await vi.advanceTimersByTimeAsync(45_000);
    await rejection;

    const { command } = pollInAppBrowserCommand(browserId);
    expect(command).toBeNull();
    expect(getBrowserSnapshot(browserId).error).toContain(
      "Browser command timed out: wait",
    );
    expect(getBrowserSnapshot(browserId).steps[0]?.status).toBe("timeout");
    expect(getBrowserSnapshot(browserId).steps[0]?.errorCode).toBe("timeout");
  });

  it("clears pending in-app commands when the agent is aborted", async () => {
    const browserId = `test-abort-${Date.now()}`;
    registerInAppBrowserHost(browserId);

    const pending = browserWait(browserId, { ms: 1000 });
    clearInAppBrowserPendingCommands(browserId, "Browser command was aborted by the user.");

    await expect(pending).rejects.toThrow("Browser command was aborted by the user.");
    const { command } = pollInAppBrowserCommand(browserId);
    expect(command).toBeNull();
    expect(getBrowserSnapshot(browserId).error).toBe(
      "Browser command was aborted by the user.",
    );
  });

  it("rejects invalid browser_click inputs before dispatching to the host", async () => {
    const browserId = `test-click-invalid-${Date.now()}`;
    registerInAppBrowserHost(browserId);

    await expect(browserClick(browserId, {})).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(browserClick(browserId, { x: 1 })).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(
      browserClick(browserId, { selector: "button", x: 1, y: 2 })
    ).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(pollInAppBrowserCommand(browserId).command).toBeNull();
  });

  it("rejects empty browser_wait_for before dispatching to the host", async () => {
    const browserId = `test-wait-for-invalid-${Date.now()}`;
    registerInAppBrowserHost(browserId);

    await expect(browserWaitFor(browserId, {})).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(pollInAppBrowserCommand(browserId).command).toBeNull();
  });

  it("builds deterministic search URLs for the supported engines", () => {
    expect(browserSearchUrl({ query: "hello world" })).toEqual({
      engine: "baidu",
      url: "https://www.baidu.com/s?wd=hello%20world",
    });
    expect(browserSearchUrl({ query: "hello world", engine: "google" })).toEqual({
      engine: "google",
      url: "https://www.google.com/search?q=hello%20world",
    });
    expect(browserSearchUrl({ query: "hello world", engine: "bing" })).toEqual({
      engine: "bing",
      url: "https://www.bing.com/search?q=hello%20world",
    });
  });

  it("tracks in-app browser tab slots and switches by tab id", async () => {
    const browserId = `test-tabs-${Date.now()}`;
    registerInAppBrowserHost(browserId);

    const first = browserTabOpen(browserId, {
      url: "http://localhost:3000/one",
    });
    const firstCommand = await nextInAppCommand(browserId);
    expect(firstCommand?.action).toBe("tab_open");
    expect(firstCommand?.payload.url).toBe("http://localhost:3000/one");
    completeInAppBrowserCommand(browserId, firstCommand!.id, {
      url: "http://localhost:3000/one",
      title: "One",
      tabId: firstCommand!.payload.tabId as string,
    });
    await first;

    const second = browserTabOpen(browserId, {
      url: "http://localhost:3000/two",
    });
    const secondCommand = await nextInAppCommand(browserId);
    completeInAppBrowserCommand(browserId, secondCommand!.id, {
      url: "http://localhost:3000/two",
      title: "Two",
      tabId: secondCommand!.payload.tabId as string,
    });
    await second;

    const listed = await browserTabs(browserId);
    expect(listed.result.tabs).toHaveLength(2);
    expect(listed.result.tabs.map((tab) => tab.title)).toEqual(["One", "Two"]);
    expect(listed.result.text).toContain("0.   ");
    expect(listed.result.text).toContain("1. * ");
    expect(listed.result.activeTabId).toBe(secondCommand!.payload.tabId);

    const switched = browserTabSwitch(browserId, {
      tabId: firstCommand!.payload.tabId as string,
    });
    const switchCommand = await nextInAppCommand(browserId);
    expect(switchCommand?.action).toBe("tab_switch");
    expect(switchCommand?.payload.url).toBe("http://localhost:3000/one");
    completeInAppBrowserCommand(browserId, switchCommand!.id, {
      url: "http://localhost:3000/one",
      title: "One",
      tabId: firstCommand!.payload.tabId as string,
    });
    await switched;

    expect(getBrowserSnapshot(browserId).activeTabId).toBe(firstCommand!.payload.tabId);
    expect(getBrowserSnapshot(browserId).tabs.find((tab) => tab.active)?.title).toBe("One");
  });

  it("registers an in-app background tab without pretending it loaded", async () => {
    const browserId = `test-tabs-background-${Date.now()}`;
    registerInAppBrowserHost(browserId);
    completeInAppBrowserCommand(browserId, "snapshot", {
      url: "http://localhost:3000/current",
      title: "Current",
    });

    const { result, snapshot } = await browserTabOpen(browserId, {
      url: "http://localhost:3000/background",
      switchTo: false,
    });

    expect(result.url).toBe("http://localhost:3000/current");
    expect(snapshot.url).toBe("http://localhost:3000/current");
    expect(snapshot.tabs).toHaveLength(2);
    expect(snapshot.tabs.find((tab) => tab.id === result.tabId)?.active).toBe(false);
    expect(pollInAppBrowserCommand(browserId).command).toBeNull();
  });

  it("dispatches explicit scroll commands to the in-app host", async () => {
    const browserId = `test-scroll-${Date.now()}`;
    registerInAppBrowserHost(browserId);

    const pending = browserScroll(browserId, { text: "Guides" });
    const { command } = pollInAppBrowserCommand(browserId);
    expect(command?.action).toBe("scroll");
    expect(command?.payload.text).toBe("Guides");
    completeInAppBrowserCommand(browserId, command!.id, {
      url: "http://localhost:3000/docs",
      title: "Docs",
      pointer: {
        x: 0.5,
        y: 0.5,
        action: "scroll",
        label: "Guides",
        updatedAt: Date.now(),
      },
    });

    const { snapshot } = await pending;
    expect(snapshot.steps[0]?.action).toBe("scroll");
    expect(snapshot.pointer?.label).toBe("Guides");
  });

  it("closes only browser records that belong to the same owner", async () => {
    const suffix = Date.now();
    const legacyAgentId = `agent-owner-${suffix}`;
    const prefixedAgentId = `agent:${legacyAgentId}`;
    const otherSessionId = `standalone:session:${suffix}`;

    addBrowserAnnotation(legacyAgentId, {
      rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
      comment: "legacy agent",
    });
    addBrowserAnnotation(prefixedAgentId, {
      rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
      comment: "prefixed agent",
    });
    addBrowserAnnotation(otherSessionId, {
      rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
      comment: "other session",
    });

    await expect(closeBrowsersForOwner(prefixedAgentId)).resolves.toBe(2);

    expect(getBrowserSnapshot(legacyAgentId).status).toBe("closed");
    expect(getBrowserSnapshot(prefixedAgentId).status).toBe("closed");
    expect(getBrowserSnapshot(otherSessionId).status).not.toBe("closed");
  });
});

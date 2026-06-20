import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addBrowserAnnotation,
  browserWait,
  browserSearchUrl,
  closeBrowsersForOwner,
  completeInAppBrowserCommand,
  getBrowserSnapshot,
  pollInAppBrowserCommand,
  registerInAppBrowserHost,
} from "./runtime";

describe("browser in-app runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
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
      "in-app browser command timed out: wait",
    );
    await vi.advanceTimersByTimeAsync(45_000);
    await rejection;

    const { command } = pollInAppBrowserCommand(browserId);
    expect(command).toBeNull();
    expect(getBrowserSnapshot(browserId).error).toContain(
      "in-app browser command timed out: wait",
    );
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

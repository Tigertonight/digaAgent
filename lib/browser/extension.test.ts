import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __clearBrowserFailureCountsForTest,
  annotationBrowserIds,
  createBrowserExtension,
  findAnnotationBrowserId,
} from "./extension";
import { agentBrowserId } from "./browser-id";
import { addBrowserAnnotation } from "./runtime";
import { __setBrowserSitePolicyPathForTest } from "./policy";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "browser-extension-test-"));
  __setBrowserSitePolicyPathForTest(path.join(tmpDir, "browser-sites.json"));
  __clearBrowserFailureCountsForTest();
});

afterEach(async () => {
  __setBrowserSitePolicyPathForTest(null);
  __clearBrowserFailureCountsForTest();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("browser extension annotation lookup", () => {
  it("includes session standalone browser ids before the default fallback", () => {
    expect(
      annotationBrowserIds("agent-1", [
        "standalone:session:s1",
        "standalone:session:s1",
        "",
      ]),
    ).toEqual([
      "agent:agent-1",
      "standalone:session:s1",
      "standalone:default",
    ]);
  });

  it("does not fall back to the current agent for annotations owned elsewhere", () => {
    const { annotation } = addBrowserAnnotation(agentBrowserId("other-agent"), {
      rect: { x: 0, y: 0, w: 0.2, h: 0.2 },
      comment: "not this session",
    });

    expect(() =>
      findAnnotationBrowserId("agent-1", [], annotation.id),
    ).toThrow(/not found for the current browser session/);
  });
});

describe("browser extension retry gate", () => {
  it("blocks the third identical browser action failure", async () => {
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    createBrowserExtension({
      getAgentId: () => "agent-retry-gate",
      onBrowserState: () => {},
    })({
      on: () => {},
      registerTool: (tool: unknown) => {
        tools.push(tool as (typeof tools)[number]);
      },
    } as never);
    const open = tools.find((tool) => tool.name === "browser_open");
    if (!open) throw new Error("browser_open not registered");

    const target = "https://retry-gate.invalid/test";
    const first = await open.execute("call-1", { url: target });
    const second = await open.execute("call-2", { url: target });
    const third = await open.execute("call-3", { url: target });

    const text = (result: unknown) =>
      ((result as { content?: Array<{ text?: string }> }).content?.[0]?.text ??
        "");
    const errorCode = (result: unknown) =>
      (result as { details?: { evidence?: { errorCode?: string } } }).details
        ?.evidence?.errorCode;

    expect(text(first)).toContain("外部站点未授权");
    expect(text(second)).toContain("外部站点未授权");
    expect(errorCode(third)).toBe("repeated_browser_action_failed");
    expect(text(third)).toContain("Stopped retrying browser_open");
  });
});

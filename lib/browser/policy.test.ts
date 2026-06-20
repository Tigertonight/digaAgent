import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setBrowserSitePolicyPathForTest,
  allowBrowserSite,
  checkBrowserSite,
  detectSensitiveAction,
} from "./policy";

describe("browser policy sensitive action detection", () => {
  it("recognizes sensitive selector-style click targets", () => {
    expect(detectSensitiveAction('button[type="submit"]')).toBe("submit");
    expect(detectSensitiveAction("#login-button")).toBe("login");
    expect(detectSensitiveAction("[data-testid='checkout']")).toBe("payment");
  });
});

describe("browser policy scoped approvals", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "browser-policy-test-"));
    __setBrowserSitePolicyPathForTest(path.join(tmpDir, "browser-sites.json"));
  });

  afterEach(async () => {
    __setBrowserSitePolicyPathForTest(null);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps agent-scoped approvals isolated from other agents and global policy", async () => {
    await allowBrowserSite("https://example.com/a", "agent:a1");

    expect(
      (await checkBrowserSite("https://example.com/next", "agent:a1")).decision,
    ).toBe("allowed");
    expect(
      (await checkBrowserSite("https://example.com/next", "agent:a2")).decision,
    ).toBe("unknown");
    expect((await checkBrowserSite("https://example.com/next")).decision).toBe(
      "unknown",
    );
  });
});

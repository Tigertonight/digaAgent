import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getNarrationSettings,
  normalizeNarrationSettings,
  updateNarrationSettings,
} from "./settings";

let tmpDir = "";
let settingsFile = "";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "narration-settings-"));
  settingsFile = join(tmpDir, "settings.json");
  process.env.DIGA_AGENT_SETTINGS_FILE = settingsFile;
});

afterAll(() => {
  delete process.env.DIGA_AGENT_SETTINGS_FILE;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => rmSync(settingsFile, { force: true }));

describe("narration settings", () => {
  it("defaults to enabled with 800ms timeout", async () => {
    expect(await getNarrationSettings()).toEqual({ enable: true, timeoutMs: 800 });
  });

  it("normalizes timeout and trims model fields", () => {
    expect(
      normalizeNarrationSettings({
        enable: false,
        timeoutMs: 99999,
        provider: " p ",
        modelId: " m ",
      })
    ).toEqual({ enable: false, timeoutMs: 3000, provider: "p", modelId: "m" });
  });

  it("updates narration without clobbering other envelope fields", async () => {
    writeFileSync(settingsFile, JSON.stringify({ budget: { action: "pause" } }));
    await updateNarrationSettings({ enable: false, timeoutMs: 500 });
    const env = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(env.budget.action).toBe("pause");
    expect(env.narration).toEqual({ enable: false, timeoutMs: 500 });
  });
});

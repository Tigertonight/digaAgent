import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getCommunicationSettings,
  normalizeCommunicationSettings,
  updateCommunicationSettings,
} from "./settings";

let tmpDir = "";
let settingsFile = "";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "communication-settings-"));
  settingsFile = join(tmpDir, "settings.json");
  process.env.DIGA_AGENT_SETTINGS_FILE = settingsFile;
});

afterAll(() => {
  delete process.env.DIGA_AGENT_SETTINGS_FILE;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => rmSync(settingsFile, { force: true }));

describe("communication settings", () => {
  it("defaults to coding mode", async () => {
    expect(await getCommunicationSettings()).toEqual({ workMode: "coding" });
  });

  it("normalizes unknown modes to coding", () => {
    expect(
      normalizeCommunicationSettings({ workMode: "daily" })
    ).toEqual({ workMode: "daily" });
    expect(
      normalizeCommunicationSettings({ workMode: "unknown" as never })
    ).toEqual({ workMode: "coding" });
  });

  it("updates communication without clobbering other envelope fields", async () => {
    writeFileSync(settingsFile, JSON.stringify({ budget: { action: "pause" } }));
    await updateCommunicationSettings({ workMode: "daily" });
    const env = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(env.budget.action).toBe("pause");
    expect(env.communication).toEqual({ workMode: "daily" });
  });
});

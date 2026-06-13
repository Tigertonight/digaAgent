import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { compareVersions, selectDownloadAsset } = require("../electron/updater.js") as {
  compareVersions: (a: string, b: string) => number;
  selectDownloadAsset: (
    release: {
      html_url?: string;
      assets?: Array<{ name: string; browser_download_url: string }>;
    },
    options?: { platform?: NodeJS.Platform; arch?: NodeJS.Architecture }
  ) => string;
};

function asset(name: string) {
  return {
    name,
    browser_download_url: `https://example.com/${encodeURIComponent(name)}`,
  };
}

describe("electron updater", () => {
  it("compares semantic-ish versions", () => {
    expect(compareVersions("v0.1.3", "0.1.2")).toBe(1);
    expect(compareVersions("0.1.2", "0.1.2")).toBe(0);
    expect(compareVersions("0.1.1", "0.1.2")).toBe(-1);
  });

  it("selects the mac dmg for darwin", () => {
    const url = selectDownloadAsset(
      {
        assets: [
          asset("Diga Agent Setup 0.1.3.exe"),
          asset("Diga Agent-0.1.3-arm64.dmg"),
        ],
      },
      { platform: "darwin", arch: "arm64" }
    );

    expect(url).toContain("arm64.dmg");
  });

  it("selects the Windows installer before portable assets", () => {
    const url = selectDownloadAsset(
      {
        assets: [
          asset("Diga Agent-0.1.3-arm64.dmg"),
          asset("Diga Agent-Portable-0.1.3-x64.exe"),
          asset("Diga Agent-Setup-0.1.3-x64.exe"),
        ],
      },
      { platform: "win32", arch: "x64" }
    );

    expect(url).toContain("Setup-0.1.3-x64.exe");
  });

  it("does not select Windows update metadata instead of installable assets", () => {
    const url = selectDownloadAsset(
      {
        assets: [
          asset("latest.yml"),
          asset("Diga Agent-Setup-0.1.3-x64.exe.blockmap"),
          asset("Diga Agent-Setup-0.1.3-x64.exe"),
        ],
      },
      { platform: "win32", arch: "x64" }
    );

    expect(url).toContain("Setup-0.1.3-x64.exe");
    expect(url).not.toContain("blockmap");
    expect(url).not.toContain("latest.yml");
  });

  it("falls back to the release page when no matching asset exists", () => {
    const url = selectDownloadAsset(
      { html_url: "https://example.com/releases/v0.1.3", assets: [] },
      { platform: "win32", arch: "x64" }
    );

    expect(url).toBe("https://example.com/releases/v0.1.3");
  });
});

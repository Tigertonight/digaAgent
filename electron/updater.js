"use strict";

const { readFileSync, writeFileSync, existsSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");

const OWNER = "Tigertonight";
const REPO = "digaAgent";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;

let electronApp = null;
let electronShell = null;
let getMainWindow = () => null;
let prefsPath = null;
let state = {
  status: "idle",
  currentVersion: "0.0.0",
  autoCheckEnabled: true,
  checkedAt: null,
};

function compareVersions(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function normalizeVersion(input) {
  const clean = String(input || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[+-]/)[0];
  return clean.split(".").map((part) => {
    const n = Number.parseInt(part.replace(/\D.*$/, ""), 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function readPrefs() {
  if (!prefsPath || !existsSync(prefsPath)) {
    return { autoCheckEnabled: true, skippedVersion: null, lastCheckedAt: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(prefsPath, "utf8"));
    return {
      autoCheckEnabled: parsed.autoCheckEnabled !== false,
      skippedVersion:
        typeof parsed.skippedVersion === "string" ? parsed.skippedVersion : null,
      lastCheckedAt:
        typeof parsed.lastCheckedAt === "number" ? parsed.lastCheckedAt : null,
    };
  } catch {
    return { autoCheckEnabled: true, skippedVersion: null, lastCheckedAt: null };
  }
}

function writePrefs(next) {
  if (!prefsPath) return;
  mkdirSync(dirname(prefsPath), { recursive: true });
  writeFileSync(prefsPath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

function patchState(patch, notify = true) {
  state = {
    ...state,
    ...patch,
    currentVersion: electronApp?.getVersion?.() ?? state.currentVersion,
  };
  if (notify) {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("updater:state", state);
    }
  }
  return state;
}

function assetText(asset) {
  return `${asset?.name || ""} ${asset?.browser_download_url || ""}`;
}

function hasReleaseExt(asset, ext) {
  return new RegExp(`\\.${ext}(?:$|[?#])`, "i").test(assetText(asset));
}

function preferArch(assets, arch) {
  if (!assets.length) return null;
  const archPatterns = {
    x64: /(x64|amd64)/i,
    arm64: /(arm64|aarch64)/i,
    ia32: /(ia32|x86)/i,
  };
  const archPattern = archPatterns[arch];
  const anyArchPattern = /(x64|amd64|arm64|aarch64|ia32|x86)/i;
  return (
    (archPattern ? assets.find((asset) => archPattern.test(assetText(asset))) : null) ??
    assets.find((asset) => !anyArchPattern.test(assetText(asset))) ??
    assets[0] ??
    null
  );
}

function selectDownloadAsset(
  release,
  { platform = process.platform, arch = process.arch } = {}
) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  let preferred = null;
  if (platform === "win32") {
    const installerExeAssets = assets.filter(
      (asset) =>
        hasReleaseExt(asset, "exe") && /(setup|installer)/i.test(assetText(asset))
    );
    const msiAssets = assets.filter((asset) => hasReleaseExt(asset, "msi"));
    const exeAssets = assets.filter((asset) => hasReleaseExt(asset, "exe"));
    const zipAssets = assets.filter((asset) => hasReleaseExt(asset, "zip"));
    preferred =
      preferArch(installerExeAssets, arch) ??
      preferArch(msiAssets, arch) ??
      preferArch(exeAssets, arch) ??
      preferArch(zipAssets, arch);
  } else if (platform === "darwin") {
    const dmgAssets = assets.filter((asset) => hasReleaseExt(asset, "dmg"));
    const zipAssets = assets.filter((asset) => hasReleaseExt(asset, "zip"));
    preferred = preferArch(dmgAssets, arch) ?? preferArch(zipAssets, arch);
  } else {
    const appImageAssets = assets.filter((asset) => hasReleaseExt(asset, "AppImage"));
    const debAssets = assets.filter((asset) => hasReleaseExt(asset, "deb"));
    const rpmAssets = assets.filter((asset) => hasReleaseExt(asset, "rpm"));
    const zipAssets = assets.filter((asset) => hasReleaseExt(asset, "zip"));
    preferred =
      preferArch(appImageAssets, arch) ??
      preferArch(debAssets, arch) ??
      preferArch(rpmAssets, arch) ??
      preferArch(zipAssets, arch);
  }
  return preferred?.browser_download_url ?? release.html_url ?? RELEASES_URL;
}

async function fetchLatestRelease() {
  const res = await fetch(LATEST_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Diga-Agent-Updater",
    },
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`GitHub release check failed: HTTP ${res.status}`);
  }
  return res.json();
}

async function checkForUpdates({ manual = false } = {}) {
  const prefs = readPrefs();
  if (!manual && prefs.autoCheckEnabled === false) {
    return patchState({
      status: "idle",
      autoCheckEnabled: false,
      skippedVersion: prefs.skippedVersion,
    });
  }

  patchState({
    status: "checking",
    error: null,
    autoCheckEnabled: prefs.autoCheckEnabled,
    skippedVersion: prefs.skippedVersion,
  });

  try {
    const release = await fetchLatestRelease();
    if (!release) {
      const checkedAt = Date.now();
      writePrefs({ ...prefs, lastCheckedAt: checkedAt });
      return patchState({
        status: "not-available",
        currentVersion: electronApp.getVersion(),
        latestVersion: null,
        releaseName: null,
        releaseNotes: "",
        releaseUrl: RELEASES_URL,
        downloadUrl: RELEASES_URL,
        publishedAt: null,
        checkedAt,
        autoCheckEnabled: prefs.autoCheckEnabled,
        skippedVersion: prefs.skippedVersion,
      });
    }
    const latestVersion = String(release.tag_name || release.name || "").replace(
      /^v/i,
      ""
    );
    const currentVersion = electronApp.getVersion();
    const checkedAt = Date.now();
    writePrefs({ ...prefs, lastCheckedAt: checkedAt });

    const base = {
      currentVersion,
      latestVersion,
      releaseName: release.name || release.tag_name || latestVersion,
      releaseNotes: release.body || "",
      releaseUrl: release.html_url || RELEASES_URL,
      downloadUrl: selectDownloadAsset(release),
      publishedAt: release.published_at || null,
      checkedAt,
      autoCheckEnabled: prefs.autoCheckEnabled,
      skippedVersion: prefs.skippedVersion,
    };

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      return patchState({ ...base, status: "not-available" });
    }

    if (!manual && prefs.skippedVersion === latestVersion) {
      return patchState({ ...base, status: "skipped" });
    }

    return patchState({ ...base, status: "available" });
  } catch (error) {
    return patchState({
      status: "error",
      error: error?.message || String(error),
      checkedAt: Date.now(),
      autoCheckEnabled: prefs.autoCheckEnabled,
      skippedVersion: prefs.skippedVersion,
    });
  }
}

function shouldAutoCheck() {
  const prefs = readPrefs();
  return prefs.autoCheckEnabled !== false;
}

function checkOnStartup() {
  if (!shouldAutoCheck()) return;
  setTimeout(() => {
    void checkForUpdates({ manual: false });
  }, 2500);
}

function openDownload() {
  const url = state.downloadUrl || state.releaseUrl || RELEASES_URL;
  return electronShell.openExternal(url).then(() => true);
}

function registerUpdateIpc({ app, ipcMain, shell, getWindow }) {
  electronApp = app;
  electronShell = shell;
  getMainWindow = getWindow;
  prefsPath = join(app.getPath("userData"), "updater-preferences.json");
  const prefs = readPrefs();
  state = {
    ...state,
    currentVersion: app.getVersion(),
    autoCheckEnabled: prefs.autoCheckEnabled,
    skippedVersion: prefs.skippedVersion,
    checkedAt: prefs.lastCheckedAt,
  };

  ipcMain.handle("updater:getState", () => state);
  ipcMain.handle("updater:check", (_event, opts) =>
    checkForUpdates({ manual: opts?.manual !== false })
  );
  ipcMain.handle("updater:openDownload", () => openDownload());
  ipcMain.handle("updater:skipVersion", (_event, version) => {
    const prefs = readPrefs();
    const skippedVersion = typeof version === "string" ? version : state.latestVersion;
    writePrefs({ ...prefs, skippedVersion });
    return patchState({ skippedVersion, status: "skipped" });
  });
  ipcMain.handle("updater:remindLater", () => patchState({ status: "idle" }));
  ipcMain.handle("updater:setAutoCheck", (_event, enabled) => {
    const prefs = readPrefs();
    const autoCheckEnabled = Boolean(enabled);
    writePrefs({ ...prefs, autoCheckEnabled });
    return patchState({ autoCheckEnabled });
  });
}

module.exports = {
  compareVersions,
  checkForUpdates,
  checkOnStartup,
  registerUpdateIpc,
  selectDownloadAsset,
};

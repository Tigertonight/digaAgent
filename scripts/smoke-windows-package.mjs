#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
const useInstaller = process.argv.includes("--installer");
const timeoutMs = Number(process.env.DIGA_AGENT_PACKAGE_SMOKE_TIMEOUT_MS || 60000);

function fail(message, output = "") {
  console.error(`Windows package smoke failed: ${message}`);
  if (output.trim()) {
    console.error("\nLast app output:");
    console.error(output.trim().split(/\r?\n/).slice(-120).join("\n"));
  }
  process.exit(1);
}

function findArtifact(pattern, label) {
  if (!existsSync(distDir)) {
    fail(`missing dist directory at ${distDir}`);
  }
  const match = readdirSync(distDir)
    .filter((name) => pattern.test(name))
    .sort()
    .at(-1);
  if (!match) {
    fail(`missing ${label} artifact in dist`);
  }
  return join(distDir, match);
}

function runProcess(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd || dirname(file),
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const timer = setTimeout(() => {
      output += `\n[smoke] timed out after ${options.timeoutMs || timeoutMs}ms`;
      killProcessTree(child.pid);
    }, options.timeoutMs || timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: `${output}\n${error.stack || error}` });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, signal, output });
    });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already exited
  }
}

async function runPackagedAppSmoke(exePath) {
  if (!existsSync(exePath)) {
    fail(`missing packaged app executable at ${exePath}`);
  }
  const result = await runProcess(exePath, ["--smoke-test"], {
    timeoutMs,
    env: {
      ...process.env,
      DIGA_AGENT_ELECTRON_SMOKE_TEST: "1",
      ELECTRON_DISABLE_PET: "1",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
  });
  if (!result.ok || !result.output.includes("[electron] smoke-test ok")) {
    fail(
      `packaged app smoke exited with code ${result.code ?? "null"} signal ${result.signal ?? "null"}`,
      result.output
    );
  }
}

async function runInstallerSmoke() {
  const setupExe = findArtifact(/^Diga Agent-Setup-.+-x64\.exe$/, "Setup exe");
  findArtifact(/^Diga Agent-Portable-.+-x64\.exe$/, "Portable exe");
  const existingInstall = findExistingInstall();
  assertSafeToRunInstallerSmoke(existingInstall);

  if (existingInstall) {
    await runUpgradeInstallerSmoke(setupExe, existingInstall);
    return;
  }

  const installDir = resolve(
    process.env.DIGA_AGENT_INSTALLER_SMOKE_DIR ||
      join(root, ".tmp", "windows-installer-smoke", "DigaAgent")
  );
  rmSync(installDir, { recursive: true, force: true });

  try {
    const install = await runProcess(setupExe, ["/S", "/currentuser", `/D=${installDir}`], {
      timeoutMs: 180000,
    });
    if (!install.ok) {
      fail(`silent installer exited with code ${install.code ?? "null"}`, install.output);
    }

    const installedExe = join(installDir, "Diga Agent.exe");
    await runPackagedAppSmoke(installedExe);
  } finally {
    const uninstaller = join(installDir, "Uninstall Diga Agent.exe");
    if (existsSync(uninstaller)) {
      await runProcess(uninstaller, ["/S"], { timeoutMs: 120000 });
    }
    rmSync(installDir, { recursive: true, force: true });
  }
}

async function runUpgradeInstallerSmoke(setupExe, existingInstall) {
  if (!existingInstall.exePath || !existsSync(existingInstall.exePath)) {
    fail(
      `existing install was detected but executable could not be resolved (${existingInstall.exePath || "unknown"})`
    );
  }

  const install = await runProcess(setupExe, ["/S", "/currentuser"], {
    timeoutMs: 180000,
  });
  if (!install.ok) {
    fail(`silent upgrade installer exited with code ${install.code ?? "null"}`, install.output);
  }

  await runPackagedAppSmoke(existingInstall.exePath);
}

function assertSafeToRunInstallerSmoke(existingInstall) {
  if (!existingInstall) return;
  if (process.env.CI === "true") {
    fail(
      `existing Diga Agent install detected on CI at ${existingInstall.installDir || "unknown"}; installer smoke requires a clean runner`
    );
  }
  if (process.env.DIGA_AGENT_ALLOW_EXISTING_INSTALLER_SMOKE === "1") return;

  fail(
    "existing Diga Agent install detected; set DIGA_AGENT_ALLOW_EXISTING_INSTALLER_SMOKE=1 to run local upgrade smoke, or run on a clean CI runner for clean-install smoke"
  );
}

function findExistingInstall() {
  const query = spawnSync(
    "reg",
    [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "/s",
      "/f",
      "Diga Agent",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }
  );
  if (query.status !== 0 || !/DisplayName\s+REG_SZ\s+Diga Agent/.test(query.stdout)) {
    return null;
  }

  const displayIcon = query.stdout.match(/DisplayIcon\s+REG_SZ\s+(.+?)(?:,\d+)?\r?$/m)?.[1]?.trim();
  const uninstallPath = query.stdout
    .match(/UninstallString\s+REG_SZ\s+"([^"]+)"/m)?.[1]
    ?.trim();
  const exePath = displayIcon && displayIcon.endsWith(".exe")
    ? displayIcon
    : displayIcon?.match(/^(.+?\.exe),\d+$/)?.[1] || null;
  const resolvedExe = exePath || (uninstallPath ? join(dirname(uninstallPath), "Diga Agent.exe") : null);
  return {
    exePath: resolvedExe,
    installDir: resolvedExe ? dirname(resolvedExe) : null,
  };
}

if (process.platform !== "win32") {
  console.log("Windows package smoke skipped: not running on Windows.");
  process.exit(0);
}

if (useInstaller) {
  await runInstallerSmoke();
  console.log("Windows installer package smoke passed.");
} else {
  await runPackagedAppSmoke(join(distDir, "win-unpacked", "Diga Agent.exe"));
  console.log("Windows unpacked package smoke passed.");
}

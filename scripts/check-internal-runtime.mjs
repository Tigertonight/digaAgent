#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const localAssistantCli = String.fromCharCode(
  99,
  111,
  100,
  101,
  119,
  105,
  122,
  45,
  99,
  99
);
const sessionRoot = String.fromCharCode(
  46,
  99,
  99,
  45,
  109,
  105,
  114,
  114,
  111,
  114
);
const providerId = "local-coding-assistant";

function existingDirs(dirs) {
  const seen = new Set();
  return dirs.filter((dir) => {
    if (!dir || seen.has(dir)) return false;
    seen.add(dir);
    try {
      return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function nvmBinDirs(home) {
  const versionsDir = path.join(home, ".nvm", "versions", "node");
  try {
    return fs.readdirSync(versionsDir).map((version) => path.join(versionsDir, version, "bin"));
  } catch {
    return [];
  }
}

function executableAt(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCli() {
  const home = os.homedir();
  const pathEntries = existingDirs([
    ...(process.env.PATH ?? "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".yarn", "bin"),
    path.join(home, ".bun", "bin"),
    ...nvmBinDirs(home),
  ]);
  const env = { ...process.env, PATH: pathEntries.join(path.delimiter) };
  for (const dir of pathEntries) {
    const candidate = path.join(dir, localAssistantCli);
    if (executableAt(candidate)) return { command: candidate, env };
  }
  try {
    const { stdout } = await execFileAsync("/bin/zsh", ["-lc", `command -v ${localAssistantCli}`], {
      env,
      timeout: 5000,
    });
    const candidate = stdout.trim().split(/\r?\n/)[0];
    if (candidate && executableAt(candidate)) {
      return {
        command: candidate,
        env: { ...env, PATH: existingDirs([path.dirname(candidate), ...pathEntries]).join(path.delimiter) },
      };
    }
  } catch {
    // Best effort fallback handled by caller.
  }
  return { command: localAssistantCli, env };
}

function readSession() {
  const sessionPath = path.join(os.homedir(), sessionRoot, localAssistantCli, "session.json");
  if (!fs.existsSync(sessionPath)) {
    return { sessionPath, sessionExists: false, tokenPresent: false };
  }
  try {
    const data = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    return {
      sessionPath,
      sessionExists: true,
      tokenPresent: typeof data.accessToken === "string" && data.accessToken.length > 0,
    };
  } catch {
    return { sessionPath, sessionExists: true, tokenPresent: false };
  }
}

async function checkProvidersApi(url) {
  if (!url) return undefined;
  const res = await fetch(new URL("/api/providers", url));
  const data = await res.json();
  const provider = Array.isArray(data.providers)
    ? data.providers.find((item) => item.provider === providerId)
    : undefined;
  return {
    ok: Boolean(provider?.hasAuth),
    found: Boolean(provider),
    modelCount: provider?.models?.length ?? 0,
    defaultProvider: data.defaultProvider,
  };
}

const apiArgIndex = process.argv.indexOf("--api");
const apiUrl = apiArgIndex >= 0 ? process.argv[apiArgIndex + 1] : undefined;
const resolution = await resolveCli();
const session = readSession();
let version = "";
let installed = false;
let error = "";
try {
  const result = await execFileAsync(resolution.command, ["-version"], {
    env: resolution.env,
    timeout: 5000,
  });
  version = (result.stdout || result.stderr).trim();
  installed = true;
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
}

let providersApi;
try {
  providersApi = await checkProvidersApi(apiUrl);
} catch (err) {
  providersApi = {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

const summary = {
  installed,
  command: resolution.command,
  version,
  sessionExists: session.sessionExists,
  tokenPresent: session.tokenPresent,
  sessionPath: session.sessionPath,
  providersApi,
  error: error || undefined,
};

console.log(JSON.stringify(summary, null, 2));

if (!installed || !session.tokenPresent || providersApi?.ok === false) {
  process.exit(1);
}

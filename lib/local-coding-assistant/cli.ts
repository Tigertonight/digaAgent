import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LOCAL_CODING_ASSISTANT_CLI = String.fromCharCode(
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

export const LOCAL_CODING_ASSISTANT_SESSION_ROOT = String.fromCharCode(
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

export interface LocalCodingAssistantCliResolution {
  command: string;
  env: NodeJS.ProcessEnv;
  pathEntries: string[];
  resolvedFrom?: string;
}

function existingDirs(dirs: string[]) {
  const seen = new Set<string>();
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

function nvmBinDirs(home: string) {
  const versionsDir = path.join(home, ".nvm", "versions", "node");
  try {
    return fs
      .readdirSync(versionsDir)
      .map((version) => path.join(versionsDir, version, "bin"));
  } catch {
    return [];
  }
}

function candidatePathEntries() {
  const home = os.homedir();
  const envPath = process.env.PATH ?? "";
  return existingDirs([
    ...envPath.split(path.delimiter),
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
}

function executableAt(file: string) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveViaLoginShell(env: NodeJS.ProcessEnv) {
  try {
    const { stdout } = await execFileAsync(
      "/bin/zsh",
      ["-lc", `command -v ${LOCAL_CODING_ASSISTANT_CLI}`],
      { env, timeout: 5000 }
    );
    const candidate = stdout.trim().split(/\r?\n/)[0];
    if (candidate && executableAt(candidate)) return candidate;
  } catch {
    // GUI apps often miss shell PATH; this is best-effort only.
  }
  return undefined;
}

export async function resolveLocalCodingAssistantCli(): Promise<LocalCodingAssistantCliResolution> {
  const pathEntries = candidatePathEntries();
  const env = {
    ...process.env,
    PATH: pathEntries.join(path.delimiter),
  };
  for (const dir of pathEntries) {
    const candidate = path.join(dir, LOCAL_CODING_ASSISTANT_CLI);
    if (executableAt(candidate)) {
      return { command: candidate, env, pathEntries, resolvedFrom: candidate };
    }
  }

  const shellResolved = await resolveViaLoginShell(env);
  if (shellResolved) {
    const shellDir = path.dirname(shellResolved);
    const nextPathEntries = existingDirs([shellDir, ...pathEntries]);
    return {
      command: shellResolved,
      env: { ...env, PATH: nextPathEntries.join(path.delimiter) },
      pathEntries: nextPathEntries,
      resolvedFrom: shellResolved,
    };
  }

  return { command: LOCAL_CODING_ASSISTANT_CLI, env, pathEntries };
}

export function getLocalCodingAssistantSessionPath() {
  return path.join(
    os.homedir(),
    LOCAL_CODING_ASSISTANT_SESSION_ROOT,
    LOCAL_CODING_ASSISTANT_CLI,
    "session.json"
  );
}

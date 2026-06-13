import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CodeWizStatus {
  installed: boolean;
  version?: string;
  error?: string;
  sessionPath: string;
  sessionExists: boolean;
  tokenPresent: boolean;
}

async function getCodeWizVersion() {
  try {
    const { stdout, stderr } = await execFileAsync(
      "codewiz-cc",
      ["-version"],
      { timeout: 5000 }
    );
    return {
      installed: true,
      version: (stdout || stderr).trim() || "installed",
    };
  } catch (e) {
    return {
      installed: false,
      version: undefined,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function getSessionStatus() {
  const sessionPath = path.join(
    os.homedir(),
    ".cc-mirror",
    "codewiz-cc",
    "session.json"
  );
  if (!fs.existsSync(sessionPath)) {
    return { sessionPath, sessionExists: false, tokenPresent: false };
  }
  try {
    const raw = fs.readFileSync(sessionPath, "utf8");
    const data = JSON.parse(raw) as { accessToken?: unknown };
    return {
      sessionPath,
      sessionExists: true,
      tokenPresent:
        typeof data.accessToken === "string" && data.accessToken.length > 0,
    };
  } catch {
    return { sessionPath, sessionExists: true, tokenPresent: false };
  }
}

export async function detectCodeWizStatus(): Promise<CodeWizStatus> {
  const [binary, session] = await Promise.all([
    getCodeWizVersion(),
    Promise.resolve(getSessionStatus()),
  ]);

  return {
    ...binary,
    ...session,
  };
}

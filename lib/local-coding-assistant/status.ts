import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOCAL_ASSISTANT_CLI = String.fromCharCode(
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
const SESSION_ROOT_DIR = String.fromCharCode(
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

export interface LocalCodingAssistantStatus {
  installed: boolean;
  version?: string;
  error?: string;
  sessionPath: string;
  sessionExists: boolean;
  tokenPresent: boolean;
}

async function getLocalCodingAssistantVersion() {
  try {
    const { stdout, stderr } = await execFileAsync(LOCAL_ASSISTANT_CLI, ["-version"], {
      timeout: 5000,
    });
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
    SESSION_ROOT_DIR,
    LOCAL_ASSISTANT_CLI,
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

export async function detectLocalCodingAssistantStatus(): Promise<LocalCodingAssistantStatus> {
  const [binary, session] = await Promise.all([
    getLocalCodingAssistantVersion(),
    Promise.resolve(getSessionStatus()),
  ]);

  return {
    ...binary,
    ...session,
  };
}

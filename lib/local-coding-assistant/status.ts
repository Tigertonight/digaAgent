import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import {
  getLocalCodingAssistantSessionPath,
  resolveLocalCodingAssistantCli,
} from "./cli";

const execFileAsync = promisify(execFile);

export interface LocalCodingAssistantStatus {
  installed: boolean;
  version?: string;
  error?: string;
  command?: string;
  detectedPath?: string;
  sessionPath: string;
  sessionExists: boolean;
  tokenPresent: boolean;
}

async function getLocalCodingAssistantVersion() {
  try {
    const resolution = await resolveLocalCodingAssistantCli();
    const { stdout, stderr } = await execFileAsync(resolution.command, ["-version"], {
      env: resolution.env,
      timeout: 5000,
    });
    return {
      installed: true,
      version: (stdout || stderr).trim() || "installed",
      command: resolution.command,
      detectedPath: resolution.resolvedFrom,
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
  const sessionPath = getLocalCodingAssistantSessionPath();
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

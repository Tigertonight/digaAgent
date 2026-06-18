import "server-only";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type WorkMode = "coding" | "daily";

export interface CommunicationSettings {
  workMode: WorkMode;
}

export const DEFAULT_COMMUNICATION_SETTINGS: CommunicationSettings = {
  workMode: "coding",
};

interface SettingsEnvelope {
  communication?: Partial<CommunicationSettings>;
  [key: string]: unknown;
}

function settingsPath(): string {
  return (
    process.env.DIGA_AGENT_SETTINGS_FILE ||
    path.join(os.homedir(), ".diga-agent", "settings.json")
  );
}

async function readEnvelope(): Promise<SettingsEnvelope> {
  try {
    return JSON.parse(await fs.readFile(settingsPath(), "utf8")) as SettingsEnvelope;
  } catch {
    return {};
  }
}

async function writeEnvelope(next: SettingsEnvelope): Promise<void> {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
}

export function normalizeCommunicationSettings(
  input: Partial<CommunicationSettings> | undefined
): CommunicationSettings {
  const workMode = input?.workMode === "daily" ? "daily" : "coding";
  return { workMode };
}

export async function getCommunicationSettings(): Promise<CommunicationSettings> {
  const env = await readEnvelope();
  return normalizeCommunicationSettings(env.communication);
}

export async function updateCommunicationSettings(
  patch: Partial<CommunicationSettings>
): Promise<CommunicationSettings> {
  const env = await readEnvelope();
  const current = normalizeCommunicationSettings(env.communication);
  const next = normalizeCommunicationSettings({ ...current, ...patch });
  env.communication = next;
  await writeEnvelope(env);
  return next;
}

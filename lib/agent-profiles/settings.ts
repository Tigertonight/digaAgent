import "server-only";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAgentProfilesSettings } from "./resolve";
import type { AgentProfilesSettings } from "./types";

/**
 * Agent Profiles 全局设置持久化（Phase B）。
 *
 * 复用与 communication 相同的 ~/.diga-agent/settings.json 通用 envelope，
 * 在其 `agentProfiles` 字段读写，不新建文件、不引入并行存储。
 */

interface SettingsEnvelope {
  agentProfiles?: Partial<AgentProfilesSettings>;
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
    return JSON.parse(
      await fs.readFile(settingsPath(), "utf8")
    ) as SettingsEnvelope;
  } catch {
    return {};
  }
}

async function writeEnvelope(next: SettingsEnvelope): Promise<void> {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
}

export async function getAgentProfilesSettings(): Promise<AgentProfilesSettings> {
  const env = await readEnvelope();
  return normalizeAgentProfilesSettings(env.agentProfiles);
}

export async function updateAgentProfilesSettings(
  patch: Partial<AgentProfilesSettings>
): Promise<AgentProfilesSettings> {
  const env = await readEnvelope();
  const current = normalizeAgentProfilesSettings(env.agentProfiles);
  const next = normalizeAgentProfilesSettings({ ...current, ...patch });
  env.agentProfiles = next;
  await writeEnvelope(env);
  return next;
}

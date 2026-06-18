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

/**
 * Phase C-1：communication 不再是独立的全局设置，而是「生效 profile 的
 * communication 轴」的派生值——消除双轨。所有注入点仍调用本函数，但真值源已
 * 切换到 agent profiles。旧的 `communication` 字段不再被读取（updateCommunication-
 * Settings 保留作底层 API，但 UI 已移除）。
 *
 * 动态 import agent-profiles 以避免与 resolve.ts 的（类型层）相互引用纠缠，并把
 * server-only 依赖留在调用时解析。
 */
export async function getCommunicationSettings(): Promise<CommunicationSettings> {
  try {
    const [{ getAgentProfilesSettings }, { resolveProfile, profileWorkMode }] =
      await Promise.all([
        import("@/lib/agent-profiles/settings"),
        import("@/lib/agent-profiles/resolve"),
      ]);
    const settings = await getAgentProfilesSettings();
    const profile = resolveProfile(settings.defaultProfileId, settings);
    return { workMode: profileWorkMode(profile) };
  } catch {
    // 回退：profile 体系不可用时退回旧的独立字段，保证不破坏现有行为。
    const env = await readEnvelope();
    return normalizeCommunicationSettings(env.communication);
  }
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

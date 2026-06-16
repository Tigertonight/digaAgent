import "server-only";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface NarrationSettings {
  /** Phase 3 LLM enhancer 开关；默认开，失败/超时会回落规则文案。 */
  enable: boolean;
  /** 单条叙事增强同步等待上限；超时先回落，后台继续写内存缓存。 */
  timeoutMs: number;
  /** 可选：单独指定轻量 provider。未配置时复用 lastModel。 */
  provider?: string;
  /** 可选：单独指定轻量 model。未配置时复用 lastModel。 */
  modelId?: string;
}

export const DEFAULT_NARRATION_SETTINGS: NarrationSettings = {
  enable: true,
  timeoutMs: 800,
};

interface SettingsEnvelope {
  narration?: Partial<NarrationSettings>;
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

export function normalizeNarrationSettings(
  input: Partial<NarrationSettings> | undefined
): NarrationSettings {
  const timeout = Number(input?.timeoutMs);
  const timeoutMs = Number.isFinite(timeout)
    ? Math.min(3000, Math.max(200, Math.round(timeout)))
    : DEFAULT_NARRATION_SETTINGS.timeoutMs;
  const provider = typeof input?.provider === "string" && input.provider.trim()
    ? input.provider.trim()
    : undefined;
  const modelId = typeof input?.modelId === "string" && input.modelId.trim()
    ? input.modelId.trim()
    : undefined;
  return {
    enable: typeof input?.enable === "boolean" ? input.enable : DEFAULT_NARRATION_SETTINGS.enable,
    timeoutMs,
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

export async function getNarrationSettings(): Promise<NarrationSettings> {
  const env = await readEnvelope();
  return normalizeNarrationSettings(env.narration);
}

export async function updateNarrationSettings(
  patch: Partial<NarrationSettings>
): Promise<NarrationSettings> {
  const env = await readEnvelope();
  const current = normalizeNarrationSettings(env.narration);
  const next = normalizeNarrationSettings({ ...current, ...patch });
  env.narration = next;
  await writeEnvelope(env);
  return next;
}

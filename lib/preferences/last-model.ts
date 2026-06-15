import "server-only";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 服务端持久化 "上次使用的 provider / 模型 ID"。
 *
 * 与 lib/budget/server-store / lib/remote/store 共用 ~/.diga-agent/settings.json
 * （Electron 下指向 userData/settings.json，由 main 进程通过
 * DIGA_AGENT_SETTINGS_FILE 注入）。字段路径：envelope.lastModel。
 *
 * 设计要点：
 *  - 比 localStorage 稳：升级版本 / 切端口 / 清浏览器缓存都不丢。
 *  - 远程移动端通过 /api/preferences/last-model 读到同一份，避免桌面/移动
 *    选择不同步。
 *  - 仅记录用户**主动选过**的那一对；可读不到就由 useProviderModel 自己按
 *    DEFAULT_* + visibleProviders 顺序兜底。
 *  - 不归一化（不强制要求 provider 当前可见），交给前端在 visibleProviders
 *    更新时决定是降级 fallback 还是保留等待 keytar 解锁。
 */

export interface LastModelSelection {
  provider: string;
  modelId: string;
  /** 最后一次写入的 ms epoch；用于将来"多端冲突时取较新"的扩展。 */
  updatedAt: number;
}

interface SettingsEnvelope {
  lastModel?: Partial<LastModelSelection>;
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
    const raw = await fs.readFile(settingsPath(), "utf8");
    return JSON.parse(raw) as SettingsEnvelope;
  } catch {
    return {};
  }
}

async function writeEnvelope(next: SettingsEnvelope): Promise<void> {
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2), "utf8");
}

/** 读取上次记录。读不到 / 字段不全 → 返回 null（前端自行兜底）。 */
export async function getLastModel(): Promise<LastModelSelection | null> {
  const envelope = await readEnvelope();
  const stored = envelope.lastModel;
  if (!stored) return null;
  if (typeof stored.provider !== "string" || stored.provider.length === 0) {
    return null;
  }
  if (typeof stored.modelId !== "string" || stored.modelId.length === 0) {
    return null;
  }
  return {
    provider: stored.provider,
    modelId: stored.modelId,
    updatedAt:
      typeof stored.updatedAt === "number" ? stored.updatedAt : Date.now(),
  };
}

/** 写入。partial 至少要有 provider 与 modelId；空字符串视为"清除"。 */
export async function setLastModel(
  patch: Partial<LastModelSelection>
): Promise<LastModelSelection | null> {
  const envelope = await readEnvelope();
  // 显式清除：传 provider="" 或 modelId="" → 删 lastModel 字段。
  if (patch.provider === "" || patch.modelId === "") {
    delete envelope.lastModel;
    await writeEnvelope(envelope);
    return null;
  }
  if (typeof patch.provider !== "string" || patch.provider.length === 0) {
    return getLastModel();
  }
  if (typeof patch.modelId !== "string" || patch.modelId.length === 0) {
    return getLastModel();
  }
  const next: LastModelSelection = {
    provider: patch.provider,
    modelId: patch.modelId,
    updatedAt:
      typeof patch.updatedAt === "number" ? patch.updatedAt : Date.now(),
  };
  envelope.lastModel = next;
  await writeEnvelope(envelope);
  return next;
}

/** 清除（DELETE 语义）。 */
export async function clearLastModel(): Promise<void> {
  const envelope = await readEnvelope();
  if (envelope.lastModel == null) return;
  delete envelope.lastModel;
  await writeEnvelope(envelope);
}

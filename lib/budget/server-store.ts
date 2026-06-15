import "server-only";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_BUDGET, type SessionBudget } from "./types";
import { normalizeBudget } from "./index";

/**
 * 服务端 budget 持久化。
 *
 * 与 lib/remote/store 共用 ~/.diga-agent/settings.json（Electron 下指向
 * userData/settings.json，由 main 进程通过 DIGA_AGENT_SETTINGS_FILE 注入）。
 * 字段路径：envelope.budget。
 *
 * 设计要点：
 * - 默认 {action:"pause"}（其它三维全 undefined）= 不限流；不会因 localStorage 丢失
 *   或新装而被回到旧的 $5 / 30 / 600s 默认值。
 * - JSON shape 与前端 SessionBudget 一致；读出时走 normalizeBudget 做边界。
 * - 写文件用 mkdir+writeFile（与 remote/store 保持同规则；非原子但够用，
 *   并发改 settings 是低频操作）。
 */

interface SettingsEnvelope {
  budget?: Partial<SessionBudget>;
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

/**
 * 读取持久化 budget。读不到就返回 DEFAULT_BUDGET（不限流）。
 *
 * 读路径不抛错——settings.json 缺、损、被锁都视为"按默认走"。
 */
export async function getBudgetSettings(): Promise<SessionBudget> {
  const envelope = await readEnvelope();
  if (!envelope.budget) return DEFAULT_BUDGET;
  return normalizeBudget(envelope.budget);
}

/**
 * 写入持久化 budget。返回写入后归一化的 SessionBudget。
 * 仅覆盖 envelope.budget 字段，其它字段不动。
 */
export async function updateBudgetSettings(
  patch: Partial<SessionBudget>
): Promise<SessionBudget> {
  const envelope = await readEnvelope();
  const current = normalizeBudget(envelope.budget ?? {});
  const next = normalizeBudget({ ...current, ...patch });
  envelope.budget = next;
  await writeEnvelope(envelope);
  return next;
}

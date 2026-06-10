/**
 * Settings 模块（主进程）
 *
 * 两类数据：
 *  1. 敏感数据（API key）→ keytar（macOS Keychain / win Credential Manager / linux libsecret）
 *     service = "mini-pi-web"
 *     account = provider 名（如 "minimax-cn", "openai", "anthropic"）
 *     password = key 原文
 *
 *  2. 非敏感配置 → JSON 文件：{userData}/settings.json
 *     { defaultProvider, defaultModelId, lastCwd, fromEnvMigrated: boolean }
 *
 * SDK env 映射（已知）：
 *   minimax-cn  -> MINIMAX_CN_API_KEY
 *   minimax     -> MINIMAX_API_KEY
 *   openai      -> OPENAI_API_KEY
 *   anthropic   -> ANTHROPIC_API_KEY
 *   gemini      -> GEMINI_API_KEY / GOOGLE_API_KEY
 *   deepseek    -> DEEPSEEK_API_KEY
 *   moonshot    -> MOONSHOT_API_KEY
 *   zhipu       -> ZHIPU_API_KEY
 *   qwen        -> QWEN_API_KEY / DASHSCOPE_API_KEY
 *   ... 主要拿这些常见的，剩下交给用户从 UI 输入
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SERVICE = "mini-pi-web";

// 常见 provider → env 名（用于一次性迁移）
const PROVIDER_ENV_MAP = {
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  zhipu: ["ZHIPU_API_KEY"],
  qwen: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

let keytar = null;
function getKeytar() {
  if (keytar === null) {
    try {
      keytar = require("keytar");
    } catch (e) {
      console.error("[settings] keytar load failed:", e.message);
      keytar = false; // 标记加载失败，后续走 fallback
    }
  }
  return keytar || null;
}

function settingsFile(app) {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings(app) {
  try {
    const raw = fs.readFileSync(settingsFile(app), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveSettings(app, partial) {
  const cur = loadSettings(app);
  const next = { ...cur, ...partial };
  fs.mkdirSync(path.dirname(settingsFile(app)), { recursive: true });
  fs.writeFileSync(settingsFile(app), JSON.stringify(next, null, 2), "utf8");
  return next;
}

/* ---------- keytar 操作 ---------- */

async function listStoredProviders() {
  const k = getKeytar();
  if (!k) return [];
  const items = await k.findCredentials(SERVICE);
  // 只返回 provider 名，不返回 password
  return items.map((i) => i.account);
}

async function getKey(provider) {
  const k = getKeytar();
  if (!k) return null;
  return (await k.getPassword(SERVICE, provider)) || null;
}

async function setKey(provider, value) {
  const k = getKeytar();
  if (!k) throw new Error("keytar not available");
  if (!provider || typeof provider !== "string") throw new Error("bad provider");
  if (!value || typeof value !== "string") throw new Error("bad value");
  await k.setPassword(SERVICE, provider, value);
  return true;
}

async function deleteKey(provider) {
  const k = getKeytar();
  if (!k) return false;
  return await k.deletePassword(SERVICE, provider);
}

/**
 * 把已存的 key 转成 env 注入 dict，供 fork standalone 时合并到 child env
 * 返回形如 { MINIMAX_CN_API_KEY: "sk-cp...", OPENAI_API_KEY: "..." }
 */
async function buildEnvFromKeytar() {
  const stored = await listStoredProviders();
  // keytar 每个 getPassword 是一次进程间 IPC（macOS Keychain Access）。
  // 串行 6-10 个 provider 累计 200ms+；并发拉一次性返回，启动 -100~200ms。
  const entries = await Promise.all(
    stored.map(async (provider) => [provider, await getKey(provider)])
  );
  const env = {};
  for (const [provider, value] of entries) {
    if (!value) continue;
    const envNames = PROVIDER_ENV_MAP[provider];
    if (!envNames) {
      console.warn(`[settings] no env mapping for provider=${provider}, skipped`);
      continue;
    }
    // 把同一个 key 同步到所有别名
    for (const name of envNames) env[name] = value;
  }
  return env;
}

/**
 * 一次性迁移：如果 keytar 里没有任何 key，但 process.env 里有，
 * 自动入库（提示一次）。
 * 返回迁入的 provider 列表（调用方可弹 toast）。
 */
async function migrateFromEnvIfNeeded(app) {
  const settings = loadSettings(app);
  if (settings.fromEnvMigrated) return [];

  const k = getKeytar();
  if (!k) return [];

  const existing = await listStoredProviders();
  if (existing.length > 0) {
    // 已有 keytar 数据，标记迁移过
    saveSettings(app, { fromEnvMigrated: true });
    return [];
  }

  const migrated = [];
  for (const [provider, envNames] of Object.entries(PROVIDER_ENV_MAP)) {
    for (const name of envNames) {
      const value = process.env[name];
      if (value && value.length > 10) {
        try {
          await setKey(provider, value);
          migrated.push(provider);
          console.log(`[settings] migrated env ${name} -> keytar ${provider}`);
          break; // 同 provider 多个 env 别名，存第一个就够
        } catch (e) {
          console.warn(`[settings] migrate ${provider} failed:`, e.message);
        }
      }
    }
  }
  saveSettings(app, { fromEnvMigrated: true });
  return migrated;
}

module.exports = {
  SERVICE,
  PROVIDER_ENV_MAP,
  settingsFile,
  loadSettings,
  saveSettings,
  listStoredProviders,
  getKey,
  setKey,
  deleteKey,
  buildEnvFromKeytar,
  migrateFromEnvIfNeeded,
};

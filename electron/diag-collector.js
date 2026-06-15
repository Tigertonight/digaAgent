"use strict";

/**
 * 诊断信息收集器。
 *
 * 用户出问题时点「导出诊断信息」会调到这里。产出一个 JSON：
 *  - app/系统信息（version、platform、arch、locale）
 *  - 路径信息（packaged?、appPath、resourcesPath、userData、settings file 是否存在）
 *  - quarantine / xattr 检测（macOS 专属）
 *  - keytar 是否能 init（不读真实 key，只看模块 require / list 是否抛错）
 *  - server 健康检查（GET /api/health、/api/auth、/api/models-config status only）
 *  - ~/.pi、~/.diga-agent 关键文件存在与可读性（不读内容）
 *  - 最近 200 行主进程 + server stdio 日志（已 redact 敏感串）
 *
 * 不会写出：
 *  - settings.json 完整内容（仅"是否存在 / size"）
 *  - 任何 keytar value
 *  - 用户文件 path 之外的内容
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const http = require("node:http");
const diagLogger = require("./diag-logger");

const SECRET_PATTERNS = [
  // sk-... API keys (anthropic / openai 等)
  /\b(sk-(?:proj-)?[A-Za-z0-9_\-]{16,})\b/g,
  // Bearer / Authorization header values
  /\b(Bearer\s+[A-Za-z0-9._\-]{8,})\b/gi,
  // 32+ char hex / base64 token
  /\b([A-Fa-f0-9]{32,}|[A-Za-z0-9_\-]{40,})\b/g,
];

function redactLine(line) {
  let out = String(line);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      if (match.length <= 12) return "[redacted]";
      return `${match.slice(0, 4)}…${match.slice(-3)}[redacted]`;
    });
  }
  return out;
}

function safeStat(p) {
  try {
    const st = fs.statSync(p);
    return { exists: true, size: st.size, isDir: st.isDirectory() };
  } catch (e) {
    if (e && e.code === "ENOENT") return { exists: false };
    return { exists: false, error: e && e.code };
  }
}

function listDirShallow(p) {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .map((d) => `${d.name}${d.isDirectory() ? "/" : ""}`)
      .slice(0, 50);
  } catch {
    return null;
  }
}

function detectQuarantine(appPath) {
  if (process.platform !== "darwin" || !appPath) {
    return { applicable: false };
  }
  try {
    const out = execFileSync("xattr", ["-l", appPath], {
      encoding: "utf8",
      timeout: 2000,
    });
    const hasQuarantine = /com\.apple\.quarantine/.test(out);
    const hasProvenance = /com\.apple\.provenance/.test(out);
    return {
      applicable: true,
      hasQuarantine,
      hasProvenance,
      attrCount: out.split("\n").filter(Boolean).length,
    };
  } catch (e) {
    return { applicable: true, error: e && e.message };
  }
}

function detectKeytar() {
  try {
    // require 不抛 = 模块完整。findCredentials 用一个不太可能存在的 service，
    // 仅看 keytar 是否能 init；不读真实 secret。
    const keytar = require("keytar");
    if (typeof keytar.findCredentials !== "function") {
      return { ok: false, reason: "missing findCredentials" };
    }
    return { ok: true, hasFindCredentials: true };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || "require failed" };
  }
}

function probeHttp(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode || 0 });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.code || e.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
  });
}

/**
 * @param {object} ctx
 * @param {import("electron").App} ctx.app
 * @param {string|null} ctx.apiBase
 * @param {string|null} [ctx.localSecret]   — 用于带 header 调本机 protected route
 * @param {object|null} [ctx.renderer]      — Diag-2：renderer 传过来的已 sanitize 快照
 */
async function collectDiagnostics(ctx) {
  const { app, apiBase, localSecret, renderer } = ctx;
  const platform = process.platform;
  const arch = process.arch;
  const userDataDir = app.getPath("userData");
  const homeDir = os.homedir();

  // package.json version （app.getVersion 返回 build.productVersion 或 package.version）
  const appVersion = (() => {
    try {
      return app.getVersion();
    } catch {
      return "unknown";
    }
  })();

  const isPackaged = app.isPackaged === true;
  const appPath = app.getAppPath();
  const resourcesPath = process.resourcesPath || null;
  const execPath = app.getPath("exe");

  const macAppPath = (() => {
    if (platform !== "darwin" || !execPath) return null;
    // .../Diga Agent.app/Contents/MacOS/Diga Agent → 取到 .app
    const m = execPath.match(/^(.*\.app)\//);
    return m ? m[1] : null;
  })();

  // 文件 / 目录探针
  const settingsFile = path.join(userDataDir, "settings.json");
  const piDir = path.join(homeDir, ".pi");
  const digaDir = path.join(homeDir, ".diga-agent");

  const fsProbes = {
    userDataDir: { path: userDataDir, ...safeStat(userDataDir) },
    settingsFile: { path: settingsFile, ...safeStat(settingsFile) },
    piDir: {
      path: piDir,
      ...safeStat(piDir),
      shallow: listDirShallow(piDir),
    },
    digaDir: {
      path: digaDir,
      ...safeStat(digaDir),
      shallow: listDirShallow(digaDir),
    },
    logsDir: {
      path: path.join(userDataDir, "logs"),
      ...safeStat(path.join(userDataDir, "logs")),
    },
  };

  // HTTP 健康端点
  const httpProbes = {};
  if (apiBase) {
    httpProbes["/api/health"] = await probeHttp(`${apiBase}/api/health`);
    // 这两个是 local-only。带 local secret header 才有意义。但不带也能验"500/auth"差异。
    const headers = localSecret
      ? { "x-diga-agent-local-secret": localSecret }
      : {};
    httpProbes["/api/auth"] = await probeHttpWithHeaders(
      `${apiBase}/api/auth`,
      headers
    );
    httpProbes["/api/models-config"] = await probeHttpWithHeaders(
      `${apiBase}/api/models-config`,
      headers
    );
  }

  // 最近日志
  const recent = diagLogger.getRecentLines(200).map(redactLine);

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    app: {
      name: (() => {
        try {
          return app.getName();
        } catch {
          return "unknown";
        }
      })(),
      version: appVersion,
      isPackaged,
      appPath,
      resourcesPath,
      execPath,
      macAppPath,
    },
    system: {
      platform,
      arch,
      release: os.release(),
      osVersion: (() => {
        try {
          return os.version ? os.version() : null;
        } catch {
          return null;
        }
      })(),
      locale: (() => {
        try {
          return app.getLocale();
        } catch {
          return null;
        }
      })(),
      // GUI 启动 PATH 与 shell 启动 PATH 经常不同——这是常见 release-only 故障
      pathEntryCount: (process.env.PATH || "").split(":").filter(Boolean).length,
    },
    quarantine: detectQuarantine(macAppPath),
    keytar: detectKeytar(),
    apiBase: apiBase || null,
    fs: fsProbes,
    http: httpProbes,
    log: {
      filePath: diagLogger.getLogFilePath(),
      lineCount: recent.length,
      recent,
    },
    renderer: renderer || null,
  };
}

function probeHttpWithHeaders(url, headers, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers }, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode || 0 });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.code || e.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
  });
}

/**
 * Diag-2：renderer 传过来的 snapshot 不可信，只取一组已知安全字段 + 发限长度。
 * @param {unknown} input
 * @returns {object | null}
 */
function sanitizeRendererSnapshot(input) {
  if (!input || typeof input !== "object") return null;
  const limit = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
  const out = {};
  const obj = input;
  if (typeof obj.url === "string") out.url = limit(obj.url, 500);
  if (typeof obj.userAgent === "string")
    out.userAgent = limit(obj.userAgent, 500);
  if (typeof obj.providersCount === "number")
    out.providersCount = Math.max(0, Math.floor(obj.providersCount));
  if (typeof obj.authedProvidersCount === "number")
    out.authedProvidersCount = Math.max(
      0,
      Math.floor(obj.authedProvidersCount)
    );
  if (typeof obj.activeAgentId === "string")
    out.activeAgentId = limit(obj.activeAgentId, 100);
  if (typeof obj.windowErrorCount === "number")
    out.windowErrorCount = Math.max(0, Math.floor(obj.windowErrorCount));
  if (Array.isArray(obj.recentWindowErrors)) {
    out.recentWindowErrors = obj.recentWindowErrors
      .slice(0, 10)
      .map((e) => ({
        message: limit(e && e.message, 500),
        source: limit(e && e.source, 200),
        line: typeof (e && e.line) === "number" ? e.line : null,
        col: typeof (e && e.col) === "number" ? e.col : null,
        ts: typeof (e && e.ts) === "number" ? e.ts : null,
      }))
      .filter((e) => e.message);
  }
  if (typeof obj.online === "boolean") out.online = obj.online;
  if (typeof obj.locale === "string") out.locale = limit(obj.locale, 32);
  if (typeof obj.theme === "string") out.theme = limit(obj.theme, 32);
  return Object.keys(out).length === 0 ? null : out;
}

module.exports = { collectDiagnostics, redactLine, sanitizeRendererSnapshot };

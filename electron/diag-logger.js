"use strict";

/**
 * 主进程诊断日志收集器。
 *
 * 目标：让用户出问题时，能直接「导出诊断信息」拿到最近一段主进程 + server 子进程
 * 的 stdout/stderr，而不是依赖用户从 Console.app 里捞日志。
 *
 * 三层落地：
 *   1. ring buffer：保留最近 N 行（默认 2000 行），随时可 dump 到诊断包；
 *   2. tail file：异步写到 {userData}/logs/main.log（rotated），用户重启后仍能查；
 *   3. console hook：主进程 console.log/warn/error 自动入 buffer + file，无需改业务代码。
 *
 * 不收集敏感信息：调用方传入字符串前应自行 redact；本模块不做特殊解析，但导出
 * 诊断包时会做 secret-pattern 兜底（diag-collector.js:redactLine）。
 */

const fs = require("node:fs");
const path = require("node:path");

const MAX_LINES_DEFAULT = 2000;

const state = {
  lines: [], // string[] —— 已经包含时间戳和 level 前缀
  max: MAX_LINES_DEFAULT,
  fileStream: null,
  filePath: null,
  // 用于在 setupConsoleHook 之后还能给原 console 写
  origConsole: null,
};

function ts() {
  // 用 ISO 但去掉毫秒，长度短一些
  return new Date().toISOString().replace("T", " ").replace(/\..+/, "");
}

function pushLine(level, source, line) {
  if (!line) return;
  // line 可能是多行（child stdio chunk）
  for (const piece of String(line).split(/\r?\n/)) {
    if (piece.length === 0) continue;
    const formatted = `[${ts()}] [${level}] [${source}] ${piece}`;
    state.lines.push(formatted);
    if (state.lines.length > state.max) {
      state.lines.splice(0, state.lines.length - state.max);
    }
    if (state.fileStream) {
      try {
        state.fileStream.write(formatted + "\n");
      } catch {
        // 文件写失败不致命；ring buffer 还在
      }
    }
  }
}

/**
 * 初始化：
 *  - 在 {userData}/logs/main.log 开 append stream（自动 rotate 旧文件）；
 *  - hook console.* 把所有写入主进程 console 的内容也存进来。
 *
 * @param {object} opts
 * @param {string} opts.userDataDir
 * @param {number} [opts.maxLines]
 * @param {boolean} [opts.hookConsole]
 */
function initDiagLogger({ userDataDir, maxLines, hookConsole = true }) {
  if (typeof maxLines === "number" && maxLines > 0) state.max = Math.floor(maxLines);

  if (userDataDir) {
    try {
      const dir = path.join(userDataDir, "logs");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "main.log");
      // rotate：>5MB 时移到 main.log.1（覆盖）
      try {
        const st = fs.statSync(file);
        if (st.size > 5 * 1024 * 1024) {
          try {
            fs.renameSync(file, path.join(dir, "main.log.1"));
          } catch {
            // ignore
          }
        }
      } catch {
        // file not exist yet
      }
      state.fileStream = fs.createWriteStream(file, { flags: "a" });
      state.filePath = file;
    } catch {
      // 落盘失败不阻塞启动；保留 ring buffer
    }
  }

  if (hookConsole && !state.origConsole) {
    state.origConsole = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
    const wrap = (level, fn) => (...args) => {
      try {
        fn(...args);
      } catch {
        // ignore
      }
      pushLine(
        level,
        "main",
        args
          .map((a) => {
            if (typeof a === "string") return a;
            if (a instanceof Error) return `${a.message}\n${a.stack || ""}`;
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          })
          .join(" ")
      );
    };
    console.log = wrap("info", state.origConsole.log);
    console.warn = wrap("warn", state.origConsole.warn);
    console.error = wrap("error", state.origConsole.error);
  }
}

/** 注册 server 子进程的 stdout/stderr，让它们也进 ring buffer。 */
function attachChildProcess(child, label = "server") {
  if (!child) return;
  if (child.stdout) {
    child.stdout.on("data", (chunk) => pushLine("info", label, chunk));
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk) => pushLine("warn", label, chunk));
  }
}

/** 直接 push 一条诊断行（业务侧主动记录用）。 */
function logDiag(level, source, message) {
  pushLine(level || "info", source || "diag", message);
}

/** 拿最近的若干行，倒序但保留时间顺序（即正序最近 N 行）。 */
function getRecentLines(limit = 500) {
  const n = Math.max(0, Math.min(state.lines.length, Math.floor(limit)));
  return state.lines.slice(-n);
}

function getLogFilePath() {
  return state.filePath;
}

module.exports = {
  initDiagLogger,
  attachChildProcess,
  logDiag,
  getRecentLines,
  getLogFilePath,
};

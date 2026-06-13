/**
 * Standalone Next server 的 wrapper：
 *   1. require .next/standalone/server.js 让它正常起来
 *   2. watchdog：每秒探测 parent (Electron 主进程) 是否还活着
 *      parent 一旦消失（不论是被 SIGKILL、crash、还是用户强退），wrapper 自杀
 *
 * 用法：从 Electron 主进程 fork 这个文件，而不是直接 fork server.js。
 * 必须传 env：
 *   DIGA_AGENT_SERVER_ENTRY   - standalone server.js 的绝对路径
 *   DIGA_AGENT_PARENT_PID     - Electron 主进程 pid（兜底，正常用 process.ppid 即可）
 */

"use strict";

const PARENT_PID =
  parseInt(process.env.DIGA_AGENT_PARENT_PID || "", 10) || process.ppid;
const ENTRY = process.env.DIGA_AGENT_SERVER_ENTRY;

if (!ENTRY) {
  console.error("[server-wrapper] missing DIGA_AGENT_SERVER_ENTRY env");
  process.exit(2);
}

function parentAlive(pid) {
  if (!pid || pid <= 1) return false;
  try {
    // signal 0：只做存活检测，不真发信号
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = 进程不存在；EPERM = 存在但无权限（依然算活着）
    return e && e.code === "EPERM";
  }
}

// 1s 心跳；parent 死了 → 自己也死
const watchdog = setInterval(() => {
  if (!parentAlive(PARENT_PID)) {
    console.log(
      `[server-wrapper] parent pid=${PARENT_PID} gone, exiting standalone server`
    );
    clearInterval(watchdog);
    // 给 server 一个极短窗口 flush，然后强退
    setTimeout(() => process.exit(0), 50);
  }
}, 1000);
watchdog.unref();

// IPC channel 断了也立即退（fork 自带 IPC，main 那边 disconnect/close 就触发）
if (typeof process.disconnect === "function") {
  process.on("disconnect", () => {
    console.log("[server-wrapper] IPC disconnected, exiting");
    process.exit(0);
  });
}

// 任何主动信号都干净退出
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    console.log(`[server-wrapper] got ${sig}, exiting`);
    process.exit(0);
  });
}

// 切到 standalone 目录再 require：Next standalone server 会用 cwd 拼 `.next/static`、public 等
// 打包后 fork 时 cwd 可能是 `/`，不切的话静态资源 404
//
// asar 启用后 ENTRY = .../app.asar/.next/standalone/server.js（虚拟路径，asar 内 require 正常工作，
// 但 chdir 进 asar 虚拟目录在 macOS 上会 ENOENT）。
// 解决：chdir 失败时，尝试 unpacked 等价路径；再失败就用 app.asar 同级的 Resources 目录兜底
// （Next standalone 只需要 cwd 能拼出 `.next/static` 等绝对路径，能 readFile 就行）。
const path = require("node:path");
const standaloneDir = path.dirname(ENTRY);

function tryChdir(dir, label) {
  try {
    process.chdir(dir);
    console.log(`[server-wrapper] chdir ok (${label}): ${dir}`);
    return true;
  } catch (e) {
    console.warn(`[server-wrapper] chdir failed (${label}) ${dir}:`, e.message);
    return false;
  }
}

if (!tryChdir(standaloneDir, "asar")) {
  // asar 虚拟路径 chdir 不行，转 unpacked
  const unpacked = standaloneDir.replace(
    `app.asar${path.sep}`,
    `app.asar.unpacked${path.sep}`
  );
  if (unpacked !== standaloneDir) {
    tryChdir(unpacked, "unpacked");
  }
}

// asar 启用后的关键 patch：Next standalone server.js 自己会执行
//   process.chdir(__dirname)   // __dirname = asar 虚拟路径
// 这在 macOS 上会抛 ENOTDIR 直接崩。我们已经把 cwd 切到了 unpacked 物理路径，
// 内容等价。这里劫持 chdir：传入 asar 虚拟路径时静默忽略，其它路径正常处理。
const _origChdir = process.chdir.bind(process);
process.chdir = function patchedChdir(dir) {
  if (typeof dir === "string" && dir.includes(`app.asar${path.sep}`)) {
    // 尝试 fallback 到 unpacked；若同名 unpacked 也存在就切过去，否则保持当前 cwd
    const unpacked = dir.replace(
      `app.asar${path.sep}`,
      `app.asar.unpacked${path.sep}`
    );
    try {
      _origChdir(unpacked);
      return;
    } catch {
      // unpacked 不存在 → 保持当前 cwd（wrapper 已经设好）
      console.log(
        `[server-wrapper] swallowed chdir to asar virtual path, cwd stays at ${process.cwd()}`
      );
      return;
    }
  }
  return _origChdir(dir);
};

console.log(
  `[server-wrapper] starting standalone server (parent=${PARENT_PID}, entry=${ENTRY}, cwd=${process.cwd()})`
);

// 首次 http server listen 成功就向 parent 发 ready；让 main 进程不再 200ms 步进探测
// （200-400ms 量级冷启动开销）。失败则 main 端的 waitForHttp 兜底，无回归风险。
const http = require("node:http");
const _origListen = http.Server.prototype.listen;
let readyNotified = false;
http.Server.prototype.listen = function patchedListen(...args) {
  const ret = _origListen.apply(this, args);
  this.once("listening", () => {
    if (readyNotified) return;
    readyNotified = true;
    try {
      const addr = this.address();
      const port = typeof addr === "object" && addr ? addr.port : null;
      if (typeof process.send === "function") {
        process.send({ type: "server-ready", port });
        console.log(`[server-wrapper] notified parent: server-ready port=${port}`);
      }
    } catch (e) {
      console.warn("[server-wrapper] failed to notify parent:", e?.message);
    }
  });
  return ret;
};

// 直接 require，等价于 `node server.js`
// asar 内 require .js 在 Electron 二进制 + ELECTRON_RUN_AS_NODE=1（fork 默认）下 work
require(ENTRY);

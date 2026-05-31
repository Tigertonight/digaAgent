#!/usr/bin/env node
"use strict";

/**
 * mini-pi-web CLI 启动器（npx mini-pi-web）。
 *
 * 子命令:
 *   (无)     启动服务（默认）
 *   doctor   自检配置（~/.pi/、auth.json、models.json、node 版本、端口）
 *   help     显示帮助
 *
 * 用法:
 *   npx mini-pi-web                  # 端口默认 30142（避开 pi-web 的 30141）
 *   npx mini-pi-web -p 4000
 *   npx mini-pi-web -H 0.0.0.0
 *   npx mini-pi-web doctor
 *   PORT=4000 npx mini-pi-web
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { parseArgs } = require("util");

const pkgDir = path.join(__dirname, "..");
const nextDir = path.join(pkgDir, ".next");

// ===== 子命令分发 =====
const subcommand = process.argv[2];
if (subcommand === "doctor") {
  doctor().then((ok) => process.exit(ok ? 0 : 1));
  return;
}
if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
  printHelp();
  process.exit(0);
}
if (
  subcommand &&
  !subcommand.startsWith("-") &&
  subcommand !== "start"
) {
  console.error(`[mini-pi-web] Unknown subcommand: ${subcommand}`);
  printHelp();
  process.exit(1);
}

function printHelp() {
  console.log(`mini-pi-web — self-hosted UI for pi-coding-agent

Usage:
  npx mini-pi-web                  start the server (default port 30142)
  npx mini-pi-web -p 4000          start on custom port
  npx mini-pi-web -H 0.0.0.0       bind to a specific host
  npx mini-pi-web doctor           run configuration self-check
  npx mini-pi-web help             show this help

Environment:
  PORT, HOSTNAME    override defaults
  BROWSER=none      do not auto-open browser
`);
}

// ===== doctor 子命令 =====
async function doctor() {
  console.log("mini-pi-web doctor — 配置自检\n");

  const results = [];
  const check = (name, ok, detail = "") => {
    const icon = ok === true ? "✅" : ok === "warn" ? "⚠️ " : "❌";
    console.log(`${icon} ${name}${detail ? "  " + detail : ""}`);
    results.push({ name, ok });
  };

  // 1. Node 版本
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  check(
    `Node.js ${process.versions.node}`,
    nodeMajor >= 18,
    nodeMajor >= 18 ? "" : "(需要 >= 18)"
  );

  // 2. 平台
  console.log(`ℹ️  Platform: ${process.platform} ${process.arch}`);

  // 3. ~/.pi 目录
  const home = os.homedir();
  const piDir = path.join(home, ".pi");
  if (fs.existsSync(piDir) && fs.statSync(piDir).isDirectory()) {
    check(`~/.pi 目录存在`, true, piDir);
  } else {
    check(
      `~/.pi 目录`,
      "warn",
      `不存在 (${piDir}) — 首次启动会自动创建`
    );
  }

  // 4. auth.json
  const authPath = path.join(piDir, "auth.json");
  if (fs.existsSync(authPath)) {
    try {
      const raw = fs.readFileSync(authPath, "utf8");
      const data = JSON.parse(raw);
      const providers = Object.keys(data);
      check(
        `auth.json 可读`,
        true,
        `${providers.length} provider${providers.length === 1 ? "" : "s"}: ${providers.join(", ") || "(空)"}`
      );
    } catch (e) {
      check(`auth.json 解析失败`, false, e.message);
    }
  } else {
    check(`auth.json`, "warn", "不存在 — 还没配置任何凭证");
  }

  // 5. models.json
  const modelsPath = path.join(piDir, "models.json");
  if (fs.existsSync(modelsPath)) {
    try {
      const raw = fs.readFileSync(modelsPath, "utf8");
      const data = JSON.parse(raw);
      const providerCount = Object.keys(data.providers || {}).length;
      const modelCount = Object.values(data.providers || {}).reduce(
        (sum, p) => sum + Object.keys(p?.models || {}).length,
        0
      );
      check(
        `models.json 可读`,
        true,
        `${providerCount} provider, ${modelCount} model`
      );
    } catch (e) {
      check(`models.json 解析失败`, false, e.message);
    }
  } else {
    check(`models.json`, "warn", "不存在 — 会使用 SDK 内置默认模型");
  }

  // 6. 构建产物
  if (fs.existsSync(nextDir)) {
    const buildId = path.join(nextDir, "BUILD_ID");
    if (fs.existsSync(buildId)) {
      const id = fs.readFileSync(buildId, "utf8").trim();
      check(`.next 构建产物`, true, `BUILD_ID=${id}`);
    } else {
      check(`.next 构建产物`, "warn", "缺少 BUILD_ID");
    }
  } else {
    check(`.next 构建产物`, false, "不存在 — 安装包损坏？");
  }

  // 7. next 依赖
  try {
    const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
    const nextVer = require(nextPkg).version;
    check(`next ${nextVer}`, true);
  } catch (e) {
    check(`next 未安装`, false, e.message);
  }

  // 8. pi-coding-agent SDK（绕过 exports 限制，直接走文件系统）
  try {
    const sdkPkgPath = path.join(
      pkgDir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json"
    );
    if (fs.existsSync(sdkPkgPath)) {
      const sdkVer = JSON.parse(fs.readFileSync(sdkPkgPath, "utf8")).version;
      check(`@earendil-works/pi-coding-agent ${sdkVer}`, true);
    } else {
      // 在 monorepo / npm 拍平时 SDK 可能在父级 node_modules
      check(`pi-coding-agent SDK`, "warn", "未在本包 node_modules 找到（可能被 npm 拍平到父目录）");
    }
  } catch (e) {
    check(`pi-coding-agent SDK 检查失败`, false, e.message);
  }

  // 9. 端口占用
  const port = Number(process.env.PORT ?? 30142);
  const portFree = await isPortFree(port);
  check(
    `端口 ${port}`,
    portFree ? true : "warn",
    portFree ? "可用" : "被占用 — 启动时用 -p 换端口"
  );

  console.log("");
  const failed = results.filter((r) => r.ok === false).length;
  const warned = results.filter((r) => r.ok === "warn").length;
  if (failed > 0) {
    console.log(`❌ ${failed} 项失败，${warned} 项警告。`);
    return false;
  }
  if (warned > 0) {
    console.log(`⚠️  ${warned} 项警告，但可以启动。`);
  } else {
    console.log(`✅ 所有检查通过。`);
  }
  return true;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

// 解析 next CLI 入口（不依赖 .bin 软链）。
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
} catch {
  try {
    const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
    nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
  } catch {
    nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
  }
}

const { values: cliArgs } = parseArgs({
  options: {
    port: { type: "string", short: "p" },
    hostname: { type: "string", short: "H" },
  },
  strict: false,
});

const port = cliArgs.port ?? process.env.PORT ?? "30142";
const hostname = cliArgs.hostname ?? process.env.HOSTNAME ?? null;

if (!fs.existsSync(nextDir)) {
  console.error(
    "[mini-pi-web] Build artifacts not found at " +
      nextDir +
      ". This package must be installed from a published tarball with .next/ included."
  );
  process.exit(1);
}

const nextArgs = ["start", "-p", port];
if (hostname) nextArgs.push("-H", hostname);

const child = spawn(process.execPath, [nextBin, ...nextArgs], {
  cwd: pkgDir,
  stdio: ["inherit", "pipe", "inherit"],
  env: {
    ...process.env,
    // 告诉 next.config.ts 跳过 output: "standalone"
    // （next start 与 standalone 输出不兼容，会打 warning 并降级）
    MINI_PI_NO_STANDALONE: "1",
  },
});

let browserOpened = false;
const url = `http://${hostname ?? "localhost"}:${port}`;

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (!browserOpened && /Ready|ready in|started server on/i.test(text)) {
    browserOpened = true;
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";
    const openCmd = isWindows ? "start" : isMac ? "open" : "xdg-open";
    try {
      spawn(openCmd, [url], {
        shell: isWindows,
        stdio: "ignore",
        detached: true,
      }).unref();
    } catch {
      // 没图形界面就算了
    }
  }
});

child.on("exit", (code) => process.exit(code ?? 0));

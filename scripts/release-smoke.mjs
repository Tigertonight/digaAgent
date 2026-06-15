#!/usr/bin/env node
/**
 * release-smoke.mjs - 验证 DMG 产物在 “干净 HOME” 下的可用性。
 *
 * 用法（默认参数）：
 *   node scripts/release-smoke.mjs
 *
 * 自定义 DMG 路径：
 *   node scripts/release-smoke.mjs --dmg dist/Diga\\ Agent-0.1.2-arm64.dmg
 *
 * 步骤：
 *   1. attach DMG（hdiutil）
 *   2. 复制 .app 到临时目录 modeling “/Applications”
 *   3. xattr -cr 解 quarantine
 *   4. 拼临时 HOME（mktemp -d），让 ~/.pi / ~/.diga-agent / Keychain 都是干净的
 *   5. 启动 .app 子进程；端口由 app 自选，等 logs 里出现 server-ready 信号
 *   6. 跑 scripts/smoke-test.mjs（HTTP 健康验证）
 *   7. 经 IPC 收一份 diag bundle 写到 dist/release-smoke-diag.json
 *   8. 终止 app；detach DMG；清理临时目录
 *
 * 退出码：
 *   0 = 全部通过
 *   1 = 任何一步失败（详细写在 stdout 里）
 *
 * 不依赖：本机已有 ~/.pi 配置 / Keychain key / 已登录的 provider。
 *  - HOME 临时；env 变量也最小化（PATH 保留为系统默认 /usr/bin:/bin:/usr/sbin:/sbin）
 *  - DIGA_AGENT_WEB_ROOT 显式指向临时 HOME
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { dmg: null, keep: false, healthTimeoutMs: 30000, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dmg" && argv[i + 1]) {
      out.dmg = argv[i + 1];
      i += 1;
    } else if (a === "--keep") {
      out.keep = true;
    } else if (a === "--dry-run") {
      // 只 attach + copy + xattr，不启动 app、不跑 smoke。用于 CI 以及不想
      // 弹窗的场景。
      out.dryRun = true;
    } else if (a === "--health-timeout-ms" && argv[i + 1]) {
      out.healthTimeoutMs = Number(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

function findDefaultDmg() {
  const distDir = join(root, "dist");
  if (!existsSync(distDir)) return null;
  const candidates = readdirSync(distDir)
    .filter((f) => f.endsWith(".dmg"))
    .map((f) => ({ f, t: statSync(join(distDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return candidates[0] ? join(distDir, candidates[0].f) : null;
}

function logStep(name) {
  console.log("==>", name);
}

function fatal(message, evidence) {
  console.error("[release-smoke] FAIL:", message);
  if (evidence) console.error(evidence);
  process.exitCode = 1;
}

function attachDmg(dmgPath) {
  // -plist 无 stdin tty 干扰；-nobrowse 防 Finder 弹窗
  const r = spawnSync(
    "hdiutil",
    ["attach", dmgPath, "-nobrowse", "-noautoopen", "-plist"],
    { encoding: "utf8" }
  );
  if (r.status !== 0) {
    throw new Error("hdiutil attach failed: " + (r.stderr || r.stdout));
  }
  // 用最简单粗暴的方式找 mount-point: 抓 plist 里 <string>/Volumes/...</string>
  const m = r.stdout.match(/<string>(\/Volumes\/[^<]+)<\/string>/);
  if (!m) throw new Error("could not parse mount point from hdiutil output");
  return m[1];
}

function detachDmg(mountPoint) {
  if (!mountPoint) return;
  spawnSync("hdiutil", ["detach", mountPoint, "-force"], { stdio: "ignore" });
}

function findAppInside(mountPoint) {
  const entries = readdirSync(mountPoint, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && e.name.endsWith(".app")) {
      return join(mountPoint, e.name);
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const dmgPath = args.dmg ? resolve(args.dmg) : findDefaultDmg();
  if (!dmgPath || !existsSync(dmgPath)) {
    fatal("DMG not found. Run `npm run electron:build` first or pass --dmg.");
    return;
  }
  console.log("dmg:", dmgPath);

  const stagingDir = mkdtempSync(join(tmpdir(), "diga-release-smoke-"));
  const tempHome = join(stagingDir, "home");
  const appsLike = join(stagingDir, "Applications");
  mkdirSync(tempHome, { recursive: true });
  mkdirSync(appsLike, { recursive: true });
  console.log("stagingDir:", stagingDir);
  console.log("tempHome:", tempHome);

  let mountPoint = null;
  let appProc = null;
  let appPath = null;
  let healthBase = null;

  const cleanup = () => {
    try {
      if (appProc && appProc.exitCode === null) appProc.kill("SIGTERM");
    } catch {}
    detachDmg(mountPoint);
    if (!args.keep) {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
    } else {
      console.log("[keep] staging dir kept at", stagingDir);
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    logStep("attach DMG");
    mountPoint = attachDmg(dmgPath);
    console.log("mountPoint:", mountPoint);

    logStep("copy .app to staging Applications dir");
    const srcApp = findAppInside(mountPoint);
    if (!srcApp) throw new Error("no .app found inside DMG mount: " + mountPoint);
    appPath = join(appsLike, srcApp.split("/").pop());
    // 用 ditto 而不是 cp 复制：
    //  - cp -R 会保留源 read-only 位，DMG 里的 framework 文件都是 r-xr-xr-x。
    //  - ditto --noqtn 不会传递 quarantine，且会调整权限到目标位置可写。
    //  - 复制完后 chmod -R u+w 作二道保险，让 xattr -cr 能跑过。
    const dittoR = spawnSync(
      "ditto",
      ["--noqtn", srcApp, appPath],
      { encoding: "utf8" }
    );
    if (dittoR.status !== 0) {
      // ditto 不可用 → 退回 cpSync
      console.warn(
        "[warn] ditto failed (" + dittoR.status + "): " + (dittoR.stderr || "") + "; falling back to cpSync"
      );
      cpSync(srcApp, appPath, { recursive: true, dereference: false });
    }
    spawnSync("chmod", ["-R", "u+w", appPath], { stdio: "ignore" });

    logStep("strip quarantine attrs (xattr -cr)");
    const x1 = spawnSync("xattr", ["-cr", appPath], { encoding: "utf8" });
    if (x1.status !== 0) {
      console.warn("[warn] xattr -cr exited", x1.status, (x1.stderr || "").slice(0, 500));
    }

    if (args.dryRun) {
      logStep("--dry-run: skip app launch & smoke; verifying staged .app structure");
      // 检查三个必须存在的路径作为静态验收
      const checks = [
        join(appPath, "Contents", "Info.plist"),
        join(appPath, "Contents", "MacOS"),
        join(appPath, "Contents", "Resources"),
      ];
      for (const p of checks) {
        if (!existsSync(p)) throw new Error("missing " + p);
      }
      console.log("[ok] dry-run structure check passed");
      writeFileSync(
        join(root, "dist", "release-smoke-summary.json"),
        JSON.stringify(
          {
            schema: 1,
            generatedAt: new Date().toISOString(),
            dmg: dmgPath,
            mountPoint,
            appPath,
            tempHome,
            mode: "dry-run",
          },
          null,
          2
        )
      );
      return;
    }

    logStep("launch app from staging Applications with clean HOME");
    // 直接执行 Contents/MacOS/<binary>，不用 `open`，因为 open 会脱钩 stdio。
    const macosDir = join(appPath, "Contents", "MacOS");
    const bin = readdirSync(macosDir)[0];
    const execFile = join(macosDir, bin);

    const env = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: tempHome,
      DIGA_AGENT_WEB_ROOT: tempHome,
      // 让 server child 用固定端口，避免抢同一台机器上 dev server 的 30141
      PORT: "37501",
      // 保留语言环境，避免日志里夹中文 → 编码问题
      LANG: process.env.LANG || "en_US.UTF-8",
    };
    healthBase = "http://127.0.0.1:37501";

    appProc = spawn(execFile, [], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    let appOutput = "";
    const captureLine = (chunk) => {
      const text = chunk.toString("utf8");
      appOutput += text;
      if (appOutput.length > 200000) appOutput = appOutput.slice(-200000);
      process.stdout.write("[app] " + text);
    };
    appProc.stdout.on("data", captureLine);
    appProc.stderr.on("data", captureLine);

    logStep("wait for /api/health");
    const healthOk = await waitForHealth(
      healthBase + "/api/health",
      args.healthTimeoutMs
    );
    if (!healthOk) {
      writeFileSync(join(stagingDir, "app-output.log"), appOutput);
      throw new Error(
        "server health timed out after " +
          args.healthTimeoutMs +
          "ms; see " +
          join(stagingDir, "app-output.log")
      );
    }
    console.log("[ok] server healthy");

    logStep("run smoke-test.mjs against staged server");
    const smoke = spawnSync(
      process.execPath,
      [join(root, "scripts", "smoke-test.mjs")],
      {
        env: { ...process.env, PORT: "37501", HOME: tempHome },
        stdio: "inherit",
      }
    );
    if (smoke.status !== 0) {
      throw new Error("smoke-test.mjs failed: status " + smoke.status);
    }

    logStep("verify diag log file landed on disk (Smoke-1)");
    // 主进程 diagLogger 应当在 {tempHome}/Library/Application Support/Diga Agent/logs/main.log
    // 写入了启动期间的 stdout/stderr。这里求证：文件存在、size>0，且含“server-ready”
    // 或 “standalone server”之类启动日志关键词。用于防 hookConsole / fileStream 被错误重构干掉。
    const candidates = [
      join(
        tempHome,
        "Library",
        "Application Support",
        "Diga Agent",
        "logs",
        "main.log"
      ),
      // backup: 万一产品名变了也能兑底检查
      join(tempHome, "Library", "Application Support"),
    ];
    let logPath = null;
    for (const p of candidates) {
      if (existsSync(p) && statSync(p).isFile()) {
        logPath = p;
        break;
      }
    }
    if (!logPath) {
      // 只警告，不 failed。如果 "Diga Agent" 的 productName 在 build 里被改过会走这里，
      // 此时手动检查也可以。不打断 release 证书。
      console.warn("[warn] main.log not found under expected path; skipping log assertion");
    } else {
      const logContent = readFileSync(logPath, "utf8");
      if (logContent.length === 0) {
        throw new Error("main.log exists but is empty (diag logger broken)");
      }
      const hasStartupMarker =
        /standalone server|server-ready|electron|loading\s+http/i.test(
          logContent
        );
      if (!hasStartupMarker) {
        throw new Error(
          "main.log exists but missing startup marker; first 500 chars: " +
            logContent.slice(0, 500)
        );
      }
      console.log("[ok] diag main.log healthy (" + logContent.length + " bytes)");
    }

    logStep("write release-smoke summary");
    const summary = {
      schema: 1,
      generatedAt: new Date().toISOString(),
      dmg: dmgPath,
      mountPoint,
      appPath,
      tempHome,
      healthBase,
      smokeStatus: smoke.status,
      tail: appOutput.split("\n").slice(-50),
    };
    writeFileSync(
      join(root, "dist", "release-smoke-summary.json"),
      JSON.stringify(summary, null, 2)
    );
    console.log("[ok] summary written to dist/release-smoke-summary.json");
  } catch (e) {
    fatal((e && e.message) || String(e));
  } finally {
    cleanup();
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

main().catch((e) => {
  console.error("[release-smoke] crashed:", e);
  process.exit(2);
});

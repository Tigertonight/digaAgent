#!/usr/bin/env node
/**
 * electron:build 的包装脚本。
 *
 * 痛点：electron-builder 通过读磁盘上的 package.json + 调用 `npm list`
 * 来扫描"production dependencies"，把它们整树复制到 .app/Contents/Resources/app/node_modules。
 * 即使配了 extraMetadata.dependencies 也只影响写入 .app 的 package.json 内容，
 * 不影响复制范围。
 *
 * 解法：在 electron-builder 跑的时候临时把根 package.json 的 dependencies
 * 改成只有 keytar（Electron 主进程真实运行时唯一需要的根级依赖；
 * 其他依赖如 pi-coding-agent / next / react 全部由 .next/standalone/node_modules 提供）。
 * 跑完后**无条件**把原 package.json 恢复。
 *
 * 用法：node scripts/build-electron.mjs [...args]
 *   args 透传给 electron-builder
 */
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const lockPath = join(root, "package-lock.json");
const backupPkgPath = join(root, ".package.json.backup");
const backupLockPath = join(root, ".package-lock.json.backup");

// 哪些包是 "Electron 主进程真实运行时根级依赖"——
// 这里只有 keytar（native binding），所以白名单只 1 个。
const RUNTIME_DEPS = new Set(["keytar"]);
const STANDALONE_CLOSURE_ROOTS = new Set([
  // The Pi SDKs are used by Next API routes from standalone. Next tracing can
  // miss their ESM dependency graph, so copy their runtime closure explicitly.
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
]);

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  try {
    copyFileSync(backupPkgPath, pkgPath);
    copyFileSync(backupLockPath, lockPath);
    console.log("[build-electron] restored package.json + package-lock.json");
  } catch (e) {
    console.error("[build-electron] WARN restore failed:", e.message);
  }
}

// 任何退出路径都要恢复（包括 Ctrl+C / 异常 / 子进程崩）
process.on("exit", restore);
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restore();
  process.exit(143);
});
process.on("uncaughtException", (e) => {
  console.error(e);
  restore();
  process.exit(1);
});

// 备份
copyFileSync(pkgPath, backupPkgPath);
copyFileSync(lockPath, backupLockPath);
console.log("[build-electron] backed up package.json + package-lock.json");

// 把 dependencies 裁掉，同时临时塞 main 字段（npm 发布版没有 main）
const pkg = readJson(pkgPath);
const original = { ...pkg.dependencies };
const slim = Object.fromEntries(
  Object.entries(original).filter(([k]) => RUNTIME_DEPS.has(k))
);
const removed = Object.keys(original).filter((k) => !RUNTIME_DEPS.has(k));
pkg.dependencies = slim;
// electron 需要 main 入口；npm 发布版故意不带（避免把 electron/main.js
// 打进 tarball），所以这里临时塞回去
if (!pkg.main) pkg.main = "electron/main.js";
writeJson(pkgPath, pkg);
console.log(
  `[build-electron] trimmed dependencies: kept ${Object.keys(slim).join(",")}; removed ${removed.length} (${removed.join(",")})`
);

// 同步裁 package-lock.json 顶层 packages[""].dependencies
// 否则 electron-builder 的 npm list 仍会顺 lock 抓到被裁掉的包。
const lock = readJson(lockPath);
if (lock.packages && lock.packages[""]) {
  const lockRoot = lock.packages[""];
  if (lockRoot.dependencies) {
    lockRoot.dependencies = Object.fromEntries(
      Object.entries(lockRoot.dependencies).filter(([k]) => RUNTIME_DEPS.has(k))
    );
  }
}
// 顶层 dependencies 也裁（兼容老版 lock）
if (lock.dependencies) {
  for (const k of removed) {
    if (lock.dependencies[k]) {
      // 不删整个条目，只把它从 root 引用里摘出——
      // 简单粗暴：把 dev 字段标 true，npm list --prod 就会跳过。
      lock.dependencies[k].dev = true;
    }
  }
}
writeJson(lockPath, lock);
console.log("[build-electron] trimmed package-lock.json root dependencies");

// === 补齐 standalone 缺失的 turbo runtime ===
// next 16 + Turbopack prod build 的已知问题：standalone 的 NFT trace 不会把
// 所有 *-turbo.runtime.prod.js 复制进去（特别是 app-route-turbo），
// 导致 .app 启动后 API 路由 require 报 "Cannot find module"。
// 这里把源 node_modules/next/dist/compiled/next-server 下所有 turbo prod runtime
// 强制补到 standalone。
function patchTurboRuntimes() {
  const src = join(root, "node_modules/next/dist/compiled/next-server");
  const dst = join(
    root,
    ".next/standalone/node_modules/next/dist/compiled/next-server"
  );
  if (!existsSync(src)) {
    console.warn("[build-electron] WARN no src next-server dir, skip");
    return;
  }
  if (!existsSync(dst)) {
    mkdirSync(dst, { recursive: true });
  }
  let copied = 0;
  for (const name of readdirSync(src)) {
    // 只补 prod runtime（不要 dev / map），覆盖范围：所有 *turbo*.runtime.prod.js
    if (!/turbo.*\.runtime\.prod\.js$/.test(name)) continue;
    const srcFile = join(src, name);
    const dstFile = join(dst, name);
    if (existsSync(dstFile)) continue; // 已有的不动
    copyFileSync(srcFile, dstFile);
    copied++;
  }
  console.log(
    `[build-electron] patched ${copied} turbo runtime files into standalone`
  );
}
patchTurboRuntimes();

// === 补齐 ESM SDK 包的 dist 目录 ===
// Turbopack 对 type:"module" 的外部 SDK 会做一个 "hash 别名" 处理：
// 在 .next/node_modules/@scope/pkg-<hash>/ 下只生成一个 package.json
// （main 仍指 ./dist/index.js），然后运行时通过这个别名 import。
// 但 standalone trace 不会把真正的 dist/ 复制过去，导致运行时
// ERR_MODULE_NOT_FOUND。
//
// 也同时检查 standalone/node_modules/@scope/pkg/ 这个非 hash 副本——
// 它的 dist 同样会被漏掉。
//
// 解法：枚举 RUNTIME_DEPS 之外的、从 RUNTIME_DEPS 排除 list 里来的 SDK 包，
// 把源 dist 目录 cp -R 到所有目标位置。
function patchSdkDists() {
  // 真正需要补 dist 的 SDK 包（运行时 import 进 next API route）
  const sdkPackages = [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
  ];
  const standaloneRoot = join(root, ".next/standalone");
  let totalPatched = 0;

  for (const pkgName of sdkPackages) {
    const srcDist = join(root, "node_modules", pkgName, "dist");
    if (!existsSync(srcDist)) {
      console.warn(`[build-electron] WARN no src dist for ${pkgName}, skip`);
      continue;
    }

    // 目标 1：non-hash 副本
    const nonHashDst = join(standaloneRoot, "node_modules", pkgName, "dist");
    // 目标 2：hash 别名（遍历 .next/node_modules/@scope 下所有 pkg-<hash>）
    const scopeDir = pkgName.startsWith("@")
      ? join(standaloneRoot, ".next/node_modules", pkgName.split("/")[0])
      : null;
    const baseName = pkgName.includes("/") ? pkgName.split("/")[1] : pkgName;

    const targets = [];
    if (existsSync(join(standaloneRoot, "node_modules", pkgName))) {
      targets.push(nonHashDst);
    }
    if (scopeDir && existsSync(scopeDir)) {
      for (const entry of readdirSync(scopeDir)) {
        if (entry === baseName || entry.startsWith(baseName + "-")) {
          targets.push(join(scopeDir, entry, "dist"));
        }
      }
    }

    for (const dstDist of targets) {
      if (existsSync(dstDist)) continue;
      // 用 cp -R 递归复制（够快、保留符号链接）
      spawnSync("cp", ["-R", srcDist, dstDist], { stdio: "inherit" });
      totalPatched++;
      console.log(`[build-electron] patched dist -> ${dstDist}`);
    }
  }
  console.log(`[build-electron] patched ${totalPatched} SDK dist directories`);
}
patchSdkDists();

// === 补齐 next 包顶层入口文件（package.json + 顶层 .js/.d.ts）===
// next 16 standalone trace 已知 bug：对自身的 next 包只复制实际被引用的
// dist/ 子文件，不会把 package.json + 顶层入口（如 dist/cli.js, app.js 等）
// 复制过去。之前 build 还能 work 是因为 electron-builder 又把根
// node_modules/next/ 完整塞进 Resources/app/node_modules/，Node 沿 parent
// 查找能 fallback；裁掉 prod deps 后这条 fallback 没了，
// standalone/server.js 顶层 require('next') 直接 MODULE_NOT_FOUND。
// 修法：从源 node_modules/next/ 把 package.json 复制过去，其余顶层入口
// 也一并补。
function patchNextPackage() {
  const standaloneNm = join(root, ".next/standalone/node_modules");
  const srcNext = join(root, "node_modules/next");
  const dstNext = join(standaloneNm, "next");
  if (!existsSync(srcNext) || !existsSync(dstNext)) {
    console.warn("[build-electron] WARN cannot patch next pkg, skip");
    return;
  }
  // 整包 ditto 镜像复制 next 自身。
  // 原因：next 16 standalone NFT trace 严重不完整，连 dist/server/lib/
  // 同目录下的 sibling 文件（如 cpu-profile.js）都会漏，连补带漏修不完。
  // 整包 ~170M，可接受；裁掉 prod deps 节省的 ~280M 远超这点开销。
  spawnSync("ditto", [srcNext, dstNext], { stdio: "inherit" });
  console.log("[build-electron] patched next: full package via ditto");

  // 同时把 next 自身在 package.json 里声明的 direct dependencies 也整包 ditto 进来。
  // 原因：standalone trace 对 next 内部 require('@swc/helpers/_/...') 这类
  // 子路径 import 经常漏，逐个补不完。直接整包带来——这些包都很小（总计 < 10M）。
  let nextDeps = {};
  try {
    nextDeps =
      JSON.parse(readFileSync(join(srcNext, "package.json"), "utf8"))
        .dependencies || {};
  } catch (e) {
    console.warn("[build-electron] WARN read next package.json failed:", e.message);
  }
  // 合并：
  // 1. next 自身在 package.json 里声明的 direct dependencies
  // 2. 项目原始 dependencies 里非 keytar 的全部（react / react-dom /
  //    SDK / remark / react-syntax-highlighter 等）——这些是 next standalone
  //    内部以及 API route 运行时实际 require 的，trace 漏掉一个就崩。
  // 3. next 在 dist/server 里硬 require 的 next 包的 peerDep（react）已经在 #2 覆盖。
  // 通过 backup 文件读原始 dependencies。
  let backupDeps = {};
  try {
    backupDeps =
      JSON.parse(readFileSync(backupPkgPath, "utf8")).dependencies || {};
  } catch (e) {
    console.warn("[build-electron] WARN read backup pkg failed:", e.message);
  }
  const allDeps = new Set([
    ...Object.keys(nextDeps),
    ...Object.keys(backupDeps).filter((k) => !RUNTIME_DEPS.has(k)),
  ]);
  function collectRuntimeClosure(pkgName, seen = new Set()) {
    if (seen.has(pkgName)) return;
    seen.add(pkgName);
    const pkgJsonPath = join(root, "node_modules", pkgName, "package.json");
    if (!existsSync(pkgJsonPath)) return;

    let pkgJson = {};
    try {
      pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch (e) {
      console.warn(
        `[build-electron] WARN read dependency package.json failed (${pkgName}): ${e.message}`
      );
      return;
    }

    const deps = {
      ...(pkgJson.dependencies || {}),
      ...(pkgJson.optionalDependencies || {}),
    };
    for (const depName of Object.keys(deps)) {
      if (RUNTIME_DEPS.has(depName)) continue;
      allDeps.add(depName);
      collectRuntimeClosure(depName, seen);
    }
  }

  for (const depName of STANDALONE_CLOSURE_ROOTS) {
    collectRuntimeClosure(depName);
  }

  let copied = 0;
  for (const dep of allDeps) {
    const srcDep = join(root, "node_modules", dep);
    const dstDep = join(standaloneNm, dep);
    if (!existsSync(srcDep)) {
      console.warn(`[build-electron] WARN dep not found: ${dep}`);
      continue;
    }
    // 已存在的也覆盖（确保完整性）
    spawnSync("ditto", [srcDep, dstDep], { stdio: "inherit" });
    copied++;
  }
  console.log(
    `[build-electron] patched ${copied} dependencies (next deps + project runtime deps) via ditto`
  );
}
patchNextPackage();

// 跑 electron-builder
const args = ["electron-builder", ...process.argv.slice(2)];
console.log(`[build-electron] running: npx ${args.join(" ")}`);
const result = spawnSync("npx", args, { stdio: "inherit", cwd: root });
const exitCode = result.status ?? 1;
console.log(`[build-electron] electron-builder exited with ${exitCode}`);

// 显式恢复一次（exit handler 也会再跑一次但 idempotent）
restore();
process.exit(exitCode);

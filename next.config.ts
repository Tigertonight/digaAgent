import type { NextConfig } from "next";
import path from "node:path";
import fs from "node:fs";

function readJsonVersion(p: string): string {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const APP_VERSION = readJsonVersion(path.join(__dirname, "package.json"));
const PI_VERSION = readJsonVersion(
  path.join(
    __dirname,
    "node_modules/@earendil-works/pi-coding-agent/package.json"
  )
);

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*.trycloudflare.com"],
  devIndicators: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
    NEXT_PUBLIC_PI_VERSION: PI_VERSION,
  },
  // pi-coding-agent / pi-ai 是 Node-only SDK，不能被 Next 打进 client/edge bundle
  // 标记后会被 standalone trace 完整拷贝到 .next/standalone/node_modules/ 下
  serverExternalPackages: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
  ],
  // standalone: 让 next build 产出 .next/standalone/server.js
  // 这样 Electron 主进程就能直接 fork 它，不依赖宿主的 node_modules
  // npx/web 模式（电池场景）走 `next start`，不需要 standalone，
  // 且 standalone + next start 会冲突告警。
  // 默认开启（electron:build 路径），通过 DIGA_AGENT_NO_STANDALONE=1 关闭（CI/npm publish 路径）
  ...(process.env.DIGA_AGENT_NO_STANDALONE
    ? {}
    : { output: "standalone" as const }),
  turbopack: {
    root: path.join(__dirname),
  },
  // 只排除项目根级目录，避免 `**/...` 全局 glob 触发 next 16 NFT bug
  // —— 后者会把 node_modules/next/package.json 等顶层入口文件误排除，
  // 导致 .app 启动时 require('next') 报 MODULE_NOT_FOUND。
  // 现在只把会被 trace 误带入的"项目自身大头"挡掉：
  //   - dist/**        上一轮 electron-builder 产物（229M dmg 自包含循环的根因）
  //   - build/**       electron-builder 资源
  //   - electron/**    主进程代码，由 electron 自己加载，不是 next server 依赖
  //   - scripts/**     本地构建脚本
  //   - .next/cache/** webpack/turbopack 缓存
  // 注意：
  //   - lib/、app/、public/ 是 next 路由真实依赖，不能排除
  //   - 不要用 **/*.tsbuildinfo / **/*.map 等全局 glob：next 16 会误排除
  //     node_modules 内必需文件
  outputFileTracingExcludes: {
    "**": [
      "dist/**",
      "build/**",
      "electron/**",
      "scripts/**",
      ".next/cache/**",
    ],
  },
};

export default nextConfig;

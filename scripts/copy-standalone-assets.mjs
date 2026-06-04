/**
 * next build --output=standalone 不会把 .next/static 和 public/ 复制进 standalone 目录。
 * 这是 Next 官方已知设计：https://nextjs.org/docs/app/api-reference/config/next-config-js/output
 *
 * 这个脚本在 build 后补一刀，把它们放到 standalone 期望的位置：
 *   .next/standalone/.next/static  ← 来自 .next/static
 *   .next/standalone/public        ← 来自 public（如果存在）
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const staticSrc = join(root, ".next", "static");
const staticDst = join(root, ".next", "standalone", ".next", "static");
const publicSrc = join(root, "public");
const publicDst = join(root, ".next", "standalone", "public");
const workflowWorkerSrc = join(root, "lib", "workflows", "script-worker-child.cjs");
const workflowWorkerDst = join(
  root,
  ".next",
  "standalone",
  "lib",
  "workflows",
  "script-worker-child.cjs"
);

if (existsSync(staticSrc)) {
  rmSync(staticDst, { recursive: true, force: true });
  cpSync(staticSrc, staticDst, { recursive: true });
  console.log(`[copy-standalone] copied .next/static -> .next/standalone/.next/static`);
} else {
  console.warn(`[copy-standalone] warn: ${staticSrc} not found, skipped`);
}

if (existsSync(publicSrc)) {
  rmSync(publicDst, { recursive: true, force: true });
  cpSync(publicSrc, publicDst, { recursive: true });
  console.log(`[copy-standalone] copied public -> .next/standalone/public`);
}

if (existsSync(workflowWorkerSrc)) {
  mkdirSync(join(workflowWorkerDst, ".."), { recursive: true });
  cpSync(workflowWorkerSrc, workflowWorkerDst);
  console.log(
    `[copy-standalone] copied workflow worker -> .next/standalone/lib/workflows/script-worker-child.cjs`
  );
} else {
  console.warn(`[copy-standalone] warn: ${workflowWorkerSrc} not found, skipped`);
}

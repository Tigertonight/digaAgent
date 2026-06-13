#!/usr/bin/env node
/**
 * patch-next.mjs
 *
 * Next 16.2.6 + zod 4 在 next.config 里 generateBuildId 没显式声明时，
 * config schema 校验会把默认 () => null 丢掉，导致：
 *   build/index.js 调用 generateBuildId(config.generateBuildId, nanoid)
 *   → generate-build-id.js: `await generate()` 报
 *     "TypeError: generate is not a function"
 *
 * 在 next.config.ts 里显式写 generateBuildId 也无效（同样被 schema 过滤）。
 * 因此在每次 build 前 patch 一下 node_modules/next 里那个文件，
 * 让它能容忍 generate === undefined。
 *
 * 这个脚本是幂等的（已 patch 过的文件不会重复处理），
 * 失败也不会阻塞构建（只 warn）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(
  root,
  "node_modules/next/dist/build/generate-build-id.js"
);

const PATCH_MARKER = "// diga-agent patch:";
const ORIGINAL_LINE = "async function generateBuildId(generate, fallback) {\n    let buildId = await generate();";
const PATCHED_LINE = `async function generateBuildId(generate, fallback) {
    ${PATCH_MARKER} Next 16.2.6 zod schema drops the default generateBuildId,
    // making \`generate\` undefined. Fall back to the nanoid \`fallback\`.
    if (typeof generate !== 'function') {
        generate = () => null;
    }
    let buildId = await generate();`;

if (!existsSync(target)) {
  console.warn(`[patch-next] skip: ${target} not found`);
  process.exit(0);
}

const src = readFileSync(target, "utf8");

if (src.includes(PATCH_MARKER)) {
  console.log("[patch-next] generate-build-id.js already patched");
  process.exit(0);
}

if (!src.includes(ORIGINAL_LINE)) {
  console.warn(
    "[patch-next] WARN: generate-build-id.js shape changed; please review."
  );
  process.exit(0);
}

const out = src.replace(ORIGINAL_LINE, PATCHED_LINE);
writeFileSync(target, out, "utf8");
console.log("[patch-next] patched generate-build-id.js");

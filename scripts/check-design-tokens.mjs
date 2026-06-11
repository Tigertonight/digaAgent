#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const scanRoots = ["app"];
const extensions = new Set([".css", ".ts", ".tsx"]);
const ignoredFiles = new Set([
  "app/globals.css",
  "app/components/DesignPrimitives.tsx",
]);

const checks = [
  {
    name: "hex-color",
    pattern: /#[0-9a-fA-F]{3,8}\b/g,
  },
  {
    name: "rgba-rgb-hsl",
    pattern: /\b(?:rgba?|hsla?)\(/g,
  },
  {
    name: "arbitrary-text",
    pattern: /\btext-\[(?!color:var\()/g,
  },
  {
    name: "arbitrary-radius",
    pattern: /\brounded-\[(?!var\()/g,
  },
  {
    name: "arbitrary-shadow",
    pattern: /\bshadow-\[(?!var\()/g,
  },
  {
    name: "raw-tailwind-tone",
    pattern:
      /\b(?:bg|text|border)-(?:neutral|gray|slate|blue|red|emerald|amber|yellow|green)-\d{2,3}\b/g,
  },
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, files);
      continue;
    }
    const ext = path.slice(path.lastIndexOf("."));
    const rel = relative(root, path);
    if (ignoredFiles.has(rel)) continue;
    if (extensions.has(ext)) files.push(path);
  }
  return files;
}

const files = scanRoots.flatMap((dir) => walk(join(root, dir)));
const totals = new Map(checks.map((check) => [check.name, 0]));
const byFile = [];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const fileTotals = {};
  for (const check of checks) {
    const count = [...text.matchAll(check.pattern)].length;
    if (count > 0) {
      fileTotals[check.name] = count;
      totals.set(check.name, totals.get(check.name) + count);
    }
  }
  const total = Object.values(fileTotals).reduce((sum, count) => sum + count, 0);
  if (total > 0) {
    byFile.push({ file: relative(root, file), total, fileTotals });
  }
}

byFile.sort((a, b) => b.total - a.total);

console.log("Design token drift report");
console.log("==========================");
console.log(`Scanned files: ${files.length}`);
console.log(`Total findings: ${byFile.reduce((sum, item) => sum + item.total, 0)}`);
console.log("");
for (const [name, count] of totals) {
  console.log(`${name.padEnd(20)} ${String(count).padStart(5)}`);
}
console.log("");
console.log("Top files");
for (const item of byFile.slice(0, 25)) {
  console.log(`${String(item.total).padStart(4)}  ${item.file}`);
}
console.log("");
console.log("This report is informational. Prefer design tokens for new UI.");

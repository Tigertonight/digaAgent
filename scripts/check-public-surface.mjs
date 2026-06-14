#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const scanTargets = [
  "app",
  "lib",
  "build",
  "electron",
  "scripts",
  "docs",
  "README.md",
  "package.json",
];

const ignoredDirs = new Set([
  ".git",
  ".next",
  "dist",
  "node_modules",
  "coverage",
  "test-results",
  "playwright-report",
]);

const textExtensions = new Set([
  "",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);

function lit(codes) {
  return String.fromCharCode(...codes);
}

function escaped(codes) {
  return lit(codes).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const forbidden = [
  new RegExp(escaped([99, 111, 100, 101, 119, 105, 122]), "i"),
  new RegExp(`\\b${escaped([120, 104, 115])}\\b`, "i"),
  new RegExp(`@${escaped([120, 104, 115])}\\b`, "i"),
  new RegExp(escaped([120, 105, 97, 111, 104, 111, 110, 103, 115, 104, 117]), "i"),
  new RegExp(escaped([23567, 32418, 20070]), "i"),
  new RegExp(escaped([114, 101, 100, 110, 111, 116, 101]), "i"),
  new RegExp(escaped([114, 101, 100, 98, 111, 111, 107]), "i"),
  new RegExp(`${escaped([109, 97, 97, 115])}\\.${escaped([100, 101, 118, 111, 112, 115])}`, "i"),
  new RegExp(`${escaped([110, 112, 109])}\\.${escaped([100, 101, 118, 111, 112, 115])}`, "i"),
  new RegExp(
    `${escaped([100, 101, 118, 111, 112, 115])}\\.${escaped([120, 105, 97, 111, 104, 111, 110, 103, 115, 104, 117])}`,
    "i"
  ),
  new RegExp(
    `${escaped([100, 101, 118, 111, 112, 115])}\\.${escaped([114, 101, 100, 110, 111, 116, 101])}`,
    "i"
  ),
  new RegExp(`${escaped([112, 105, 99, 97, 115, 115, 111])}-${escaped([112, 114, 105, 118, 97, 116, 101])}`, "i"),
  new RegExp(
    `${escaped([99, 111, 115])}\\.${escaped([97, 112])}-${escaped([115, 104, 97, 110, 103, 104, 97, 105])}\\.${escaped([109, 121, 113, 99, 108, 111, 117, 100])}\\.${escaped([99, 111, 109])}`,
    "i"
  ),
];

function isTextFile(file) {
  return textExtensions.has(path.extname(file).toLowerCase());
}

function walk(target, files = []) {
  const abs = path.join(root, target);
  if (!fs.existsSync(abs)) return files;
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    if (ignoredDirs.has(path.basename(abs))) return files;
    for (const entry of fs.readdirSync(abs)) {
      walk(path.join(target, entry), files);
    }
    return files;
  }
  if (stat.isFile() && isTextFile(abs)) files.push(abs);
  return files;
}

const findings = [];
const files = scanTargets.flatMap((target) => walk(target));
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const pattern of forbidden) {
      if (!pattern.test(line)) continue;
      findings.push({
        file: path.relative(root, file),
        line: idx + 1,
        pattern: String(pattern),
        text: line.trim().slice(0, 180),
      });
    }
  });
}

if (findings.length > 0) {
  console.error("Public surface check failed. Remove internal names, domains, package scopes, or client identifiers:");
  for (const finding of findings) {
    console.error(
      `- ${finding.file}:${finding.line} ${finding.pattern} :: ${finding.text}`
    );
  }
  process.exit(1);
}

console.log(`Public surface check passed. Scanned ${files.length} files.`);

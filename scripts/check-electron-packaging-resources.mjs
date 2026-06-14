#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const buildConfig = pkg.build ?? {};
const issues = [];
const gitProbe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const insideGitWorkTree =
  gitProbe.status === 0 && gitProbe.stdout.trim() === "true";
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

function displayPath(absPath) {
  return relative(root, absPath).replaceAll("\\", "/");
}

function resolvePackagePath(rawPath) {
  return isAbsolute(rawPath) ? rawPath : resolve(root, rawPath);
}

function addRequiredPath(label, rawPath) {
  if (!rawPath || typeof rawPath !== "string") return;
  if (/[*?\[\]{}]/.test(rawPath)) {
    issues.push(`${label}: glob paths are not supported by this check (${rawPath})`);
    return;
  }

  const absPath = resolvePackagePath(rawPath);
  if (!existsSync(absPath)) {
    issues.push(`${label}: missing ${displayPath(absPath)}`);
    return;
  }

  const stat = statSync(absPath);
  if (!stat.isFile() && !stat.isDirectory()) {
    issues.push(`${label}: not a file or directory (${displayPath(absPath)})`);
    return;
  }

  if (insideGitWorkTree && !isTrackedByGit(absPath, stat)) {
    issues.push(`${label}: ${displayPath(absPath)} exists but is not tracked by git`);
  }
}

function isTrackedByGit(absPath, stat) {
  const relPath = displayPath(absPath);
  const exact = spawnSync("git", ["ls-files", "--stage", "--", relPath], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (hasRealIndexEntry(exact.stdout, stat)) return true;

  if (!stat.isDirectory()) return false;

  const trackedChildren = spawnSync("git", ["ls-files", "--stage", "--", `${relPath}/`], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return hasRealIndexEntry(trackedChildren.stdout, stat);
}

function hasRealIndexEntry(output, stat) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.some((line) => {
    const [, objectId] = line.match(/^\d+\s+([0-9a-f]{40})\s+\d+\t/) || [];
    if (!objectId) return false;
    // `git add -N` records a non-empty working-tree file as the empty blob.
    // That is not enough for clean checkout/CI, so fail until real content is
    // staged or committed.
    return !(stat.isFile() && stat.size > 0 && objectId === EMPTY_BLOB);
  });
}

const extraResources = Array.isArray(buildConfig.extraResources)
  ? buildConfig.extraResources
  : [];

for (const [index, resource] of extraResources.entries()) {
  if (typeof resource === "string") {
    addRequiredPath(`build.extraResources[${index}]`, resource);
    continue;
  }
  if (resource && typeof resource === "object") {
    addRequiredPath(`build.extraResources[${index}].from`, resource.from);
  }
}

const dmgContents = Array.isArray(buildConfig.dmg?.contents)
  ? buildConfig.dmg.contents
  : [];

for (const [index, item] of dmgContents.entries()) {
  if (item?.type === "file" && typeof item.path === "string") {
    addRequiredPath(`build.dmg.contents[${index}].path`, item.path);
  }
}

if (issues.length > 0) {
  console.error("Electron packaging resource check failed:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  console.error(
    "\nAdd the missing files to source control or remove the stale package.json build references before running electron-builder."
  );
  process.exit(1);
}

console.log(
  `Electron packaging resource check passed (${extraResources.length} extraResources, ${dmgContents.length} dmg entries scanned).`
);

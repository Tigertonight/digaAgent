#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const candidates = [
  {
    name: "bwrap",
    argv: [
      "bwrap",
      "--unshare-net",
      "--die-with-parent",
      "--new-session",
      "{command}",
      "{args}",
    ],
  },
  {
    name: "firejail",
    argv: [
      "firejail",
      "--quiet",
      "--net=none",
      "--private",
      "--noroot",
      "{command}",
      "{args}",
    ],
  },
  {
    name: "sandbox-exec",
    argv: [
      "sandbox-exec",
      "-p",
      "(version 1) (deny network*) (allow default)",
      "{command}",
      "{args}",
    ],
  },
];

function available(binary) {
  try {
    execFileSync("sh", ["-lc", `command -v ${binary}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const detected = candidates
  .map((item) => ({ ...item, available: available(item.name) }))
  .filter((item) => item.available);

console.log("Workflow worker sandbox candidates:");
for (const item of candidates) {
  console.log(`- ${item.name}: ${available(item.name) ? "available" : "missing"}`);
}

if (detected.length === 0) {
  console.log("\nNo supported sandbox tool detected.");
  process.exitCode = 1;
} else {
  const recommended = detected[0];
  console.log("\nRecommended environment value:");
  console.log(
    `MINI_PI_WORKFLOW_WORKER_SANDBOX_ARGV_JSON='${JSON.stringify(
      recommended.argv
    )}'`
  );
}

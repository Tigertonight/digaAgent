#!/usr/bin/env node
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const name of ["dist", ".next"]) {
  rmSync(join(root, name), { recursive: true, force: true });
  console.log(`[clean] removed ${name}`);
}

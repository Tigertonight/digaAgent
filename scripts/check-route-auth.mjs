#!/usr/bin/env node
/**
 * 校验 app/api/**\/route.ts 的鉴权覆盖率。
 *
 * 规则：
 *   - 每个 route.ts 必须出现 `withRemoteAuth` 或 `assertRemoteAuth` 至少一次。
 *   - withRemoteAuth 装饰器若使用了 publicReason，必须命中 PUBLIC_ROUTE_ALLOWLIST 白名单。
 *   - 仅做语法层最小校验；具体行为正确性由代码评审 + 测试保障。
 *
 * 失败时输出违规列表并以非零退出码结束。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const apiRoot = join(root, "app", "api");

const PUBLIC_REASONS = new Set([
  "health-probe",
  "remote-pair-bootstrap",
  "oauth-public-callback",
  // R1: 主机存活探活。必须公开，不依赖 token，不返回业务信息。
  "remote-health-probe",
]);

function walkRoutes(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      walkRoutes(p, out);
      continue;
    }
    if (entry === "route.ts" || entry === "route.js") {
      out.push(p);
    }
  }
  return out;
}

const routes = walkRoutes(apiRoot);
const violations = [];

for (const file of routes) {
  const rel = relative(root, file);
  const src = readFileSync(file, "utf8");
  const hasWithAuth = /\bwithRemoteAuth\b/.test(src);
  const hasAssertAuth = /\bassertRemoteAuth\b/.test(src);
  if (!hasWithAuth && !hasAssertAuth) {
    violations.push({
      file: rel,
      kind: "missing-auth",
      message:
        "route.ts must call withRemoteAuth(...) or assertRemoteAuth(req) on every handler",
    });
    continue;
  }

  // 校验 publicReason 白名单
  const reasonRegex = /publicReason\s*:\s*["']([^"']+)["']/g;
  let m;
  while ((m = reasonRegex.exec(src)) !== null) {
    const reason = m[1];
    if (!PUBLIC_REASONS.has(reason)) {
      violations.push({
        file: rel,
        kind: "unknown-public-reason",
        message: `unknown publicReason "${reason}". Add it to PUBLIC_ROUTE_ALLOWLIST after security review.`,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("❌ Route auth coverage check failed:");
  for (const v of violations) {
    console.error(`  - [${v.kind}] ${v.file}: ${v.message}`);
  }
  console.error(`\nTotal violations: ${violations.length}`);
  process.exit(1);
}

console.log(
  `✅ Route auth coverage OK (${routes.length} route files, all gated).`
);

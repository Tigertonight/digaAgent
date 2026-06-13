#!/usr/bin/env node
/**
 * 烟雾测试：把所有公开 API endpoint 打一遍，验证 server 端不爆炸。
 *
 * 流程：
 *   1. 假设 server 已在 PORT (默认 30142) 启动
 *   2. 顺序请求所有 endpoint，校验状态码 & 返回结构
 *   3. 任何失败立即 exit 1
 *
 * 用法：
 *   # 先启动 server
 *   cd /tmp/diga-agent-smoke
 *   PORT=30142 BROWSER=none node_modules/.bin/diga-agent &
 *   sleep 6
 *
 *   # 再跑测试
 *   PORT=30142 node diga-agent/scripts/smoke-test.mjs
 */
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PORT ?? 30142);
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ ${name}\n   ${e.message}`);
    failed++;
    failures.push({ name, error: e.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function getJson(path, init) {
  const r = await fetch(`${BASE}${path}`, init);
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON (status ${r.status}): ${text.slice(0, 200)}`);
  }
  return { status: r.status, json };
}

async function main() {
  console.log(`smoke-test against ${BASE}\n`);

  await check("GET /api/health", async () => {
    const { status, json } = await getJson("/api/health");
    assert(status === 200, `status ${status}`);
    assert(json.ok === true, "ok != true");
    assert(typeof json.name === "string", "missing name");
  });

  await check("GET /api/home", async () => {
    const { status, json } = await getJson("/api/home");
    assert(status === 200, `status ${status}`);
    assert(typeof json.home === "string", "missing home");
  });

  await check("GET /api/default-cwd", async () => {
    const { status, json } = await getJson("/api/default-cwd");
    assert(status === 200, `status ${status}`);
    assert(typeof json.cwd === "string", "missing cwd");
  });

  await check("GET /api/files (HOME)", async () => {
    // 用 HOME 而不是 /tmp（diga-agent 默认锁定到 DIGA_AGENT_WEB_ROOT，通常是 HOME）
    const { status, json } = await getJson(`/api/files?path=${encodeURIComponent(process.env.HOME ?? "/")}`);
    assert(status === 200, `status ${status}, body=${JSON.stringify(json)}`);
    // entries 字段或 children 字段都接受
    const list = json.entries || json.children || json.items;
    assert(Array.isArray(list), `no array field in response: ${Object.keys(json).join(",")}`);
  });

  await check("GET /api/auth", async () => {
    const { status, json } = await getJson("/api/auth");
    assert(status === 200, `status ${status}`);
    assert(Array.isArray(json.providers), "providers not array");
    assert(Array.isArray(json.oauthProviders), "oauthProviders not array");
    assert(json.providers.length > 0, "no providers returned");
  });

  await check("GET /api/providers", async () => {
    const { status, json } = await getJson("/api/providers");
    assert(status === 200, `status ${status}`);
    assert(Array.isArray(json.providers), "providers not array");
  });

  await check("GET /api/models-config", async () => {
    const { status, json } = await getJson("/api/models-config");
    assert(status === 200, `status ${status}`);
    // 返回结构：{ path, data: { providers: {...} } }
    assert(typeof json.path === "string", "missing path");
    assert(json.data && typeof json.data === "object", "missing data");
  });

  await check("GET /api/sessions", async () => {
    const { status, json } = await getJson("/api/sessions");
    assert(status === 200, `status ${status}`);
    assert(Array.isArray(json.sessions), "sessions not array");
  });

  await check("GET /api/skills", async () => {
    const { status, json } = await getJson("/api/skills");
    assert(status === 200, `status ${status}`);
    // 返回 { cwd, skills } 或 { installed }
    const list = json.skills || json.installed;
    assert(Array.isArray(list), `no skills array in response: ${Object.keys(json).join(",")}`);
  });

  await check("POST /api/skills/search {query:test}", async () => {
    const { status, json } = await getJson("/api/skills/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });
    assert(status === 200, `status ${status}`);
    assert(Array.isArray(json.results), "results not array");
  });

  // OAuth SSE：读 1.5 秒，确认能拿到首条 event
  await check("GET /api/auth/login/anthropic (SSE first event)", async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    let firstChunk = "";
    try {
      const r = await fetch(`${BASE}/api/auth/login/anthropic`, {
        signal: ctrl.signal,
      });
      assert(r.status === 200, `status ${r.status}`);
      assert(
        r.headers.get("content-type")?.includes("event-stream"),
        "not SSE"
      );
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      while (firstChunk.length < 20) {
        const { value, done } = await reader.read();
        if (done) break;
        firstChunk += dec.decode(value, { stream: true });
      }
      await reader.cancel().catch(() => {});
    } catch (e) {
      if (e.name !== "AbortError") throw e;
    } finally {
      clearTimeout(timer);
    }
    assert(firstChunk.startsWith("event:"), `bad first chunk: ${firstChunk.slice(0, 50)}`);
  });

  // OAuth 不存在的 provider → 404
  await check("GET /api/auth/login/bogus-xxx → 404", async () => {
    const r = await fetch(`${BASE}/api/auth/login/bogus-xxx`);
    assert(r.status === 404, `expected 404, got ${r.status}`);
  });

  // POST /api/auth/login 无 token → 400
  await check("POST /api/auth/login/anthropic without token → 400", async () => {
    const r = await fetch(`${BASE}/api/auth/login/anthropic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });

  // logout 任意 provider 都应返回 ok（即使不存在）
  await check("POST /api/auth/logout/test → ok", async () => {
    const r = await fetch(`${BASE}/api/auth/logout/test-provider-xxx`, {
      method: "POST",
    });
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  // 短暂等待 SSE 连接的悬挂 callback 被 GC，避免 server 进程被 abort 干扰
  await sleep(200);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("smoke-test crashed:", e);
  process.exit(2);
});

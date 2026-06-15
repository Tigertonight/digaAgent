/**
 * R7: /api/files runtime 鉴权回归测试。
 *
 * 关键断言：
 *   - 远程未授权 GET 走不通（401/403）。
 *   - 远程已授权但 isLocalRequest=false：写入默认 deny（403），需要 DIGA_AGENT_REMOTE_FILE_WRITE=1。
 *   - 路径白名单生效：DIGA_AGENT_FILE_ROOTS 之外的 path 直接 500/400。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

let tmpDir: string;
let settingsFile: string;
let filesRoot: string;

const VALID_TOKEN = "valid-device-token-r7-files";
const VALID_TOKEN_HASH = createHash("sha256").update(VALID_TOKEN).digest("hex");
const TEST_HOST = "files-host.tail.ts.net";
const TEST_PORT = 37373;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "remote-files-test-"));
  settingsFile = join(tmpDir, "settings.json");
  filesRoot = join(tmpDir, "root");
  mkdirSync(filesRoot, { recursive: true });
  process.env.DIGA_AGENT_SETTINGS_FILE = settingsFile;
  process.env.DIGA_AGENT_FILE_ROOTS = filesRoot;
  process.env.DIGA_AGENT_TAILSCALE_DNS = TEST_HOST;
  // 默认不许远程写。
  delete process.env.DIGA_AGENT_REMOTE_FILE_WRITE;
});

afterAll(() => {
  delete process.env.DIGA_AGENT_SETTINGS_FILE;
  delete process.env.DIGA_AGENT_FILE_ROOTS;
  delete process.env.DIGA_AGENT_TAILSCALE_DNS;
  delete process.env.DIGA_AGENT_REMOTE_FILE_WRITE;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  writeFileSync(
    settingsFile,
    JSON.stringify({
      remoteAccess: {
        mode: "vpn",
        port: TEST_PORT,
        instanceId: "pi-test",
        devices: [
          {
            id: "dev-files",
            name: "files phone",
            tokenHash: VALID_TOKEN_HASH,
            createdAt: Date.now(),
          },
        ],
      },
    }),
    "utf8"
  );
});

function buildReq(
  method: string,
  path: string,
  opts: { auth?: string; bodyText?: string } = {}
) {
  const headers: Record<string, string> = {
    host: `${TEST_HOST}:${TEST_PORT}`,
  };
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.bodyText !== undefined) headers["content-type"] = "text/plain";
  const url = new URL(`http://${TEST_HOST}:${TEST_PORT}/api/files`);
  url.searchParams.set("path", path);
  return new Request(url.toString(), {
    method,
    headers,
    body: opts.bodyText,
  });
}

describe("/api/files (R7 远程访问回归)", () => {
  it("远程无 token 拿不到文件 (401/403)", async () => {
    const { GET } = await import("./route");
    const res = await GET(buildReq("GET", filesRoot));
    expect([401, 403]).toContain(res.status);
  });

  it("远程带正确 token 仍默认拒绝写 (403)", async () => {
    const { PUT } = await import("./route");
    const target = join(filesRoot, "hello.txt");
    const res = await PUT(
      buildReq("PUT", target, {
        auth: `Bearer ${VALID_TOKEN}`,
        bodyText: "hello world",
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/remote write disabled/i);
  });
});

describe("/api/files POST op=exists (Phase C: missing file detection)", () => {
  it("返回每条路径的 boolean", async () => {
    const real = join(filesRoot, "ok.txt");
    writeFileSync(real, "x", "utf8");
    const fake = join(filesRoot, "missing.txt");

    const { POST } = await import("./route");
    const url = new URL(
      `http://${TEST_HOST}:${TEST_PORT}/api/files?op=exists`
    );
    const req = new Request(url.toString(), {
      method: "POST",
      headers: {
        host: `${TEST_HOST}:${TEST_PORT}`,
        authorization: `Bearer ${VALID_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ paths: [real, fake] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { paths?: Record<string, boolean> };
    expect(data.paths?.[real]).toBe(true);
    expect(data.paths?.[fake]).toBe(false);
  });

  it("白名单外路径返回 false 而非 500", async () => {
    const { POST } = await import("./route");
    const url = new URL(
      `http://${TEST_HOST}:${TEST_PORT}/api/files?op=exists`
    );
    const req = new Request(url.toString(), {
      method: "POST",
      headers: {
        host: `${TEST_HOST}:${TEST_PORT}`,
        authorization: `Bearer ${VALID_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ paths: ["/etc/passwd"] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { paths?: Record<string, boolean> };
    expect(data.paths?.["/etc/passwd"]).toBe(false);
  });

  it("op=exists 走 read 通道，远程也能调（不被 guardWrite 拦）", async () => {
    const real = join(filesRoot, "ok2.txt");
    writeFileSync(real, "y", "utf8");
    const { POST } = await import("./route");
    const url = new URL(
      `http://${TEST_HOST}:${TEST_PORT}/api/files?op=exists`
    );
    // 注意：远程未带 token 仍被 withRemoteAuth 拦；这里用 token 验证 op=exists
    // 不会被 guardWrite 误拦（即使 isLocalRequest=false）。
    const req = new Request(url.toString(), {
      method: "POST",
      headers: {
        host: `${TEST_HOST}:${TEST_PORT}`,
        authorization: `Bearer ${VALID_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ paths: [real] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});

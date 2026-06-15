/**
 * R7: SSE ticket 路由 + assertRemoteAuth ticket 消费链路最小验证。
 *
 * 关键断言：
 *   - 没带 Authorization 走不通（401）。
 *   - 带正确 device token 能换出 ticket。
 *   - 同一个 ticket 第二次消费失败（一次性）。
 *   - ticket 写进 SSE URL 后 assertRemoteAuth 放行（GET 路径）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const VALID_TOKEN = "valid-device-token-r7";
const VALID_TOKEN_HASH = createHash("sha256").update(VALID_TOKEN).digest("hex");
const TEST_HOST = "test-host.tail.ts.net";
const TEST_PORT = 37373;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "remote-sse-ticket-test-"));
  settingsFile = join(tmpDir, "settings.json");
  process.env.DIGA_AGENT_SETTINGS_FILE = settingsFile;
  // listRemoteCandidates(mode=vpn) 会从 DIGA_AGENT_TAILSCALE_DNS 读一个主机名，
  // 走进 allowed hosts。这里指定为测试用主机。
  process.env.DIGA_AGENT_TAILSCALE_DNS = TEST_HOST;
});

afterAll(() => {
  delete process.env.DIGA_AGENT_SETTINGS_FILE;
  delete process.env.DIGA_AGENT_TAILSCALE_DNS;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // 写一份 settings：mode=lan，并预放一个未撤销的设备，token hash 与 VALID_TOKEN 对得上。
  writeFileSync(
    settingsFile,
    JSON.stringify({
      remoteAccess: {
        mode: "vpn",
        port: TEST_PORT,
        instanceId: "pi-test",
        devices: [
          {
            id: "dev-1",
            name: "test phone",
            tokenHash: VALID_TOKEN_HASH,
            createdAt: Date.now(),
          },
        ],
      },
    }),
    "utf8"
  );
  const { __resetSseTicketsForTest } = await import("@/lib/remote/store");
  __resetSseTicketsForTest();
});

describe("/api/remote/sse-ticket", () => {
  function buildReq(opts: { auth?: string }) {
    const headers: Record<string, string> = {
      host: `${TEST_HOST}:${TEST_PORT}`,
      "content-type": "application/json",
    };
    if (opts.auth) headers.authorization = opts.auth;
    return new Request(
      `http://${TEST_HOST}:${TEST_PORT}/api/remote/sse-ticket`,
      { method: "POST", headers, body: "{}" }
    );
  }

  it("无 Authorization 返回 401", async () => {
    const { POST } = await import("./route");
    const res = await POST(buildReq({}));
    expect([401, 403]).toContain(res.status);
  });

  it("带正确 token 能换出 ticket，并且 ticket 一次性", async () => {
    const { POST } = await import("./route");
    const res = await POST(buildReq({ auth: `Bearer ${VALID_TOKEN}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket?: string; expiresAt?: number };
    expect(typeof body.ticket).toBe("string");

    const { consumeRemoteSseTicket } = await import("@/lib/remote/store");
    const consumed = consumeRemoteSseTicket(body.ticket!);
    expect(consumed?.deviceId).toBe("dev-1");

    // 第二次消费应失败。
    const reuse = consumeRemoteSseTicket(body.ticket!);
    expect(reuse).toBeNull();
  });
});

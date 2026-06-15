/**
 * R7: runtime 验证 /api/remote/ping 是公开 health endpoint。
 *
 * 关键断言：
 *   - 远程未授权请求（无 token、host 是公网）也能拿 200。
 *   - withRemoteAuth 不会再让这条路由依赖 RemoteAccessSettings.mode。
 *
 * 仅做最小 fetch 调用，把 settings 文件指到 tmp 防止污染开发机。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "remote-ping-test-"));
  settingsFile = join(tmpDir, "settings.json");
  process.env.DIGA_AGENT_SETTINGS_FILE = settingsFile;
});

afterAll(() => {
  delete process.env.DIGA_AGENT_SETTINGS_FILE;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // settings.mode = off + 没有 token，模拟“远程访问没开”最严格状态。
  // 即便如此，ping 也应该 200，因为它是公开 health probe。
  writeFileSync(
    settingsFile,
    JSON.stringify({
      remoteAccess: {
        mode: "off",
        port: 37373,
        instanceId: "pi-test",
        devices: [],
      },
    }),
    "utf8"
  );
});

describe("GET /api/remote/ping", () => {
  it("是公开 health endpoint：远程无 token 也返回 200", async () => {
    const { GET } = await import("./route");
    const req = new Request("http://example.com/api/remote/ping", {
      method: "GET",
      headers: { host: "phone.example.com" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  });
});

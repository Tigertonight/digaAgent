import { mkdtempSync, rmSync } from "node:fs";
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
const TEST_LOCAL_SECRET = "vitest-budget-secret";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "budget-route-test-"));
  settingsFile = join(tmpDir, "settings.json");
  process.env.DIGA_AGENT_SETTINGS_FILE = settingsFile;
  process.env.DIGA_AGENT_LOCAL_SECRET = TEST_LOCAL_SECRET;
});

afterAll(() => {
  delete process.env.DIGA_AGENT_SETTINGS_FILE;
  delete process.env.DIGA_AGENT_LOCAL_SECRET;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  try {
    rmSync(settingsFile, { force: true });
  } catch {
    /* ignore */
  }
});

function localReq(method: string, body?: unknown) {
  const headers: Record<string, string> = {
    host: "localhost:3000",
    "x-diga-agent-local-secret": TEST_LOCAL_SECRET,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request("http://localhost:3000/api/budget-settings", {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("/api/budget-settings", () => {
  it("GET 默认返回不限流 (DEFAULT_BUDGET)", async () => {
    const { GET } = await import("./route");
    const res = await GET(localReq("GET"));
    expect(res.status).toBe(200);
    const d = (await res.json()) as { budget?: { action?: string; maxCostUsd?: number } };
    expect(d.budget?.action).toBe("pause");
    expect(d.budget?.maxCostUsd).toBeUndefined();
  });

  it("PATCH 写入后 GET 返回最新值", async () => {
    const { GET, PATCH } = await import("./route");
    const patchRes = await PATCH(
      localReq("PATCH", { budget: { maxCostUsd: 7, action: "stop" } })
    );
    expect(patchRes.status).toBe(200);
    const patchData = (await patchRes.json()) as { budget?: { maxCostUsd?: number; action?: string } };
    expect(patchData.budget?.maxCostUsd).toBe(7);
    expect(patchData.budget?.action).toBe("stop");

    const getRes = await GET(localReq("GET"));
    const getData = (await getRes.json()) as { budget?: { maxCostUsd?: number; action?: string } };
    expect(getData.budget?.maxCostUsd).toBe(7);
    expect(getData.budget?.action).toBe("stop");
  });

  it("PATCH 不合法 JSON 返回 400", async () => {
    const { PATCH } = await import("./route");
    const req = new Request("http://localhost:3000/api/budget-settings", {
      method: "PATCH",
      headers: {
        host: "localhost:3000",
        "x-diga-agent-local-secret": TEST_LOCAL_SECRET,
        "content-type": "application/json",
      },
      body: "not-json",
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });
});

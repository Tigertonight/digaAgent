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
const TEST_LOCAL_SECRET = "vitest-last-model-secret";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "last-model-route-test-"));
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
  return new Request("http://localhost:3000/api/preferences/last-model", {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("/api/preferences/last-model", () => {
  it("初次 GET → null", async () => {
    const { GET } = await import("./route");
    const res = await GET(localReq("GET"));
    expect(res.status).toBe(200);
    const d = (await res.json()) as { lastModel?: unknown };
    expect(d.lastModel).toBeNull();
  });

  it("PATCH 写入后再 GET 返回最新", async () => {
    const { GET, PATCH } = await import("./route");
    const patch = await PATCH(
      localReq("PATCH", {
        lastModel: { provider: "anthropic", modelId: "claude-sonnet-4" },
      })
    );
    expect(patch.status).toBe(200);
    const data = (await patch.json()) as {
      lastModel?: { provider?: string; modelId?: string };
    };
    expect(data.lastModel?.provider).toBe("anthropic");
    expect(data.lastModel?.modelId).toBe("claude-sonnet-4");

    const get = await GET(localReq("GET"));
    const got = (await get.json()) as {
      lastModel?: { provider?: string; modelId?: string };
    };
    expect(got.lastModel?.provider).toBe("anthropic");
    expect(got.lastModel?.modelId).toBe("claude-sonnet-4");
  });

  it("PATCH 顶层（不带 lastModel 包裹）也接受", async () => {
    const { PATCH } = await import("./route");
    const r = await PATCH(
      localReq("PATCH", { provider: "p1", modelId: "m1" })
    );
    expect(r.status).toBe(200);
    const d = (await r.json()) as {
      lastModel?: { provider?: string; modelId?: string };
    };
    expect(d.lastModel?.provider).toBe("p1");
  });

  it("DELETE 清除", async () => {
    const { DELETE, GET, PATCH } = await import("./route");
    await PATCH(localReq("PATCH", { provider: "p", modelId: "m" }));
    const del = await DELETE(localReq("DELETE"));
    expect(del.status).toBe(200);
    const get = await GET(localReq("GET"));
    const d = (await get.json()) as { lastModel?: unknown };
    expect(d.lastModel).toBeNull();
  });

  it("PATCH 非法 JSON → 400", async () => {
    const { PATCH } = await import("./route");
    const req = new Request(
      "http://localhost:3000/api/preferences/last-model",
      {
        method: "PATCH",
        headers: {
          host: "localhost:3000",
          "x-diga-agent-local-secret": TEST_LOCAL_SECRET,
          "content-type": "application/json",
        },
        body: "not-json",
      }
    );
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });
});

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { clearLastModel, getLastModel, setLastModel } from "./last-model";

let tmpDir: string;
let settingsFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "last-model-store-"));
  settingsFile = join(tmpDir, "settings.json");
  process.env.DIGA_AGENT_SETTINGS_FILE = settingsFile;
});

afterAll(() => {
  delete process.env.DIGA_AGENT_SETTINGS_FILE;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  try {
    rmSync(settingsFile, { force: true });
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  try {
    rmSync(settingsFile, { force: true });
  } catch {
    /* ignore */
  }
});

describe("last-model server-store", () => {
  it("无文件 → null", async () => {
    expect(await getLastModel()).toBeNull();
  });

  it("写入 + 读取一致", async () => {
    await setLastModel({ provider: "anthropic", modelId: "claude-sonnet-4" });
    const got = await getLastModel();
    expect(got?.provider).toBe("anthropic");
    expect(got?.modelId).toBe("claude-sonnet-4");
    expect(typeof got?.updatedAt).toBe("number");
  });

  it("不破坏其他 envelope 字段（与 budget 等共存）", async () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({ remoteAccess: { mode: "lan", port: 37373 } })
    );
    await setLastModel({ provider: "p1", modelId: "m1" });
    const env = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(env.remoteAccess.mode).toBe("lan");
    expect(env.remoteAccess.port).toBe(37373);
    expect(env.lastModel.provider).toBe("p1");
  });

  it("缺字段 → 返回 null（不抛错）", async () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({ lastModel: { provider: "p1" } })
    );
    expect(await getLastModel()).toBeNull();
  });

  it("非对象的脏数据 → null", async () => {
    writeFileSync(settingsFile, JSON.stringify({ lastModel: 42 }));
    expect(await getLastModel()).toBeNull();
  });

  it("传空 provider/modelId 视为清除", async () => {
    await setLastModel({ provider: "p1", modelId: "m1" });
    await setLastModel({ provider: "", modelId: "x" });
    expect(await getLastModel()).toBeNull();
  });

  it("clearLastModel 清掉但保留其他字段", async () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({
        remoteAccess: { mode: "off" },
        lastModel: { provider: "p", modelId: "m", updatedAt: 1 },
      })
    );
    await clearLastModel();
    const env = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(env.lastModel).toBeUndefined();
    expect(env.remoteAccess.mode).toBe("off");
  });

  it("partial 更新（仅 provider）→ 保留旧 modelId 不写入", async () => {
    await setLastModel({ provider: "p1", modelId: "m1" });
    // 仅传 provider（无 modelId）→ 视为非法，返回当前值不变
    const r = await setLastModel({ provider: "p2" });
    expect(r?.provider).toBe("p1");
    expect(r?.modelId).toBe("m1");
  });
});

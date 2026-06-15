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
import { getBudgetSettings, updateBudgetSettings } from "./server-store";

let tmpDir: string;
let settingsFile: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "budget-store-test-"));
  settingsFile = join(tmpDir, "settings.json");
  process.env.DIGA_AGENT_SETTINGS_FILE = settingsFile;
});

afterAll(() => {
  delete process.env.DIGA_AGENT_SETTINGS_FILE;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个 case 都是一份干净的 settings.json
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

describe("budget server-store", () => {
  it("文件不存在时 getBudgetSettings 返回 DEFAULT（不限流）", async () => {
    const b = await getBudgetSettings();
    expect(b.maxCostUsd).toBeUndefined();
    expect(b.maxTurns).toBeUndefined();
    expect(b.maxDurationSec).toBeUndefined();
    expect(b.action).toBe("pause");
  });

  it("settings.json 已有非 budget 字段也不影响默认", async () => {
    writeFileSync(settingsFile, JSON.stringify({ remoteAccess: { mode: "off" } }));
    const b = await getBudgetSettings();
    expect(b.maxCostUsd).toBeUndefined();
    expect(b.action).toBe("pause");
  });

  it("update 写盘后 read 一致；只覆盖 budget 字段", async () => {
    writeFileSync(
      settingsFile,
      JSON.stringify({ remoteAccess: { mode: "lan", port: 37373 } })
    );
    const next = await updateBudgetSettings({
      maxCostUsd: 12,
      maxTurns: 50,
      maxDurationSec: 0, // 0 视为不启用
      action: "stop",
    });
    expect(next.maxCostUsd).toBe(12);
    expect(next.maxTurns).toBe(50);
    expect(next.maxDurationSec).toBeUndefined();
    expect(next.action).toBe("stop");

    // re-read
    const b = await getBudgetSettings();
    expect(b.maxCostUsd).toBe(12);
    expect(b.maxTurns).toBe(50);
    expect(b.action).toBe("stop");

    // 其它字段保留
    const env = JSON.parse(readFileSync(settingsFile, "utf8"));
    expect(env.remoteAccess.mode).toBe("lan");
    expect(env.remoteAccess.port).toBe(37373);
  });

  it("update 接受 partial：只改 action 不动其它维度", async () => {
    await updateBudgetSettings({ maxCostUsd: 8 });
    const next = await updateBudgetSettings({ action: "stop" });
    expect(next.maxCostUsd).toBe(8);
    expect(next.action).toBe("stop");
  });

  it("update 接受不合法值，不会污染：负数 / NaN / 字符串", async () => {
    const next = await updateBudgetSettings({
      maxCostUsd: -1,
      maxTurns: NaN,
      // @ts-expect-error 意外类型
      maxDurationSec: "oops",
      action: "pause",
    });
    expect(next.maxCostUsd).toBeUndefined();
    expect(next.maxTurns).toBeUndefined();
    expect(next.maxDurationSec).toBeUndefined();
    expect(next.action).toBe("pause");
  });
});

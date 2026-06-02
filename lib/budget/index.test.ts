import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vitest 配置是 environment: node，这里手动 mock 一个最小化的 localStorage，
// 让 lib/budget/index.ts 里的 SSR 守护（typeof window === 'undefined' 时返回 null）
// 走另一条分支，从而覆盖到持久化代码。
const createMemoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
  };
};

vi.stubGlobal("window", { localStorage: createMemoryStorage() });

import {
  BUDGET_OVERRIDE_KEY_PREFIX,
  BUDGET_STORAGE_KEY,
  DEFAULT_BUDGET,
  clearSessionOverride,
  evaluateBudget,
  loadGlobalBudget,
  loadSessionOverride,
  normalizeBudget,
  resolveBudget,
  saveGlobalBudget,
  saveSessionOverride,
} from "./index";
import type { SessionBudget } from "./types";

/* ===================== evaluateBudget ===================== */

describe("evaluateBudget", () => {
  const fullBudget: SessionBudget = {
    maxCostUsd: 5,
    maxTurns: 30,
    maxDurationSec: 600,
    action: "pause",
  };

  it("零消耗：所有 remaining 等于 budget，triggered 为空", () => {
    const s = evaluateBudget(fullBudget, {
      costUsd: 0,
      turns: 0,
      durationSec: 0,
    });
    expect(s.remaining).toEqual({
      costUsd: 5,
      turns: 30,
      durationSec: 600,
    });
    expect(s.triggered).toEqual([]);
  });

  it("部分消耗未超：triggered 仍为空", () => {
    const s = evaluateBudget(fullBudget, {
      costUsd: 2,
      turns: 10,
      durationSec: 100,
    });
    expect(s.remaining).toEqual({
      costUsd: 3,
      turns: 20,
      durationSec: 500,
    });
    expect(s.triggered).toEqual([]);
  });

  it("仅 cost 超：triggered = ['cost']，对应 remaining <= 0", () => {
    const s = evaluateBudget(fullBudget, {
      costUsd: 5.01,
      turns: 1,
      durationSec: 10,
    });
    expect(s.triggered).toEqual(["cost"]);
    expect(s.remaining.costUsd).toBeLessThanOrEqual(0);
  });

  it("三维都超：triggered 按 cost > turns > duration 顺序", () => {
    const s = evaluateBudget(fullBudget, {
      costUsd: 6,
      turns: 31,
      durationSec: 700,
    });
    expect(s.triggered).toEqual(["cost", "turns", "duration"]);
  });

  it("边界 = 上限：视为已触发（<= 0 判定）", () => {
    const s = evaluateBudget(fullBudget, {
      costUsd: 5,
      turns: 30,
      durationSec: 600,
    });
    expect(s.triggered).toEqual(["cost", "turns", "duration"]);
    expect(s.remaining.costUsd).toBe(0);
  });

  it("未启用的维度不出现在 remaining / triggered 里", () => {
    const partial: SessionBudget = {
      maxCostUsd: 5,
      action: "stop",
      // maxTurns / maxDurationSec 未设
    };
    const s = evaluateBudget(partial, {
      costUsd: 1,
      turns: 999,
      durationSec: 9999,
    });
    expect(s.remaining).toEqual({ costUsd: 4 });
    expect(s.triggered).toEqual([]);
  });

  it("未启用维度即使 spent 极大也不会触发", () => {
    const noLimits: SessionBudget = { action: "pause" };
    const s = evaluateBudget(noLimits, {
      costUsd: 1000,
      turns: 1000,
      durationSec: 100000,
    });
    expect(s.triggered).toEqual([]);
    expect(s.remaining).toEqual({});
  });

  it("0 / 负数 / NaN 视为未启用", () => {
    const garbage: SessionBudget = {
      maxCostUsd: 0,
      maxTurns: -1,
      maxDurationSec: NaN,
      action: "pause",
    };
    const s = evaluateBudget(garbage, {
      costUsd: 100,
      turns: 100,
      durationSec: 100,
    });
    expect(s.triggered).toEqual([]);
    expect(s.remaining).toEqual({});
  });
});

/* ===================== normalizeBudget ===================== */

describe("normalizeBudget", () => {
  it("空对象 → action 默认 pause，三维 undefined", () => {
    expect(normalizeBudget({})).toEqual({
      maxCostUsd: undefined,
      maxTurns: undefined,
      maxDurationSec: undefined,
      action: "pause",
    });
  });

  it("null / undefined → 等价于空对象", () => {
    expect(normalizeBudget(null)).toEqual(normalizeBudget({}));
    expect(normalizeBudget(undefined)).toEqual(normalizeBudget({}));
  });

  it("合法值原样保留", () => {
    expect(
      normalizeBudget({
        maxCostUsd: 3,
        maxTurns: 20,
        maxDurationSec: 300,
        action: "stop",
      })
    ).toEqual({
      maxCostUsd: 3,
      maxTurns: 20,
      maxDurationSec: 300,
      action: "stop",
    });
  });

  it("字符串数字会被转换", () => {
    expect(
      (normalizeBudget({ maxCostUsd: "2.5" }) as SessionBudget).maxCostUsd
    ).toBe(2.5);
  });

  it("不合法数字置 undefined", () => {
    const r = normalizeBudget({
      maxCostUsd: -1,
      maxTurns: 0,
      maxDurationSec: "abc",
    });
    expect(r.maxCostUsd).toBeUndefined();
    expect(r.maxTurns).toBeUndefined();
    expect(r.maxDurationSec).toBeUndefined();
  });

  it("非法 action 回退 pause", () => {
    expect(normalizeBudget({ action: "destroy" }).action).toBe("pause");
    expect(normalizeBudget({ action: 42 }).action).toBe("pause");
  });

  it("不认识的字段忽略", () => {
    const r = normalizeBudget({
      maxCostUsd: 1,
      action: "stop",
      extraJunk: "ignored",
    }) as SessionBudget & { extraJunk?: unknown };
    expect(r.extraJunk).toBeUndefined();
  });
});

/* ===================== localStorage helpers ===================== */

describe("localStorage helpers", () => {
  beforeEach(() => {
    // 每个 case 跑前清干净
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  describe("loadGlobalBudget / saveGlobalBudget", () => {
    it("读不到时返回 DEFAULT_BUDGET", () => {
      expect(loadGlobalBudget()).toEqual(DEFAULT_BUDGET);
    });

    it("写后能读回，且经过 normalize", () => {
      saveGlobalBudget({
        maxCostUsd: 10,
        maxTurns: 50,
        maxDurationSec: 1200,
        action: "stop",
      });
      expect(loadGlobalBudget()).toEqual({
        maxCostUsd: 10,
        maxTurns: 50,
        maxDurationSec: 1200,
        action: "stop",
      });
    });

    it("损坏 JSON 回退 DEFAULT_BUDGET", () => {
      window.localStorage.setItem(BUDGET_STORAGE_KEY, "{{not json");
      expect(loadGlobalBudget()).toEqual(DEFAULT_BUDGET);
    });

    it("save 会自动 normalize（脏数据进 → 干净数据出）", () => {
      saveGlobalBudget({
        maxCostUsd: -5,
        maxTurns: 30,
        maxDurationSec: NaN,
        action: "pause",
      });
      const loaded = loadGlobalBudget();
      expect(loaded.maxCostUsd).toBeUndefined();
      expect(loaded.maxTurns).toBe(30);
      expect(loaded.maxDurationSec).toBeUndefined();
    });
  });

  describe("loadSessionOverride / saveSessionOverride / clearSessionOverride", () => {
    it("无 override 时返回 null", () => {
      expect(loadSessionOverride("a-1")).toBeNull();
    });

    it("写后可读回；不同 agentId 互不影响", () => {
      saveSessionOverride("a-1", {
        maxCostUsd: 2,
        action: "stop",
      });
      saveSessionOverride("a-2", {
        maxCostUsd: 9,
        action: "pause",
      });
      expect(loadSessionOverride("a-1")?.maxCostUsd).toBe(2);
      expect(loadSessionOverride("a-2")?.maxCostUsd).toBe(9);
    });

    it("clear 后回到 null", () => {
      saveSessionOverride("a-x", { maxCostUsd: 1, action: "pause" });
      expect(loadSessionOverride("a-x")).not.toBeNull();
      clearSessionOverride("a-x");
      expect(loadSessionOverride("a-x")).toBeNull();
    });

    it("使用约定的 key 前缀（避免与其他 localStorage 冲突）", () => {
      saveSessionOverride("xyz", { action: "pause" });
      expect(
        window.localStorage.getItem(BUDGET_OVERRIDE_KEY_PREFIX + "xyz")
      ).not.toBeNull();
    });

    it("损坏 JSON 视为不存在", () => {
      window.localStorage.setItem(BUDGET_OVERRIDE_KEY_PREFIX + "bad", "garbage{");
      expect(loadSessionOverride("bad")).toBeNull();
    });
  });

  describe("resolveBudget（override > global > DEFAULT）", () => {
    it("无任何配置 → DEFAULT_BUDGET", () => {
      expect(resolveBudget("any")).toEqual(DEFAULT_BUDGET);
    });

    it("只有全局 → 用全局", () => {
      saveGlobalBudget({ maxCostUsd: 8, action: "stop" });
      expect(resolveBudget("any")).toEqual({
        maxCostUsd: 8,
        maxTurns: undefined,
        maxDurationSec: undefined,
        action: "stop",
      });
    });

    it("session override 优先于全局", () => {
      saveGlobalBudget({ maxCostUsd: 8, action: "stop" });
      saveSessionOverride("a-1", { maxCostUsd: 1, action: "pause" });
      expect(resolveBudget("a-1").maxCostUsd).toBe(1);
      expect(resolveBudget("a-1").action).toBe("pause");
      // 其他 session 仍用全局
      expect(resolveBudget("a-2").maxCostUsd).toBe(8);
    });

    it("agentId 为 null → 不查 override，直接用全局", () => {
      saveSessionOverride("a-1", { maxCostUsd: 1, action: "pause" });
      saveGlobalBudget({ maxCostUsd: 8, action: "stop" });
      expect(resolveBudget(null).maxCostUsd).toBe(8);
    });
  });
});

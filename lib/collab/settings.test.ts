/**
 * lib/collab/settings.test.ts —— CollabSettings load/save 测试（RFC-2 Phase B4）。
 *
 * 范式参考 lib/budget/index.test.ts：
 *   - vitest environment 是 node，需要 vi.stubGlobal('window', ...) 注入 localStorage。
 *   - 每个 case 之前清掉 store，避免相互污染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLAB_STORAGE_KEY,
  DEFAULT_COLLAB_SETTINGS,
  loadCollabSettings,
  rulesExcluding,
  saveCollabSettings,
} from "./settings";
import type { ApprovalRule } from "./types";

interface MockStorage {
  store: Map<string, string>;
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
}

function makeStorage(): MockStorage {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
    removeItem: (k) => {
      store.delete(k);
    },
  };
}

describe("collab/settings", () => {
  let storage: MockStorage;

  beforeEach(() => {
    storage = makeStorage();
    vi.stubGlobal("window", { localStorage: storage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("loadCollabSettings", () => {
    it("空 store 返回 DEFAULT（enabled: true，safe-by-default）", () => {
      expect(loadCollabSettings()).toEqual(DEFAULT_COLLAB_SETTINGS);
    });

    it("已存合法值能读回", () => {
      storage.store.set(COLLAB_STORAGE_KEY, JSON.stringify({ enabled: false }));
      expect(loadCollabSettings().enabled).toBe(false);
    });

    it("非法 JSON → 回退 DEFAULT", () => {
      storage.store.set(COLLAB_STORAGE_KEY, "not-json{");
      expect(loadCollabSettings()).toEqual(DEFAULT_COLLAB_SETTINGS);
    });

    it("缺字段 → 用 DEFAULT 兜底", () => {
      storage.store.set(COLLAB_STORAGE_KEY, JSON.stringify({}));
      expect(loadCollabSettings().enabled).toBe(true);
    });

    it("非 boolean enabled → 用 DEFAULT 兜底", () => {
      storage.store.set(
        COLLAB_STORAGE_KEY,
        JSON.stringify({ enabled: "yes" })
      );
      expect(loadCollabSettings().enabled).toBe(true);
    });
  });

  describe("saveCollabSettings", () => {
    it("写入后能读回", () => {
      saveCollabSettings({ enabled: false });
      expect(loadCollabSettings().enabled).toBe(false);
    });

    it("无 window 环境（SSR）静默 noop", () => {
      vi.unstubAllGlobals();
      // 不再 stub window —— 模拟 SSR
      expect(() => saveCollabSettings({ enabled: false })).not.toThrow();
      expect(loadCollabSettings()).toEqual(DEFAULT_COLLAB_SETTINGS);
    });
  });

  describe("rulesExcluding", () => {
    const rules: ApprovalRule[] = [
      {
        id: "rule-a",
        name: "A",
        match: { toolName: "bash" },
        on: "ask",
      },
      {
        id: "rule-b",
        name: "B",
        match: { toolName: "edit" },
        on: "ask",
      },
    ];

    it("空 remembered 集合返回全部规则", () => {
      expect(rulesExcluding(rules, new Set())).toEqual(rules);
    });

    it("过滤掉被记忆的 ruleId", () => {
      const r = rulesExcluding(rules, new Set(["rule-a"]));
      expect(r).toHaveLength(1);
      expect(r[0].id).toBe("rule-b");
    });
  });
});

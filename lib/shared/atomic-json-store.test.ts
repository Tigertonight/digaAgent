import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteFileSync,
  createAtomicJsonStore,
} from "./atomic-json-store";

interface Item {
  id: string;
  status: "running" | "done";
  value: number;
}

describe("createAtomicJsonStore", () => {
  let root: string;
  const make = () =>
    createAtomicJsonStore<Item>({
      segments: ["test-store", "items"],
      idOf: (item) => item.id,
      sanitize: (raw) => {
        if (!raw || typeof raw !== "object") return null;
        const rec = raw as Record<string, unknown>;
        if (typeof rec.id !== "string") return null;
        return rec as unknown as Item;
      },
      onHydrate: (item, now) => {
        if (item.status === "running") {
          return { ...item, status: "done", value: item.value + now * 0 };
        }
        return item;
      },
    });

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "atomic-store-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("persists and reads back via hydrateAll", () => {
    const store = make();
    store.__setRootForTest(root);
    store.persist({ id: "a", status: "done", value: 1 });
    store.persist({ id: "b", status: "done", value: 2 });

    const items = store.hydrateAll().sort((x, y) => x.id.localeCompare(y.id));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: "a", value: 1 });
  });

  it("applies onHydrate downgrade (running -> done)", () => {
    const store = make();
    store.__setRootForTest(root);
    store.persist({ id: "x", status: "running", value: 5 });

    const [item] = store.hydrateAll();
    expect(item.status).toBe("done");
  });

  it("rejects unsafe ids", () => {
    const store = make();
    store.__setRootForTest(root);
    expect(() => store.filePath("../escape")).toThrow(/invalid/);
    expect(() => store.filePath("a/b")).toThrow(/invalid/);
  });

  it("skips corrupt files without throwing", () => {
    const store = make();
    store.__setRootForTest(root);
    store.persist({ id: "good", status: "done", value: 1 });
    // write a corrupt file directly
    atomicWriteFileSync(store.filePath("bad"), "{ not json", "test");

    const items = store.hydrateAll();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("good");
  });

  it("removes a file", () => {
    const store = make();
    store.__setRootForTest(root);
    store.persist({ id: "a", status: "done", value: 1 });
    const fp = store.filePath("a");
    expect(existsSync(fp)).toBe(true);
    store.remove("a");
    expect(existsSync(fp)).toBe(false);
  });

  describe("debounced writes", () => {
    it("flush() forces pending debounced writes to disk with latest value", () => {
      const store = make();
      store.__setRootForTest(root);
      const live: Item = { id: "d", status: "running", value: 0 };
      // simulate multiple rapid updates resolving to the latest live object
      live.value = 1;
      store.persistDebounced(live, () => live);
      live.value = 2;
      store.persistDebounced(live, () => live);
      live.value = 3;
      store.persistDebounced(live, () => live);

      // not yet flushed (debounce window not elapsed)
      const fp = store.filePath("d");
      // flush synchronously
      store.flush();
      expect(existsSync(fp)).toBe(true);
      const saved = JSON.parse(readFileSync(fp, "utf8"));
      expect(saved.value).toBe(3); // latest value, single write
    });

    it("flush(id) only flushes that id", () => {
      const store = make();
      store.__setRootForTest(root);
      const a: Item = { id: "a", status: "done", value: 1 };
      const b: Item = { id: "b", status: "done", value: 2 };
      store.persistDebounced(a, () => a);
      store.persistDebounced(b, () => b);
      store.flush("a");
      expect(existsSync(store.filePath("a"))).toBe(true);
      expect(existsSync(store.filePath("b"))).toBe(false);
      store.flush();
      expect(existsSync(store.filePath("b"))).toBe(true);
    });

    it("debounce window eventually flushes automatically", async () => {
      const store = make();
      store.__setRootForTest(root);
      const a: Item = { id: "auto", status: "done", value: 9 };
      store.persistDebounced(a, () => a);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(existsSync(store.filePath("auto"))).toBe(true);
    });
  });
});

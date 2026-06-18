/**
 * RFC-3 Phase A1：lib/meta/store 单测。
 *
 * 用 tmp dir 隔离，setup 时 __setMetaRootForTests 覆盖根目录，afterEach 清理。
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __setMetaRootForTests,
  batchReadMeta,
  deleteMeta,
  readMeta,
  updateMeta,
  writeMeta,
} from "./store";
import type { SessionMeta } from "./types";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diga-agent-meta-test-"));
  __setMetaRootForTests(tmpRoot);
});

afterEach(async () => {
  __setMetaRootForTests(null);
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("readMeta", () => {
  it("returns null when file does not exist", async () => {
    const m = await readMeta("nope-id");
    expect(m).toBeNull();
  });

  it("returns null when file is corrupted (invalid JSON)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.mkdir(path.join(tmpRoot, "sessions"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "sessions", "bad.meta.json"),
      "{not valid json",
      "utf8"
    );
    const m = await readMeta("bad");
    expect(m).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[meta] failed to parse session meta",
      expect.objectContaining({ sessionId: "bad" })
    );
    warn.mockRestore();
  });

  it("ignores unknown fields (forward compat)", async () => {
    await fs.mkdir(path.join(tmpRoot, "sessions"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "sessions", "abc.meta.json"),
      JSON.stringify({
        id: "abc",
        title: "kept",
        evilField: "should be dropped",
        __proto__: { polluted: true },
      }),
      "utf8"
    );
    const m = await readMeta("abc");
    expect(m).not.toBeNull();
    expect(m!.title).toBe("kept");
    expect((m as unknown as Record<string, unknown>).evilField).toBeUndefined();
  });
});

describe("writeMeta + readMeta round-trip", () => {
  it("writes then reads back the same value", async () => {
    const meta: SessionMeta = {
      id: "rt-1",
      title: "我的 session",
      pinned: true,
      lastSeenAt: 1_789_000_000_000,
      labels: ["bug-fix", "ui"],
    };
    await writeMeta(meta);
    const got = await readMeta("rt-1");
    expect(got).toEqual({
      id: "rt-1",
      title: "我的 session",
      pinned: true,
      lastSeenAt: 1_789_000_000_000,
      labels: ["bug-fix", "ui"],
    });
  });

  it("overwrites existing meta (no merge in store layer)", async () => {
    await writeMeta({ id: "ov", title: "v1", pinned: true });
    await writeMeta({ id: "ov", title: "v2" }); // pinned 应该没了
    const got = await readMeta("ov");
    expect(got).toEqual({ id: "ov", title: "v2" });
  });

  it("rejects empty id", async () => {
    await expect(writeMeta({ id: "" })).rejects.toThrow();
  });

  it("rejects path-traversal id", async () => {
    await expect(writeMeta({ id: "../escape" })).rejects.toThrow();
  });
});

describe("atomic write", () => {
  it("does not leave .tmp residue on success", async () => {
    await writeMeta({ id: "atom", title: "ok" });
    const files = await fs.readdir(path.join(tmpRoot, "sessions"));
    // 只该有 atom.meta.json 一个文件
    expect(files).toEqual(["atom.meta.json"]);
  });
});

describe("batchReadMeta", () => {
  it("returns empty map for empty input", async () => {
    const m = await batchReadMeta([]);
    expect(m.size).toBe(0);
  });

  it("returns only ids that have a meta file", async () => {
    await writeMeta({ id: "has-1", title: "a" });
    await writeMeta({ id: "has-2", title: "b" });
    const m = await batchReadMeta(["has-1", "missing", "has-2"]);
    expect(m.size).toBe(2);
    expect(m.get("has-1")?.title).toBe("a");
    expect(m.get("has-2")?.title).toBe("b");
    expect(m.has("missing")).toBe(false);
  });
});

describe("updateMeta (S1: atomic partial merge under per-id lock)", () => {
  it("merges patch into existing meta without dropping other fields", async () => {
    await writeMeta({ id: "u1", title: "orig", pinned: false });
    const merged = await updateMeta("u1", { pinned: true });
    expect(merged).toEqual({ id: "u1", title: "orig", pinned: true });
    expect(await readMeta("u1")).toEqual({ id: "u1", title: "orig", pinned: true });
  });

  it("creates meta when none exists", async () => {
    const merged = await updateMeta("u2", { title: "new" });
    expect(merged).toEqual({ id: "u2", title: "new" });
  });

  it("does not lose fields under concurrent updates of different fields", async () => {
    await writeMeta({ id: "race", title: "t0", pinned: false });
    // 两个并发更新不同字段：无锁的 read-merge-write 会让后写者覆盖前写者、丢字段。
    // 有锁后两者串行，最终既有 pinned 又有新 title。
    await Promise.all([
      updateMeta("race", { pinned: true }),
      updateMeta("race", { title: "t1" }),
    ]);
    const got = await readMeta("race");
    expect(got?.pinned).toBe(true);
    expect(got?.title).toBe("t1");
  });

  it("serializes many concurrent updates (last writer of each field wins, none lost)", async () => {
    await writeMeta({ id: "many", title: "base" });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        updateMeta("many", { lastSeenAt: 1_700_000_000_000 + i })
      )
    );
    const got = await readMeta("many");
    // title 始终保留；lastSeenAt 是某次合法写入（不丢、不损坏）。
    expect(got?.title).toBe("base");
    expect(typeof got?.lastSeenAt).toBe("number");
  });
});

describe("deleteMeta", () => {
  it("removes existing meta file", async () => {
    await writeMeta({ id: "del", title: "x" });
    await deleteMeta("del");
    expect(await readMeta("del")).toBeNull();
  });

  it("is idempotent (no throw when file does not exist)", async () => {
    await expect(deleteMeta("never-existed")).resolves.toBeUndefined();
  });
});

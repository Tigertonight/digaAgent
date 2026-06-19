/**
 * atomic.ts 单元测试。覆盖：
 * - 基本 write / read 一致
 * - 并发同 key 串行（最后写为准、内容可解析）
 * - ENOSPC 重抛
 * - 中间目录缺（ENOENT）自动 mkdirp 重试
 * - cleanupStaleTmpFiles 仅清超过 ttl 的孤儿
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __resetAtomicLocksForTests,
  atomicWriteJson,
  cleanupStaleTmpFiles,
} from "./atomic";

let tmpRoot: string;

beforeEach(async () => {
  __resetAtomicLocksForTests();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "diga-atomic-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("atomicWriteJson", () => {
  it("写入后可被 readFile + JSON.parse 还原", async () => {
    const fp = path.join(tmpRoot, "a.json");
    await atomicWriteJson(fp, { hello: 1 });
    const text = await fs.readFile(fp, "utf8");
    expect(JSON.parse(text)).toEqual({ hello: 1 });
  });

  it("并发同 key 串行：100 次写后内容必然可解析", async () => {
    const fp = path.join(tmpRoot, "b.json");
    const writes = Array.from({ length: 100 }, (_, i) =>
      atomicWriteJson(fp, { i }),
    );
    await Promise.all(writes);
    const text = await fs.readFile(fp, "utf8");
    const parsed = JSON.parse(text) as { i: number };
    // 不要求顺序一定为 99（race 实现允许调度乱序），但必须是合法 JSON 且 i 落在 0..99
    expect(parsed.i).toBeGreaterThanOrEqual(0);
    expect(parsed.i).toBeLessThanOrEqual(99);
  });

  it("中间目录缺时自动 mkdirp 重试一次", async () => {
    const fp = path.join(tmpRoot, "nested", "deeper", "c.json");
    await expect(atomicWriteJson(fp, { ok: 1 })).resolves.toBeUndefined();
    expect(JSON.parse(await fs.readFile(fp, "utf8"))).toEqual({ ok: 1 });
  });

  it("ENOSPC 必须重抛而非静默吞", async () => {
    const fp = path.join(tmpRoot, "d.json");
    type FsOpen = typeof fs.open;
    const realOpen: FsOpen = fs.open;
    const spy = vi.spyOn(fs, "open").mockImplementation(
      (async (...args: Parameters<FsOpen>) => {
        const handle = await realOpen(...args);
        // 重写 writeFile 模拟下层 ENOSPC；本调用链中原 writeFile 不会被使用。
        handle.writeFile = async () => {
          const e = new Error("simulated ENOSPC") as NodeJS.ErrnoException;
          e.code = "ENOSPC";
          throw e;
        };
        return handle;
      }) as unknown as FsOpen,
    );
    await expect(atomicWriteJson(fp, { x: 1 })).rejects.toMatchObject({
      code: "ENOSPC",
    });
    spy.mockRestore();
  });

  it("不会留下未清理的 tmp 文件（成功路径）", async () => {
    const fp = path.join(tmpRoot, "e.json");
    await atomicWriteJson(fp, { ok: true });
    const entries = await fs.readdir(tmpRoot);
    const tmps = entries.filter((n) => n.includes(".tmp."));
    expect(tmps).toEqual([]);
  });
});

describe("cleanupStaleTmpFiles", () => {
  it("ENOENT 目录直接返回 0", async () => {
    const n = await cleanupStaleTmpFiles(path.join(tmpRoot, "no-such"));
    expect(n).toBe(0);
  });

  it("仅清理超出 ttl 的 tmp 文件", async () => {
    // 三个 tmp：两个老（mtime - 2h），一个新（now）
    const old1 = path.join(tmpRoot, "x.json.tmp.111.123.aaa");
    const old2 = path.join(tmpRoot, "y.json.tmp.222.456.bbb");
    const fresh = path.join(tmpRoot, "z.json.tmp.333.789.ccc");
    await fs.writeFile(old1, "{}");
    await fs.writeFile(old2, "{}");
    await fs.writeFile(fresh, "{}");
    const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    await fs.utimes(old1, past, past);
    await fs.utimes(old2, past, past);
    const cleaned = await cleanupStaleTmpFiles(tmpRoot, {
      ttlMs: 60 * 60 * 1000,
    });
    expect(cleaned).toBe(2);
    // fresh 仍在
    await expect(fs.stat(fresh)).resolves.toBeDefined();
    // old 已被删
    await expect(fs.stat(old1)).rejects.toBeDefined();
    await expect(fs.stat(old2)).rejects.toBeDefined();
  });

  it("不会触碰非 .tmp. 命名的文件", async () => {
    const real = path.join(tmpRoot, "real.json");
    await fs.writeFile(real, "{}");
    const past = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
    await fs.utimes(real, past, past);
    const cleaned = await cleanupStaleTmpFiles(tmpRoot);
    expect(cleaned).toBe(0);
    await expect(fs.stat(real)).resolves.toBeDefined();
  });
});

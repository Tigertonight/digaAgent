/**
 * lib/storage/atomic.ts
 *
 * 统一的“原子写 + per-id 串行锁 + 错误分类”写盘 helper。
 *
 * 背景与动机：见 docs/reports/session-audit.md 第 4 节横切根因 1，
 * 和 docs/reports/session-tech-plan.md T2.1。
 *
 * 替代了仓库内 9 个 store 各自的简陋实现：
 *   `${fp}.tmp.${process.pid}.${Date.now()}` + writeFile + rename
 * 这种写法在同进程同毫秒并发写时会两次落到同名 tmp 互相覆盖，
 * 后到的 rename 可能搬运被腰斩的 tmp；崩溃时还会出现“目录有 entry、
 * 内容 0 字节”的损坏文件。
 *
 * 本 helper 提供：
 * - randomUUID() tmp 名，杜绝同名碰撞
 * - open(wx) 排他创建，进一步防撞
 * - handle.sync() + rename + fsyncDir，崩溃恢复语义
 * - per-key Promise chain 串行（同 fp 的 write 串行执行，避免互踩）
 * - 错误分类：ENOSPC 重抛，ENOENT(中间目录) 自动 mkdirp 重试 1 次，其他 errno warn 后抛
 * - cleanupStaleTmpFiles：可在 hydrate 时清扫历史孤儿 tmp
 */

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

const FILE_KIND = "diga.atomic";

/** atomicWriteJson 的可选参数。 */
export interface AtomicWriteOptions {
  /**
   * 串行锁 key。同一 key 的 atomicWriteJson / withPerKeyLock 排队执行；
   * 默认 = filePath（单文件按文件串行）。
   */
  lockKey?: string;

  /** 是否对父目录做 fsync（默认 true）；测试场景可以关掉提速。 */
  fsyncDir?: boolean;

  /**
   * 写入序列化前是否做 pretty-print（默认 true，与既有 store 行为一致）。
   * 注意：对极高频写场景可关掉省 IO。
   */
  pretty?: boolean;

  /**
   * 当中间目录缺失（ENOENT）时是否 mkdirp + 重试 1 次（默认 true）。
   * 关掉后调用方需要自己 ensure 目录存在。
   */
  retryOnMissingDir?: boolean;

  /**
   * 调用方上下文 tag，用于 log / metrics。例如 "progress" / "goal"。
   * 不参与逻辑，仅在 console.warn 时打出。
   */
  scope?: string;
}

/**
 * per-key 串行锁。同一 key 的回调严格按调用顺序执行。
 *
 * 不导出 Map<string, Promise> 让外部修改；用闭包持有。
 */
const inflightByKey = new Map<string, Promise<unknown>>();

export function withPerKeyLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = (inflightByKey.get(key) ?? Promise.resolve()).catch(() => undefined);
  const run = prev.then(fn);
  inflightByKey.set(key, run);
  void run
    .catch(() => undefined)
    .finally(() => {
      // 链尾仍是自己（无后继排队）才清理，防止泄漏与误删。
      if (inflightByKey.get(key) === run) inflightByKey.delete(key);
    });
  return run;
}

/** 测试 only：清空 per-key 锁状态。 */
export function __resetAtomicLocksForTests(): void {
  if (process.env.NODE_ENV !== "test") return;
  inflightByKey.clear();
}

/**
 * fsyncDir：把目录条目本身刷盘，使 rename 在断电后也可见。
 * - macOS / Linux 通常支持 open(dir,"r") + fsync
 * - 某些文件系统抛 EINVAL / ENOTSUP / EISDIR：视为 best-effort 跳过
 */
async function fsyncDir(dir: string): Promise<void> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw e;
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * 原子写入 JSON 文件。
 *
 * 错误处理协议：
 *   - ENOSPC：warn 一次 + 重抛（让 UI 提示磁盘满，不能静默吞）。
 *   - ENOENT 中间目录缺：mkdirp 后重试 1 次；仍失败则 warn + 抛。
 *   - 其他 errno：warn 后抛（调用方可决定是否吞）。
 *   - 注：本函数不会“返回 false”——失败一定抛，让调用方显式 try/catch。
 */
export async function atomicWriteJson(
  filePath: string,
  data: unknown,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const lockKey = opts.lockKey ?? filePath;
  return withPerKeyLock(lockKey, () => doWrite(filePath, data, opts, false));
}

async function doWrite(
  filePath: string,
  data: unknown,
  opts: AtomicWriteOptions,
  retried: boolean,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
  const json = opts.pretty === false
    ? JSON.stringify(data)
    : JSON.stringify(data, null, 2);

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmp, "wx");
    await handle.writeFile(json, "utf8");
    await handle.sync();
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // 中间目录缺：自动 mkdirp 重试 1 次。
    if (
      !retried &&
      err.code === "ENOENT" &&
      opts.retryOnMissingDir !== false
    ) {
      await fs.mkdir(dir, { recursive: true }).catch(() => {});
      // tmp 名带 randomUUID()，重试不会撞名
      return doWrite(filePath, data, opts, true);
    }
    if (err.code === "ENOSPC") {
      console.warn(
        `[${FILE_KIND}${opts.scope ? `:${opts.scope}` : ""}] write failed (no space)`,
        { filePath, code: err.code }
      );
    } else {
      console.warn(
        `[${FILE_KIND}${opts.scope ? `:${opts.scope}` : ""}] write failed`,
        { filePath, code: err.code, err: err.message }
      );
    }
    throw err;
  } finally {
    await handle?.close().catch(() => {});
  }

  try {
    await fs.rename(tmp, filePath);
    if (opts.fsyncDir !== false) await fsyncDir(dir);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    const err = e as NodeJS.ErrnoException;
    console.warn(
      `[${FILE_KIND}${opts.scope ? `:${opts.scope}` : ""}] rename failed`,
      { filePath, code: err.code, err: err.message }
    );
    throw err;
  }
}

/**
 * 启动时清扫历史孤儿 tmp 文件。
 *
 * 策略：扫 dir 内所有 `*.tmp.*` 文件，超过 ttlMs（默认 1h）的全部 unlink。
 * - 不读内容、不解析 pid，避免误判
 * - dir 不存在直接返回 0
 * - unlink 失败仅 warn，不影响其他文件
 *
 * 返回被清理文件数（用于日志 / 测试断言）。
 */
export async function cleanupStaleTmpFiles(
  dir: string,
  opts: { ttlMs?: number; scope?: string } = {},
): Promise<number> {
  const ttl = opts.ttlMs ?? 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    return 0;
  }
  const now = Date.now();
  let cleaned = 0;
  for (const name of entries) {
    // tmp 命名规则：`<file>.tmp.<pid>.<ts>.<uuid>`（atomic helper）或老格式 `<file>.tmp.<pid>.<ts>`。
    if (!name.includes(".tmp.")) continue;
    const fp = path.join(dir, name);
    try {
      const st = await fs.stat(fp);
      if (now - st.mtimeMs < ttl) continue;
      await fs.unlink(fp);
      cleaned += 1;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") continue;
      console.warn(
        `[${FILE_KIND}${opts.scope ? `:${opts.scope}` : ""}] cleanup tmp failed`,
        { fp, code: err.code }
      );
    }
  }
  return cleaned;
}

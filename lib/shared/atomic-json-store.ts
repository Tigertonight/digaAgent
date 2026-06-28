import "server-only";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_ROOT = path.join(os.homedir(), ".diga-agent");

/**
 * 低阶原子写原语：UUID 临时文件 + open(wx) + fsync + rename。
 * 供需要自定义序列化（如压缩、schema 封装）的 store 复用，避免每个 store
 * 各自重复一份 tmp/fsync/rename/错误处理逻辑。
 *
 * @param filePath 目标文件绝对路径（调用方负责 id 安全校验）。
 * @param content 已序列化好的字符串内容。
 * @param tag 日志标签（用于区分来源 store）。
 * @throws ENOSPC（磁盘满）向上抛出；其它 IO 错误记日志后吞掉。
 */
export function atomicWriteFileSync(
  filePath: string,
  content: string,
  tag: string
): void {
  let tmp: string | null = null;
  let fd: number | null = null;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
    fd = openSync(tmp, "wx");
    writeSync(fd, content, 0, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, filePath);
    tmp = null;
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    if (tmp) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOSPC") {
      console.warn(`[atomic-json-store:${tag}] write failed (no space)`, {
        filePath,
        code,
      });
      throw err;
    }
    console.warn(`[atomic-json-store:${tag}] write failed`, {
      filePath,
      code,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface AtomicJsonStoreOptions<T> {
  /**
   * root 下的子目录段，例如 ["subagents","batches"] →
   * ~/.diga-agent/subagents/batches/<id>.json
   */
  segments: string[];
  /** 从实体取主键 id（用作文件名 + 安全校验）。 */
  idOf: (entity: T) => string;
  /** 读盘后的清洗/校验；返回 null 则跳过该文件（损坏数据不阻塞其它条目）。 */
  sanitize: (raw: unknown) => T | null;
  /**
   * hydrate 时对单个实体做进程重启降级（可选）。
   * 例如把 "running" 降级为 "detached"、未完成 task 标记 aborted。
   * 返回处理后的实体（可原地修改后返回同一引用）。
   */
  onHydrate?: (entity: T, now: number) => T;
}

export interface AtomicJsonStore<T> {
  /** 当前生效的存储根目录。 */
  getRoot(): string;
  /** 当前实体目录的绝对路径。 */
  dir(): string;
  /** 某个 id 对应的文件绝对路径（带安全校验）。 */
  filePath(id: string): string;
  /**
   * 同步原子写：UUID 临时文件 + open(wx) + fsync + rename。
   * ENOSPC（磁盘满）会向上抛出；其它 IO 错误记日志后吞掉（best-effort 持久化，
   * 不阻塞内存态的主流程）。
   */
  persist(entity: T): void;
  /**
   * 合并写：在一个短窗口（默认 50ms）内对同一实体的多次写只落盘一次，
   * 缓解高频 update 的写放大（O(n²) → O(n)）。
   *
   * 重要：debounced 写在崩溃窗口内可能丢失最后若干次更新。**终态变更必须用
   * 同步 persist + flush**，不能依赖 debounce。调用方需自行保证这一点。
   *
   * @param entity 当前内存中的实体引用（flush 时按 idOf 重新取最新值落盘）。
   * @param resolve flush 时用于取该 id 最新实体的回调（避免落盘到过期快照）。
   */
  persistDebounced(entity: T, resolve: (id: string) => T | undefined): void;
  /** 立即落盘指定 id（或全部 dirty）的待写实体。终态变更后必须调用。 */
  flush(id?: string): void;
  /** 扫描目录，读出并 sanitize/onHydrate 所有实体。 */
  hydrateAll(now?: number): T[];
  /** 删除某 id 的磁盘文件（best-effort）。 */
  remove(id: string): void;
  /** 测试钩子：覆盖存储根目录（null = 恢复默认）。 */
  __setRootForTest(root: string | null): void;
}

/** 合并写窗口（毫秒）。窗口内对同一实体的多次写只落盘一次。 */
const DEBOUNCE_WINDOW_MS = 50;

export function createAtomicJsonStore<T>(
  opts: AtomicJsonStoreOptions<T>
): AtomicJsonStore<T> {
  let activeRoot: string | null = null;
  const tag = opts.segments.join("/");

  const getRoot = (): string => activeRoot ?? DEFAULT_ROOT;
  const dir = (): string => path.join(getRoot(), ...opts.segments);

  function assertSafeId(id: string): void {
    if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
      throw new Error(`invalid ${tag} store id: ${id}`);
    }
  }

  function filePath(id: string): string {
    assertSafeId(id);
    return path.join(dir(), `${id}.json`);
  }

  function persist(entity: T): void {
    const id = opts.idOf(entity);
    atomicWriteFileSync(filePath(id), JSON.stringify(entity, null, 2), tag);
  }

  // 合并写状态：dirty 集 + 各 id 的最新取值回调 + 单个定时器。
  const dirty = new Map<string, (id: string) => T | undefined>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flush(id?: string): void {
    if (id !== undefined) {
      const resolve = dirty.get(id);
      if (!resolve) return;
      dirty.delete(id);
      const latest = resolve(id);
      if (latest) persist(latest);
      if (dirty.size === 0 && flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      return;
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    for (const [pendingId, resolve] of Array.from(dirty.entries())) {
      dirty.delete(pendingId);
      const latest = resolve(pendingId);
      if (latest) persist(latest);
    }
  }

  function persistDebounced(
    entity: T,
    resolve: (id: string) => T | undefined
  ): void {
    dirty.set(opts.idOf(entity), resolve);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, DEBOUNCE_WINDOW_MS);
    // 不阻止进程退出：debounced 写是优化项，终态已由调用方同步 flush 保证。
    if (typeof flushTimer === "object" && flushTimer && "unref" in flushTimer) {
      (flushTimer as { unref: () => void }).unref();
    }
  }

  function hydrateAll(now = Date.now()): T[] {
    const d = dir();
    if (!existsSync(d)) return [];
    const out: T[] = [];
    for (const name of readdirSync(d)) {
      if (!name.endsWith(".json")) continue;
      try {
        let entity = opts.sanitize(
          JSON.parse(readFileSync(path.join(d, name), "utf8"))
        );
        if (!entity) continue;
        if (opts.onHydrate) entity = opts.onHydrate(entity, now);
        out.push(entity);
      } catch {
        // Ignore corrupt metadata files. They should not block other entities.
      }
    }
    return out;
  }

  function remove(id: string): void {
    try {
      unlinkSync(filePath(id));
    } catch {
      // best-effort: 文件不存在 / IO 错误忽略。
    }
  }

  function __setRootForTest(root: string | null): void {
    flush();
    activeRoot = root;
  }

  return {
    getRoot,
    dir,
    filePath,
    persist,
    persistDebounced,
    flush,
    hydrateAll,
    remove,
    __setRootForTest,
  };
}

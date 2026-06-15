import "server-only";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 文件 API + agent cwd 共用的根护栏。
 *
 * 优先级：DIGA_AGENT_FILE_ROOTS > DIGA_AGENT_WEB_ROOT > [$HOME]
 *   - 多根用 ":" 分隔
 *   - 任一根设为 "/" 表示完全放开（不推荐）
 */
export function getFileRoots(): string[] {
  const multi = process.env.DIGA_AGENT_FILE_ROOTS;
  if (multi !== undefined) {
    const items = multi
      .split(":")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length === 0) return ["/"];
    if (items.includes("/")) return ["/"];
    return items.map((p) => path.resolve(p));
  }
  const single = process.env.DIGA_AGENT_WEB_ROOT;
  if (single === undefined) return [os.homedir()];
  if (single === "" || single === "/") return ["/"];
  return [path.resolve(single)];
}

/** 把任意 path 校验为 allowed 绝对路径；不在白名单中抛错。 */
export function assertPathAllowed(p: string): string {
  const roots = getFileRoots();
  const abs = path.resolve(p);
  if (roots.includes("/")) return abs;
  for (const root of roots) {
    const rel = path.relative(root, abs);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return abs;
  }
  throw new Error(
    `path outside allowed file roots (${roots.join(", ")}): ${abs}`
  );
}

function isWithinRoots(abs: string, roots: string[]): boolean {
  if (roots.includes("/")) return true;
  for (const root of roots) {
    const rel = path.relative(root, abs);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/**
 * A4-2：写操作专用。assertPathAllowed 只看字面路径，无法拦住
 * “路径本身在 root 内但某个中间目录是 symlink 指向 root 外”的越界。
 *
 * 守护思路：解析父目录的 realpath，再拼上原 basename，以这个真实路径重新跑边界检查。
 * 这样以下两种场景都会被拒：
 *   - target 本身不存在，但中间某个目录是 symlink 指向 root 外（write/create）
 *   - target 本身是 symlink（unlink）——realpath 会看到上一级 dir
 *
 * 另外 root 本身也会同步走 realpath，避免 macOS 的 /var → /private/var 之类
 * 系统软链造成误拒。如果 root 不存在，退回字面。
 */
export async function assertWritePathAllowed(p: string): Promise<string> {
  const abs = assertPathAllowed(p);
  const roots = getFileRoots();
  if (roots.includes("/")) return abs;

  const dir = path.dirname(abs);
  let realDir: string;
  try {
    realDir = await fs.realpath(dir);
  } catch (err: unknown) {
    // 父目录不存在是可接受的（create-then-write 场景）。
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return abs;
    throw err;
  }
  const realAbs = path.join(realDir, path.basename(abs));
  // root 也走 realpath。用 realRoots 重新跑边界检查。
  const realRoots = await Promise.all(roots.map(realpathOrSelf));
  if (!isWithinRoots(realAbs, realRoots)) {
    throw new Error(
      `resolved path outside allowed file roots via symlink (${roots.join(
        ", "
      )}): ${realAbs}`
    );
  }
  return abs;
}

/** 写入大小上限（字节），默认 5MB。 */
export function getFileMaxBytes(): number {
  const raw = process.env.DIGA_AGENT_FILE_MAX_BYTES;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 5 * 1024 * 1024;
}

/**
 * RFC-3 Phase A：session meta 持久化 store。
 *
 * 设计要点：
 * - 单文件方案：每 session 一份 `<root>/sessions/{id}.meta.json`，单 session 删除
 *   时 unlink 配对文件即可；并发写不会互相影响（除非两个 client 同时改同一 session）。
 * - atomic write：写入用 tmp + rename 避免半写状态；ENOENT 等 IO 错误优雅降级（返
 *   回 null，让上层用 fallback UI）。
 * - 未知字段防御：read 时过滤白名单（META_KNOWN_FIELDS），forward-compat 防 user
 *   手工编辑文件塞奇怪字段把上层崩了。
 * - 不依赖 server-only：纯 fs 模块，client bundle 会被 webpack 自动挡掉（node:fs
 *   无 browser polyfill）；这样 vitest（node env）能直接跑单测。
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  META_KNOWN_FIELDS,
  type SessionMeta,
} from "./types";

/**
 * 默认根目录：~/.mini-pi/
 *
 * 抽成 getter 而非常量：单测可以在 setup 里 vi.stubEnv 改 HOME 改默认根，避免 race。
 */
function defaultRoot(): string {
  return path.join(os.homedir(), ".mini-pi");
}

/**
 * 当前 store 用的根目录。允许测试时覆盖（不让单测污染真用户 ~/.mini-pi/）。
 * 生产代码不传，默认 ~/.mini-pi。
 */
let activeRoot: string | null = null;

/** 测试 only：覆盖根目录 */
export function __setMetaRootForTests(root: string | null): void {
  activeRoot = root;
}

function getRoot(): string {
  return activeRoot ?? defaultRoot();
}

function metaFilePath(sessionId: string): string {
  // 防御 path traversal：单纯拒绝带分隔符或 ".." 的 id
  if (
    !sessionId ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("..")
  ) {
    throw new Error(`invalid sessionId: ${sessionId}`);
  }
  return path.join(getRoot(), "sessions", `${sessionId}.meta.json`);
}

async function ensureSessionsDir(): Promise<void> {
  await fs.mkdir(path.join(getRoot(), "sessions"), { recursive: true });
}

/** 过滤未知字段 + 强制 id 一致 */
function sanitize(raw: unknown, expectedId: string): SessionMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { id: expectedId };
  for (const k of META_KNOWN_FIELDS) {
    if (k === "id") continue;
    if (k in src) out[k] = src[k];
  }
  return out as unknown as SessionMeta;
}

/**
 * 读取单个 session 的 meta。文件不存在返回 null（不抛）。
 * JSON 解析失败也返回 null（损坏文件不挂全表 list）。
 */
export async function readMeta(sessionId: string): Promise<SessionMeta | null> {
  let text: string;
  try {
    text = await fs.readFile(metaFilePath(sessionId), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    // 其他 IO 错误（权限等）也优雅降级
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return sanitize(parsed, sessionId);
  } catch {
    return null;
  }
}

/**
 * 写入单个 session 的 meta（覆盖式）。
 *
 * atomic：先写 `.tmp` 后 rename；rename 在同 fs 内是原子的。
 *
 * 注意：调用方负责 merge（read → spread → write），本函数不做 partial merge。
 * 理由：明确语义比"自动合并"更可控，避免客户端 partial 字段意外覆盖。
 */
export async function writeMeta(meta: SessionMeta): Promise<void> {
  if (!meta?.id) throw new Error("meta.id is required");
  const sanitized = sanitize(meta, meta.id);
  if (!sanitized) throw new Error("invalid meta payload");

  await ensureSessionsDir();
  const fp = metaFilePath(meta.id);
  const tmp = `${fp}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(sanitized, null, 2), "utf8");
  await fs.rename(tmp, fp);
}

/**
 * 批量读：listAllSessions 一次性聚合所有 meta。
 *
 * 并发 Promise.all：单 session 失败回退 null，不影响其他。
 *
 * 性能：100 session 大约 50ms（macOS APFS）；500 session 才需要考虑分块。
 */
export async function batchReadMeta(
  ids: readonly string[]
): Promise<Map<string, SessionMeta>> {
  const out = new Map<string, SessionMeta>();
  if (ids.length === 0) return out;
  const results = await Promise.all(ids.map((id) => readMeta(id)));
  ids.forEach((id, i) => {
    const m = results[i];
    if (m) out.set(id, m);
  });
  return out;
}

/**
 * 删除单个 session 的 meta 文件。幂等（不存在直接成功）。
 * 应在 DELETE /api/sessions/[id] 路由里联调。
 */
export async function deleteMeta(sessionId: string): Promise<void> {
  try {
    await fs.unlink(metaFilePath(sessionId));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}

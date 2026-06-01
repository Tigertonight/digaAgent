/**
 * 文件 API（去掉了官方 pi-web 的白名单限制）：
 *   GET    /api/files?path=<abs>           读文件 / 列目录
 *   PUT    /api/files?path=<abs>           写文件（body 是新内容，text/plain）
 *   DELETE /api/files?path=<abs>           删文件/空目录
 *   POST   /api/files?op=move              { from, to } 移动/重命名
 *
 * 软保护：可设 MINI_PI_WEB_ROOT 环境变量，仅允许操作该根目录下的路径。
 *   默认值：$HOME（你的 home 目录）。
 *   设为 "" 或 "/" 即关闭限制。
 */
import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getRoot(): string {
  const r = process.env.MINI_PI_WEB_ROOT;
  if (r === undefined) return os.homedir();
  if (r === "" || r === "/") return "/";
  return path.resolve(r);
}

function assertAllowed(p: string) {
  const root = getRoot();
  const abs = path.resolve(p);
  if (root === "/") return abs;
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path outside MINI_PI_WEB_ROOT (${root}): ${abs}`);
  }
  return abs;
}

function err(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

/** 递归搜索时跳过的目录名(成本太高 / 信噪比太低) */
const SEARCH_BLACKLIST = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
  ".idea",
  ".vscode",
  "target",
  ".DS_Store",
]);

interface SearchHit {
  path: string;
  name: string;
  isDir: boolean;
}

/** BFS 递归搜:文件名 substring 匹配,大小写不敏感
 *  - maxResults: 截断保护,默认 200
 *  - maxDepth:   层级保护,默认 6
 *  - 跳过软链(避免循环)和 SEARCH_BLACKLIST 目录 */
async function recursiveSearch(
  rootAbs: string,
  query: string,
  maxResults = 200,
  maxDepth = 6
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: rootAbs, depth: 0 },
  ];
  while (queue.length > 0) {
    if (hits.length >= maxResults) {
      return { hits, truncated: true };
    }
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SEARCH_BLACKLIST.has(e.name)) continue;
      if (e.name.startsWith(".") && e.name.length > 1) {
        // 跳所有 dotfile,降噪;用户真要 .gitignore 之类自己浏览
        continue;
      }
      const child = path.join(dir, e.name);
      if (e.name.toLowerCase().includes(q)) {
        hits.push({ path: child, name: e.name, isDir: e.isDirectory() });
        if (hits.length >= maxResults) {
          return { hits, truncated: true };
        }
      }
      if (e.isDirectory() && !e.isSymbolicLink() && depth < maxDepth) {
        queue.push({ dir: child, depth: depth + 1 });
      }
    }
  }
  return { hits, truncated: false };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get("path");
  const raw = url.searchParams.get("raw") === "1";
  const q = url.searchParams.get("q");
  if (!p) return err("path required");
  try {
    const abs = assertAllowed(p);
    // q 模式:把 path 当作搜索 root,递归扫文件名匹配
    if (q && q.length >= 2) {
      const st = await fs.stat(abs);
      if (!st.isDirectory()) return err("search root must be a directory", 400);
      const { hits, truncated } = await recursiveSearch(abs, q);
      return NextResponse.json({
        kind: "search",
        path: abs,
        query: q,
        truncated,
        entries: hits,
      });
    }
    const st = await fs.stat(abs);
    // raw 模式:直接二进制返回(用于 <img src> / <video src> 等),只允许文件
    if (raw) {
      if (st.isDirectory()) return err("raw mode requires a file", 400);
      const ext = abs.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
      const RAW_MIME: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        bmp: "image/bmp",
        ico: "image/x-icon",
        avif: "image/avif",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        ogg: "audio/ogg",
        m4a: "audio/mp4",
        flac: "audio/flac",
        webm: "video/webm",
        mp4: "video/mp4",
      };
      const mime = RAW_MIME[ext] ?? "application/octet-stream";
      const buf = await fs.readFile(abs);
      return new Response(new Uint8Array(buf), {
        headers: {
          "Content-Type": mime,
          "Content-Length": String(buf.length),
          "Cache-Control": "private, max-age=60",
        },
      });
    }
    if (st.isDirectory()) {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return NextResponse.json({
        kind: "dir",
        path: abs,
        entries: entries.map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
          isFile: e.isFile(),
          isSymlink: e.isSymbolicLink(),
        })),
      });
    }
    // image 类按 base64 返；其余 utf8 文本读
    const ext = abs.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
    const IMAGE_MIME: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      bmp: "image/bmp",
      ico: "image/x-icon",
      avif: "image/avif",
    };
    const AUDIO_MIME: Record<string, string> = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      oga: "audio/ogg",
      m4a: "audio/mp4",
      aac: "audio/aac",
      flac: "audio/flac",
      webm: "audio/webm",
      opus: "audio/opus",
    };
    if (ext in IMAGE_MIME) {
      const buf = await fs.readFile(abs);
      return NextResponse.json({
        kind: "file",
        path: abs,
        size: st.size,
        modified: st.mtime.toISOString(),
        content: "",
        binary: true,
        mime: IMAGE_MIME[ext],
        dataBase64: buf.toString("base64"),
      });
    }
    if (ext in AUDIO_MIME) {
      const buf = await fs.readFile(abs);
      return NextResponse.json({
        kind: "file",
        path: abs,
        size: st.size,
        modified: st.mtime.toISOString(),
        content: "",
        binary: true,
        mime: AUDIO_MIME[ext],
        dataBase64: buf.toString("base64"),
      });
    }
    const content = await fs.readFile(abs, "utf8");
    return NextResponse.json({
      kind: "file",
      path: abs,
      size: st.size,
      modified: st.mtime.toISOString(),
      content,
    });
  } catch (e) {
    return err((e as Error).message, 500);
  }
}

export async function PUT(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get("path");
  if (!p) return err("path required");
  try {
    const abs = assertAllowed(p);
    const body = await req.text();
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, "utf8");
    const st = await fs.stat(abs);
    return NextResponse.json({
      ok: true,
      path: abs,
      size: st.size,
      modified: st.mtime.toISOString(),
    });
  } catch (e) {
    return err((e as Error).message, 500);
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams.get("path");
  if (!p) return err("path required");
  try {
    const abs = assertAllowed(p);
    const st = await fs.stat(abs);
    if (st.isDirectory()) {
      await fs.rmdir(abs); // 只删空目录，安全起见不递归
    } else {
      await fs.unlink(abs);
    }
    return NextResponse.json({ ok: true, path: abs });
  } catch (e) {
    return err((e as Error).message, 500);
  }
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const op = url.searchParams.get("op");
  if (op !== "move") return err("unknown op");
  try {
    const body = await req.json();
    const fromAbs = assertAllowed(body.from);
    const toAbs = assertAllowed(body.to);
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
    return NextResponse.json({ ok: true, from: fromAbs, to: toAbs });
  } catch (e) {
    return err((e as Error).message, 500);
  }
}

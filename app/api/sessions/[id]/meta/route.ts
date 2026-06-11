/**
 * RFC-3 Phase A3：mini-pi-web 自维护 session meta 的读写路由。
 *
 * 与 `/api/sessions/[id]` PATCH（写 SDK 的 SessionInfo entry / name）严格分离：
 *   - 本路由只动 `~/.mini-pi/sessions/{id}.meta.json`
 *   - 不动 SDK 数据；不需要 session 文件存在（允许预先写 meta）
 *
 * 设计：
 *   - GET：返回当前 meta（不存在返回 { meta: null }）
 *   - PATCH：partial merge（read-merge-write）；body 只接受 v0 白名单字段
 *   - 不暴露 PUT（防止客户端误用整体覆盖把预留字段抹掉）
 */

import { NextResponse } from "next/server";
import { readMeta, writeMeta } from "@/lib/meta/store";
import {
  META_WRITABLE_FIELDS_V0,
  type MetaWritableFieldV0,
  type SessionMeta,
} from "@/lib/meta/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 提取 body 中的 v0 白名单字段，做最小校验。 */
function pickWritable(body: unknown): Partial<SessionMeta> {
  if (!body || typeof body !== "object") return {};
  const src = body as Record<string, unknown>;
  const out: Partial<SessionMeta> = {};
  for (const k of META_WRITABLE_FIELDS_V0) {
    if (!(k in src)) continue;
    const v = src[k];
    switch (k as MetaWritableFieldV0) {
      case "title": {
        // null / "" → 视为清除 title（写 undefined）
        if (v === null || v === "") {
          out.title = undefined;
        } else if (typeof v === "string") {
          // 长度限制：避免有人塞 1MB title 撑爆 meta 文件
          out.title = v.length > 200 ? v.slice(0, 200) : v;
        }
        break;
      }
      case "pinned": {
        if (typeof v === "boolean") out.pinned = v;
        break;
      }
      case "lastSeenAt": {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) {
          out.lastSeenAt = Math.floor(v);
        }
        break;
      }
    }
  }
  return out;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const meta = await readMeta(id);
    return NextResponse.json({ meta });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const patch = pickWritable(body);
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "no writable fields in body" },
        { status: 400 }
      );
    }
    const existing = (await readMeta(id)) ?? { id };
    const merged: SessionMeta = { ...existing, ...patch, id };
    // patch.title === undefined 表示清除：spread 会保留 undefined 占位，writeMeta
    // sanitize 时 JSON.stringify 会自动剔除 undefined。OK。
    await writeMeta(merged);
    return NextResponse.json({ meta: merged });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

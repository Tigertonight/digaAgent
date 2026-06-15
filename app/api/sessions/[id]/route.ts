import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findSessionPathById, getSessionDetail } from "@/lib/sessions";
import { deleteMeta } from "@/lib/meta/store";
import { deletePersistedProgress } from "@/lib/progress/file-store";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRemoteAuth(async function (
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const detail = await getSessionDetail(id);
    if (!detail) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
});

/** PATCH: 重命名 session（写一条 session_info entry） */
export const PATCH = withRemoteAuth(async function (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = (await req.json()) as { name?: unknown };
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json(
        { error: "name is required" },
        { status: 400 }
      );
    }
    const path = await findSessionPathById(id);
    if (!path) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    const sm = SessionManager.open(path);
    sm.appendSessionInfo(name);
    return NextResponse.json({ ok: true, id, name });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
});

/** DELETE: 删除 session 文件 */
export const DELETE = withRemoteAuth(async function (
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const path = await findSessionPathById(id);
    if (!path) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    await fs.unlink(path);
    // RFC-3 Phase A2：联删 diga-agent 的元数据文件；runtime progress 同步清理。
    // 二者都是幂等操作，不存在即跳过。
    await deleteMeta(id);
    await deletePersistedProgress(id);
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
});

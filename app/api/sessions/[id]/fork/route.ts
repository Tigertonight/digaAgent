/**
 * POST /api/sessions/[id]/fork
 *
 * 从源 session 拷贝出一个新 session 文件（带 parentSessionPath 链接），
 * 并把指针定到 targetEntryId（user message）。之后前端可以像打开普通 session 一样
 * 创建 agent 接着对话。
 *
 * 请求体：
 *   { targetEntryId: string }
 *
 * 返回：
 *   { ok: true, id, path, cwd }   -- 新 session 的元信息
 */
import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findSessionPathById, getSessionDetail } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      targetEntryId?: unknown;
    };
    const targetEntryId =
      typeof body.targetEntryId === "string" ? body.targetEntryId : "";
    if (!targetEntryId) {
      return NextResponse.json(
        { error: "targetEntryId required" },
        { status: 400 }
      );
    }

    const sourcePath = await findSessionPathById(id);
    if (!sourcePath) {
      return NextResponse.json(
        { error: "source session not found" },
        { status: 404 }
      );
    }

    // 找到源 session 的 cwd（forkFrom 需要）
    const detail = await getSessionDetail(id);
    if (!detail) {
      return NextResponse.json(
        { error: "source session not readable" },
        { status: 500 }
      );
    }
    const sourceCwd = detail.info.cwd;
    if (!sourceCwd) {
      return NextResponse.json(
        { error: "source session has no cwd; cannot fork" },
        { status: 400 }
      );
    }

    // 拷贝成新 session 文件（同 cwd），SDK 自动写 parentSessionPath。
    // 注意：SessionManager 没有公开 setLeafId 接口，所以新文件的 leaf 还在末尾。
    // 前端在为这个新 session 创建 agent 后，需要再调一次 navigate_tree(targetEntryId)
    // 把 leaf 截到 fork 点。这里只负责造文件 + 返回元信息。
    const newSm = SessionManager.forkFrom(sourcePath, sourceCwd);

    return NextResponse.json({
      ok: true,
      id: newSm.getSessionId(),
      path: newSm.getSessionFile(),
      cwd: sourceCwd,
      targetEntryId,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

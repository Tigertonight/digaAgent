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
import { unlink } from "node:fs/promises";
import {
  findSessionPathById,
  getForkableUserMessages,
  getSessionDetail,
} from "@/lib/sessions";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import { internalErrorResponse } from "@/lib/api/error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withRemoteAuth(async function (
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

    const forkable = await getForkableUserMessages(id);
    if (!forkable?.some((entry) => entry.entryId === targetEntryId)) {
      return NextResponse.json(
        { error: "targetEntryId does not belong to this session branch" },
        { status: 400 }
      );
    }

    // 找到源 session 的 cwd（forkFrom 需要）
    const detail = await getSessionDetail(id);
    if (!detail) {
      return NextResponse.json(
        { error: "source session not found" },
        { status: 404 }
      );
    }
    const sourceCwd = detail.info.cwd;
    if (!sourceCwd) {
      return NextResponse.json(
        { error: "source session has no cwd; cannot fork" },
        { status: 400 }
      );
    }

    // 拷贝成新 session 文件（同 cwd），SDK 自动写 parentSessionPath），并把
    // SessionManager 当前 leaf 定到目标 user entry。前端仍会带 targetEntryId
    // 创建 agent 做二次定位；服务端先校验并设置一次，避免回显无效 anchor。
    const newSm = SessionManager.forkFrom(sourcePath, sourceCwd);
    try {
      newSm.branch(targetEntryId);
    } catch (e) {
      const createdPath = newSm.getSessionFile();
      if (createdPath) {
        await unlink(createdPath).catch(() => {});
      }
      throw e;
    }

    return NextResponse.json({
      ok: true,
      id: newSm.getSessionId(),
      path: newSm.getSessionFile(),
      cwd: sourceCwd,
      targetEntryId,
    });
  } catch (e) {
    return internalErrorResponse(e, { scope: "POST /api/sessions/[id]/fork" });
  }
});

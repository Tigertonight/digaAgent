import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  collectSessionDescendants,
  findSessionPathById,
  getSessionDetail,
} from "@/lib/sessions";
import { deleteMeta } from "@/lib/meta/store";
import { deletePersistedProgress } from "@/lib/progress/file-store";
import { removeBatchesByParentSessionPath } from "@/lib/subagents/server-store";
import { disposeAgent, listAgentSummaries } from "@/lib/agent-registry";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import { internalErrorResponse } from "@/lib/api/error-response";

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
    return internalErrorResponse(e, { scope: "GET /api/sessions/[id]" });
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
    return internalErrorResponse(e, { scope: "PATCH /api/sessions/[id]" });
  }
});

/**
 * DELETE: 删除 session 文件。
 *
 * 级联语义：这条 session 的所有后代（通过 parentSessionPath 链接的 fork 子
 * session，含多层）一并删掉。之前只删自己，会留下一堆 “父不在列表但又
 * 不是独立根” 的孤儿 session 文件（UI 会被 listAllSessions 当作独立 root 勒出
 * 来，但实际上是 “删除遗留”）。现在一并清。
 */
export const DELETE = withRemoteAuth(async function (
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const targets = await collectSessionDescendants(id);
    if (!targets || targets.length === 0) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }

    // 先 dispose 还跑在内存里的 agent record（包括 child agents），否则
    // SSE / streaming 会继续往已删的文件写入。同一 sessionFile 可能被多个
    // hidden child agent 占着，dispose 需按 sessionFile 全量扫描。
    const targetPaths = new Set(targets.map((t) => t.path));
    const summaries = listAgentSummaries();
    for (const summary of summaries) {
      if (!summary.sessionFile) continue;
      if (targetPaths.has(summary.sessionFile)) {
        try {
          disposeAgent(summary.agentId);
        } catch {
          // dispose 是 best-effort，删除本身不应被这里阻断
        }
      }
    }

    // 删 jsonl + meta + progress；三者都是幂等，任何一个不存在都忽略。
    const errors: Array<{ id: string; error: string }> = [];
    for (const t of targets) {
      try {
        await fs.unlink(t.path);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          // N2: jsonl 没删掉（权限/被占用）时，绝不能继续清 meta/progress/batches，
          // 否则会留下「对话还在、但重命名/进度全没了」的失忆态。记录错误后跳过本
          // target 的后续清理。ENOENT（本就不存在）视为已删除，继续清理残留元数据。
          console.error(`[DELETE /api/sessions/${t.id}] unlink failed:`, err);
          errors.push({ id: t.id, error: err.code ?? "delete failed" });
          continue;
        }
      }
      await deleteMeta(t.id);
      await deletePersistedProgress(t.id);
      // M1：清掉以该 session 为父的 subagent batches，避免孤儿记录。
      // 索引按 parentSessionPath（= session 文件路径），用 t.path。
      try {
        removeBatchesByParentSessionPath(t.path);
      } catch (e) {
        console.error(`[DELETE /api/sessions/${t.id}] remove batches failed:`, e);
      }
    }

    if (errors.length > 0) {
      return NextResponse.json(
        {
          error: "some sessions failed to delete",
          details: errors,
          deleted: targets
            .filter((t) => !errors.find((e) => e.id === t.id))
            .map((t) => t.id),
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      id,
      deleted: targets.map((t) => t.id),
    });
  } catch (e) {
    return internalErrorResponse(e, { scope: "DELETE /api/sessions/[id]" });
  }
});

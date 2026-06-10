import { NextResponse } from "next/server";
import {
  getSessionContext,
  getSessionContextPageByPath,
  getSessionContextTail,
  getSessionContextTailByPath,
  getForkableUserMessages,
} from "@/lib/sessions";
import { assertRemoteAuth } from "@/lib/remote/auth";
import { listBatchesByParentSessionPath } from "@/lib/subagents/server-store";
import { readPersistedProgress } from "@/lib/progress/file-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  const { id } = await params;
  try {
    const url = new URL(req.url);
    const tailRaw = url.searchParams.get("tail");
    const tail = tailRaw ? Number(tailRaw) : 0;
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw ? Number(beforeRaw) : NaN;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : tail;
    const sessionPath = url.searchParams.get("path");
    const ctx =
      sessionPath && Number.isFinite(before) && before >= 0
        ? await getSessionContextPageByPath(
            sessionPath,
            id,
            before,
            Number.isFinite(limit) && limit > 0 ? limit : 80
          )
        : Number.isFinite(tail) && tail > 0
        ? sessionPath
          ? await getSessionContextTailByPath(sessionPath, id, tail)
          : await getSessionContextTail(id, tail)
        : await getSessionContext(id);
    if (!ctx) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    if (
      (sessionPath && Number.isFinite(before) && before >= 0) ||
      (Number.isFinite(tail) && tail > 0)
    ) {
      return NextResponse.json(ctx);
    }
    // 顺带返回 fork 锚点和持久化 runtime progress：选中历史 session 后无需
    // agent 也能立刻恢复右侧 Workbench 的进度/输出。
    const forkableUserMessages = (await getForkableUserMessages(id)) ?? [];
    const progress = await readPersistedProgress(id);
    return NextResponse.json({
      ...ctx,
      forkableUserMessages,
      subagentBatches: listBatchesByParentSessionPath(id),
      progress,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

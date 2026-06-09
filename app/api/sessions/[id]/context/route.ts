import { NextResponse } from "next/server";
import {
  getSessionContext,
  getForkableUserMessages,
} from "@/lib/sessions";
import { listBatchesByParentSessionPath } from "@/lib/subagents/server-store";
import { readPersistedProgress } from "@/lib/progress/file-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const ctx = await getSessionContext(id);
    if (!ctx) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
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

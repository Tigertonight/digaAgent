import { NextResponse } from "next/server";
import {
  getSessionContext,
  getSessionContextPageByPath,
  getSessionContextTail,
  getSessionContextTailByPath,
  getForkableUserMessages,
} from "@/lib/sessions";
import { assertRemoteAuth } from "@/lib/remote/auth";
import { internalErrorResponse } from "@/lib/api/error-response";
import { listAgentSummaries } from "@/lib/agent-registry";
import { listBatchesByParentSessionPath } from "@/lib/subagents/server-store";
import { readPersistedProgress } from "@/lib/progress/file-store";
import {
  hasUnpairedToolCalls,
  markInterruptedProgress,
} from "@/lib/progress/recovery";

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
    let progress = await readPersistedProgress(id);
    // “异常关机后恢复”补丁：如果当前 sessionId 上没有 active runtime 或 streaming agent，
    // 但 messages 里还有 assistant.tool_use 未配对 — 上一次进程崩在工具返回前。
    // 此时不要让“全部 completed”的 progress 快照伪装成最终真相：把开着的节点
    // 收口为 failed，并补一条 “运行异常中断” 额外节点，与工具块被 reducer 衰变为
    // error 保持一致。同时在返回体上补一个 interrupted 信号，让前端
    // ctxToMessages 走 unfinishedToolStatus="error" 分支。
    const messages = (ctx as { messages?: unknown }).messages;
    // M2: 只要该 session 还有任何活着的 agent record，就不要标 interrupted。
    // 旧逻辑只豁免 streaming / waiting_user 两个 runtime 态，会误伤 waiting_model、
    // 工具刚 dispatch 未 return 等短暂态——此时打开 session 会被错误判定为中断，
    // 把进行中的 progress 节点强行收口成 failed。真正的“异常中断”只发生在进程已
    // 不存在任何活 agent record 的情况下。
    const hasLiveAgent = listAgentSummaries().some(
      (agent) => agent.sessionId === id
    );
    const interrupted =
      !hasLiveAgent &&
      Array.isArray(messages) &&
      hasUnpairedToolCalls(
        messages as Parameters<typeof hasUnpairedToolCalls>[0]
      );
    if (interrupted) {
      progress = markInterruptedProgress(progress);
    }
    return NextResponse.json({
      ...ctx,
      forkableUserMessages,
      subagentBatches: listBatchesByParentSessionPath(id),
      progress,
      interrupted,
    });
  } catch (e) {
    return internalErrorResponse(e, { scope: "GET /api/sessions/[id]/context" });
  }
}

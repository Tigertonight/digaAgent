import { NextResponse } from "next/server";
import {
  abortSubagentsForParent,
  buildSubagentDepsForAgent,
  getAgent,
} from "@/lib/agent-registry";
import { listBatches } from "@/lib/subagents/server-store";
import {
  resumeSubagentBatch,
  retrySubagentTask,
} from "@/lib/subagents/orchestrator";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRemoteAuth(async function (
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rec = getAgent(id);
  if (!rec) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  return NextResponse.json({ batches: listBatches(id) });
});

export const POST = withRemoteAuth(async function (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rec = getAgent(id);
  if (!rec) return NextResponse.json({ error: "agent not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const type = body.type as string | undefined;
  if (type === "abort") {
    await abortSubagentsForParent(id);
    return NextResponse.json({ ok: true });
  }

  if (type === "retry") {
    const batchId = typeof body.batchId === "string" ? body.batchId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    if (!batchId || !taskId) {
      return NextResponse.json(
        { error: "retry requires batchId and taskId" },
        { status: 400 }
      );
    }
    if (!rec.session.model) {
      return NextResponse.json(
        { error: "agent model not ready" },
        { status: 500 }
      );
    }
    // S1：复用首走 deps（resolveDefinition / worktrees / merge approval / mcp在 createChild里沉淀）。
    const deps = buildSubagentDepsForAgent(rec);
    const result = await retrySubagentTask(deps, batchId, taskId);
    return NextResponse.json({ ok: true, result });
  }

  if (type === "resume") {
    const batchId = typeof body.batchId === "string" ? body.batchId : "";
    if (!batchId) {
      return NextResponse.json(
        { error: "resume requires batchId" },
        { status: 400 }
      );
    }
    if (!rec.session.model) {
      return NextResponse.json(
        { error: "agent model not ready" },
        { status: 500 }
      );
    }
    const deps = buildSubagentDepsForAgent(rec);
    const result = await resumeSubagentBatch(deps, batchId);
    return NextResponse.json({ ok: true, result });
  }

  {
    return NextResponse.json(
      { error: `unknown action: ${type ?? "(missing)"}` },
      { status: 400 }
    );
  }
});

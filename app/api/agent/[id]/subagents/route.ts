import { NextResponse } from "next/server";
import {
  abortSubagentsForParent,
  createAgent,
  disposeAgent,
  getAgent,
  pushExternalEvent,
} from "@/lib/agent-registry";
import { listBatches } from "@/lib/subagents/server-store";
import {
  resumeSubagentBatch,
  retrySubagentTask,
} from "@/lib/subagents/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rec = getAgent(id);
  if (!rec) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  return NextResponse.json({ batches: listBatches(id) });
}

export async function POST(
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
    const model = rec.session.model;
    if (!model) {
      return NextResponse.json({ error: "agent model not ready" }, { status: 500 });
    }
    const result = await retrySubagentTask(
      {
        parentAgentId: id,
        parentSessionPath: rec.session.sessionFile,
        provider: model.provider,
        modelId: model.id,
        cwd: rec.cwd,
        thinkingLevel: rec.session.thinkingLevel,
        createChild: createAgent,
        getChild: (agentId) => getAgent(agentId),
        disposeChild: disposeAgent,
        pushParentEvent: (event) => pushExternalEvent(rec, event),
      },
      batchId,
      taskId
    );
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
    const model = rec.session.model;
    if (!model) {
      return NextResponse.json({ error: "agent model not ready" }, { status: 500 });
    }
    const result = await resumeSubagentBatch(
      {
        parentAgentId: id,
        parentSessionPath: rec.session.sessionFile,
        provider: model.provider,
        modelId: model.id,
        cwd: rec.cwd,
        thinkingLevel: rec.session.thinkingLevel,
        createChild: createAgent,
        getChild: (agentId) => getAgent(agentId),
        disposeChild: disposeAgent,
        pushParentEvent: (event) => pushExternalEvent(rec, event),
      },
      batchId
    );
    return NextResponse.json({ ok: true, result });
  }

  {
    return NextResponse.json(
      { error: `unknown action: ${type ?? "(missing)"}` },
      { status: 400 }
    );
  }
}

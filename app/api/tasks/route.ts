import { NextResponse } from "next/server";
import { assertRemoteAuth } from "@/lib/remote/auth";
import { runDueLongTasks, startLongTaskRun } from "@/lib/tasks/runner";
import {
  attachLongTaskSchedulerState,
  ensureLongTaskScheduler,
} from "@/lib/tasks/scheduler";
import {
  createLongTask,
  deleteLongTask,
  listLongTasksDashboard,
  updateLongTask,
  updateTaskFinding,
} from "@/lib/tasks/store";
import type {
  LongTaskCreateInput,
  LongTaskUpdateInput,
  TaskFindingStatus,
} from "@/lib/tasks/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  ensureLongTaskScheduler();
  return NextResponse.json(attachLongTaskSchedulerState(listLongTasksDashboard()));
}

export async function POST(req: Request) {
  const auth = await assertRemoteAuth(req);
  if (auth) return auth;
  ensureLongTaskScheduler();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const type = typeof body.type === "string" ? body.type : "create";

    if (type === "create") {
      const task = createLongTask(body as unknown as LongTaskCreateInput);
      return NextResponse.json({ ok: true, task, dashboard: dashboard() });
    }

    if (type === "update") {
      const id = stringField(body.id);
      const task = updateLongTask(id, body as unknown as LongTaskUpdateInput);
      return NextResponse.json({ ok: true, task, dashboard: dashboard() });
    }

    if (type === "delete") {
      const id = stringField(body.id);
      deleteLongTask(id);
      return NextResponse.json({ ok: true, dashboard: dashboard() });
    }

    if (type === "run") {
      const id = stringField(body.id);
      const result = await startLongTaskRun(id);
      return NextResponse.json({ ok: true, ...result, dashboard: dashboard() });
    }

    if (type === "run_due") {
      const started = await runDueLongTasks();
      return NextResponse.json({
        ok: true,
        started,
        dashboard: dashboard(),
      });
    }

    if (type === "finding_status") {
      const id = stringField(body.id);
      const status = stringField(body.status) as TaskFindingStatus;
      const finding = updateTaskFinding(id, { status });
      return NextResponse.json({ ok: true, finding, dashboard: dashboard() });
    }

    return NextResponse.json({ error: `unknown task action: ${type}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

function stringField(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("缺少必要字段");
  }
  return value.trim();
}

function dashboard() {
  return attachLongTaskSchedulerState(listLongTasksDashboard());
}

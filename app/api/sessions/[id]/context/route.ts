import { NextResponse } from "next/server";
import {
  getSessionContext,
  getForkableUserMessages,
} from "@/lib/sessions";

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
    // 顺带返回 fork 锚点：选中 session 后无需 agent 也能立刻 hover fork
    const forkableUserMessages = (await getForkableUserMessages(id)) ?? [];
    return NextResponse.json({ ...ctx, forkableUserMessages });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

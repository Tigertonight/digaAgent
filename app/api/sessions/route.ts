import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessions = await listAllSessions();
    // 序列化时 Date 自动变 ISO 字符串
    return NextResponse.json({ sessions });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

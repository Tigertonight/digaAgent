import { NextResponse } from "next/server";
import { getAgent, pushExternalEvent } from "@/lib/agent-registry";
import {
  browserClose,
  browserOpen,
  browserScreenshot,
  getBrowserSnapshot,
} from "@/lib/browser/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!getAgent(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ snapshot: getBrowserSnapshot(id) });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rec = getAgent(id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const type = body.type as string | undefined;
  try {
    if (type === "open") {
      const url = body.url as string | undefined;
      if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });
      const { snapshot } = await browserOpen(id, url);
      pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "screenshot") {
      const { snapshot } = await browserScreenshot(id);
      pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    if (type === "close") {
      const snapshot = await browserClose(id);
      pushExternalEvent(rec, { type: "browser_state", snapshot });
      return NextResponse.json({ ok: true, snapshot });
    }
    return NextResponse.json({ error: `unknown action: ${type}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

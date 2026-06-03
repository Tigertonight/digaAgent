import { NextResponse } from "next/server";
import {
  allowBrowserSite,
  blockBrowserSite,
  checkBrowserSite,
  loadBrowserSitePolicy,
  removeBrowserSitePolicy,
} from "@/lib/browser/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const target = url.searchParams.get("url");
  if (!target) {
    return NextResponse.json({ policy: await loadBrowserSitePolicy() });
  }
  try {
    return NextResponse.json(await checkBrowserSite(target));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 }
    );
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const type = body.type as string | undefined;
  const target = (body.origin as string | undefined) ?? (body.url as string | undefined);
  if (!target) return NextResponse.json({ error: "origin or url required" }, { status: 400 });

  try {
    if (type === "allow") {
      const result = await allowBrowserSite(target);
      return NextResponse.json({ ok: true, ...result });
    }
    if (type === "block") {
      const result = await blockBrowserSite(target);
      return NextResponse.json({ ok: true, ...result });
    }
    if (type === "remove") {
      const result = await removeBrowserSitePolicy(target);
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ error: `unknown action: ${type}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

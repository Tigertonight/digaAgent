import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  return NextResponse.redirect(
    new URL(`/mobile/pair/${encodeURIComponent(code)}`, req.url)
  );
}

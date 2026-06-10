import { NextResponse } from "next/server";
import { isLocalRequest, revokeRemoteDevice } from "@/lib/remote/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "local access required" }, { status: 403 });
  }
  const { id } = await params;
  const ok = await revokeRemoteDevice(id);
  return NextResponse.json({ ok });
}

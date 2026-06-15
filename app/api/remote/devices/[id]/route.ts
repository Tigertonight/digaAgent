import { NextResponse } from "next/server";
import { revokeRemoteDevice } from "@/lib/remote/store";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 设备吊销是敏感操作，仅本地（主进程 renderer / dev local）可调。
export const DELETE = withRemoteAuth(
  async function (
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
  ) {
    const { id } = await params;
    const ok = await revokeRemoteDevice(id);
    return NextResponse.json({ ok });
  },
  { requireLocalOnly: true }
);

import { NextResponse } from "next/server";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";

// 启动探活接口 — wrapper / electron 测路使用，需要公开。
export const GET = withRemoteAuth(
  async () =>
    NextResponse.json({
      ok: true,
      name: "diga-agent",
      stage: "B1",
      time: new Date().toISOString(),
    }),
  { publicReason: "health-probe" }
);

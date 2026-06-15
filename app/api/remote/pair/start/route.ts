import { NextResponse } from "next/server";
import pkg from "@/package.json";
import {
  createPairingPayload,
  getRemoteAccessSettings,
} from "@/lib/remote/store";
import { tunnelTargetFromRequest } from "@/lib/remote/request-target";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 配对生成仅本地可调（未配对之前还没有 token）。
export const POST = withRemoteAuth(
  async function (req: Request) {
    const settings = await getRemoteAccessSettings();
    const result = await createPairingPayload(
      (pkg as { version?: string }).version ?? "0.0.0",
      tunnelTargetFromRequest(req, settings.port)
    );
    return NextResponse.json(result);
  },
  { requireLocalOnly: true }
);

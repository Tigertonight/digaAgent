import { NextResponse } from "next/server";
import { completePairing } from "@/lib/remote/store";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 配对完成：手机拿 code 后中调拿 token。必须公开（本身是发 token 的路径）。
// code 一次性、限时、含隐式能力，作为获取 token 的劔战。
export const POST = withRemoteAuth(
  async function (req: Request) {
    const body = await req.json().catch(() => ({}));
    const code = typeof body.code === "string" ? body.code : "";
    if (!code) {
      return NextResponse.json({ error: "code required" }, { status: 400 });
    }
    try {
      const result = await completePairing({
        code,
        deviceName:
          typeof body.deviceName === "string" ? body.deviceName : undefined,
        userAgent: req.headers.get("user-agent"),
      });
      return NextResponse.json({
        token: result.token,
        deviceId: result.device.id,
        device: result.device,
      });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 }
      );
    }
  },
  { publicReason: "remote-pair-bootstrap" }
);

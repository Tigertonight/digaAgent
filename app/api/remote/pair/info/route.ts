import { NextResponse } from "next/server";
import { getPairingPayloadByCode } from "@/lib/remote/store";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 配对表果：手机扫码后拿 code 过来取 payload，未拿到 token 之前必须公开。
// code 本身是一次性、限时的，作为隐式能力令牌。
export const GET = withRemoteAuth(
  async function (req: Request) {
    const url = new URL(req.url);
    const code = url.searchParams.get("code") ?? "";
    const result = getPairingPayloadByCode(code);
    if (!result) {
      return NextResponse.json(
        { error: "pairing code expired or invalid" },
        { status: 404 }
      );
    }
    return NextResponse.json(result);
  },
  { publicReason: "remote-pair-bootstrap" }
);

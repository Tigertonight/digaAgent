import { NextResponse } from "next/server";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 主机探活端点。
 *
 * R1：这个路由是公开的，不要求鉴权。原因：
 *   - 手机配对前需要探测候选地址在不在，此时还没有 token。
 *   - cloudflared tunnel 启动后的健康检查在服务端发起，同样不带 token。
 *   - 移动端重连探活也希望仅“能到达”即可，不要与设备凭证耦合。
 * 返回体严格只含 { ok, ts }，不露出其他业务信息。
 */
export const GET = withRemoteAuth(
  async (req: Request) => {
    void req;
    return NextResponse.json({ ok: true, ts: Date.now() });
  },
  { publicReason: "remote-health-probe" }
);

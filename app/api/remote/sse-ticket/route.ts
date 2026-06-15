/**
 * POST /api/remote/sse-ticket
 *
 * R5：把长期 device token 换成短期、一次性 SSE ticket。
 *
 * EventSource 不支持自定义 header，长期 token 写进 URL 会泄漏到访问日志/中间代理。
 * 移动端在每次 attach SSE 之前先调本接口（带 Authorization: Bearer <device-token>），
 * 拿到 ticket，再以 ?sseTicket=<ticket> 形式去开 SSE。ticket 5 分钟有效、单次消费。
 */
import { NextResponse } from "next/server";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import { issueRemoteSseTicket, parseBearer } from "@/lib/remote/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withRemoteAuth(async (req: Request) => {
  // withRemoteAuth 已经做了 token 鉴权，这里再读一次 token 用于绑定设备。
  const token = parseBearer(req);
  if (!token) {
    return NextResponse.json(
      { error: "device token required" },
      { status: 401 }
    );
  }
  const issued = await issueRemoteSseTicket(token);
  if (!issued) {
    return NextResponse.json(
      { error: "device token invalid or revoked" },
      { status: 401 }
    );
  }
  return NextResponse.json(issued);
});

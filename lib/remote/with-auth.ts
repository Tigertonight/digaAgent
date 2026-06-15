/**
 * withRemoteAuth — 给 app/api/(...)/route.ts 用的统一鉴权装饰器。
 *
 * 设计目标：
 * 1. 默认 deny：不套这个装饰器的 handler，CI 会卡住（见 scripts/check-route-auth.mjs）。
 * 2. 兼容两种 Next route handler 签名：
 *      (req: Request) => Response
 *      (req: Request, ctx: { params: Promise<...> }) => Response
 * 3. 公开路由（如 /api/health、/api/remote/pair/start）必须显式声明 publicReason，
 *    并且 reason 必须在 PUBLIC_ROUTE_ALLOWLIST 里命中——CI 会校验。
 *
 * 使用：
 *   export const GET = withRemoteAuth(async (req, ctx) => { ... });
 *   export const POST = withRemoteAuth(handler, { publicReason: "health-probe" });
 */
import "server-only";
import { assertRemoteAuth } from "./auth";
import { isLocalRequest } from "./store";
import { NextResponse } from "next/server";

// Next route handler 的实际类型跨路由粒度并不统一：
//   - 部分路由用 (req: Request)
//   - 部分用 (req: NextRequest)
//   - 动态路由多一个 (ctx: { params: Promise<...> })
//   - 返回值可能是 Response 或 NextResponse<T>
// 装饰器不能强制 handler 使用某种统一类型。接受任意可调用类型，
// 原样返回同类型。运行时在调用 handler 时伝递 (req, ctx)，单参 handler 必 ignore ctx。
type RouteHandler = (...args: never[]) => Promise<Response> | Response;

interface WithRemoteAuthOptions {
  /**
   * 标记该 handler 完全公开（无任何鉴权）。值必须能在 CI 白名单里命中。
   * 例如：
   *   - "health-probe"           ：/api/health，wrapper 探活
   *   - "remote-pair-bootstrap"  ：配对必须在 token 还没产生时跑
   */
  publicReason?: string;
  /**
   * 标记该 handler 仅在「local secret 命中」时放行。用于 OAuth 登录回调等
   * 流程：远程模式下不可用，本地 Electron renderer（带主进程注入的 secret header）可用。
   */
  requireLocalOnly?: boolean;
}

export const PUBLIC_ROUTE_ALLOWLIST = new Set<string>([
  "health-probe",
  "remote-pair-bootstrap",
  "oauth-public-callback",
  // R1：应用层“主机还活着吗” health probe。手机配对前、cloudflared tunnel
  // 启动后的健康检查、移动端起初探活（还没 token）都需要。
  // 只返回 { ok, ts }，不含任何业务状态。
  "remote-health-probe",
]);

function rejectLocalOnly(): Response {
  return NextResponse.json(
    { error: "this endpoint is local-only" },
    { status: 403 }
  );
}

export function withRemoteAuth<H extends RouteHandler>(
  handler: H,
  options: WithRemoteAuthOptions = {}
): H {
  if (options.publicReason && !PUBLIC_ROUTE_ALLOWLIST.has(options.publicReason)) {
    // dev-time guard：拼写错误的 reason 直接抛，避免误以为路由在公开白名单里
    throw new Error(
      `withRemoteAuth: unknown publicReason "${options.publicReason}". ` +
        `Add it to PUBLIC_ROUTE_ALLOWLIST after security review.`
    );
  }
  const wrapped = async (req: Request, ctx?: unknown): Promise<Response> => {
    // 狭化调用参数 — handler 可能只接一个参数。
    const callHandler = (): Promise<Response> | Response => {
      const fn = handler as unknown as (
        req: Request,
        ctx?: unknown
      ) => Promise<Response> | Response;
      return ctx === undefined ? fn(req) : fn(req, ctx);
    };
    if (options.publicReason) return callHandler();
    if (options.requireLocalOnly) {
      if (!isLocalRequest(req)) return rejectLocalOnly();
      return callHandler();
    }
    const blocked = await assertRemoteAuth(req);
    if (blocked) return blocked;
    return callHandler();
  };
  return wrapped as unknown as H;
}

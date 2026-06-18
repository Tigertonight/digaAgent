import { NextResponse } from "next/server";

/**
 * S3: 统一的 API 错误响应。
 *
 * 目的：避免把 SDK / fs 抛出的原始 Error.message（常含绝对路径、用户家目录、
 * 甚至堆栈片段）直接回给客户端造成信息泄漏。未知错误一律对外返回通用文案，
 * 真实信息只写到 server log；显式的、可控的错误（404/400 等）才允许带可读 message。
 *
 * 用法：
 *   - 已知/可控错误：`return errorResponse("session not found", { status: 404 });`
 *   - catch 未知错误：`return internalErrorResponse(e, { scope: "GET /sessions" });`
 */

export function errorResponse(
  message: string,
  init?: { status?: number }
): NextResponse {
  return NextResponse.json({ error: message }, { status: init?.status ?? 400 });
}

export function internalErrorResponse(
  err: unknown,
  opts?: { scope?: string; status?: number }
): NextResponse {
  const scope = opts?.scope ? `[${opts.scope}] ` : "";
  // 真实错误只进 server log（含 stack 时也保留），不外泄。
  console.error(`${scope}internal error:`, err);
  return NextResponse.json(
    { error: "internal error" },
    { status: opts?.status ?? 500 }
  );
}

/**
 * 给用 `new Response(...)` 而非 NextResponse 的路由（如 export 流式下载）用的纯
 * body 变体：返回安全 JSON 字符串，真实错误写日志。
 */
export function internalErrorBody(err: unknown, opts?: { scope?: string }): string {
  const scope = opts?.scope ? `[${opts.scope}] ` : "";
  console.error(`${scope}internal error:`, err);
  return JSON.stringify({ error: "internal error" });
}

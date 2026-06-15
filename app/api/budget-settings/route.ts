/**
 * GET / PATCH /api/budget-settings
 *
 * 持久化 budget 全局默认值。Electron 下落到 userData/settings.json，
 * web 模式落到 ~/.diga-agent/settings.json。session 级 override 仍由前端
 * 用 localStorage 维护（短暂会话级覆盖）。
 *
 * 默认不限流（DEFAULT_BUDGET 三维全 undefined + action="pause"）。
 *
 * 远程访问需要 token；不要 isLocal-only —— 手机端也得能查/改。
 */
import { NextResponse } from "next/server";
import { withRemoteAuth } from "@/lib/remote/with-auth";
import {
  getBudgetSettings,
  updateBudgetSettings,
} from "@/lib/budget/server-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withRemoteAuth(async (req: Request) => {
  void req;
  const budget = await getBudgetSettings();
  return NextResponse.json({ budget });
});

export const PATCH = withRemoteAuth(async (req: Request) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  // 只接受 budget 字段（patch shape 直接是 SessionBudget partial）
  const patch = (body.budget ?? body) as Record<string, unknown>;
  try {
    const budget = await updateBudgetSettings(patch);
    return NextResponse.json({ budget });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
});

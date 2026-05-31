/**
 * POST /api/skills/install
 *
 * body: { package: string, scope?: "project"|"user"|"global", cwd?: string }
 * 返回: { success: true, output?: string } | { error: string }
 *
 * 对齐 pi-web 的 client wiring（来自 SkillsPanel marketplace 安装按钮）。
 * 内部走 SDK 的 PackageManager.installAndPersist，**不**依赖外部 `npx skills add` CLI，
 * 因此不需要 60s shell timeout，也不会被 ANSI / 网络问题污染。
 *
 * scope 语义：
 *   - "project"           → local=true（写到 cwd 的 settings）
 *   - "user" | "global"   → local=false（写到 ~/.pi 全局 settings）
 *   - 缺省                → 全局
 *
 * 兼容：pi-web 的 `{ package, scope, cwd }`；mini 自家 `/api/skills` POST 走
 * `{ action:"install", source, local, cwd }`，两者并行存在不冲突。
 */
import { NextResponse } from "next/server";
import { getPackageManager } from "@/lib/agent-registry";
import os from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveCwd(input: string | null | undefined): string {
  if (input && input.trim().length > 0) return input;
  return os.homedir();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      package?: string;
      source?: string; // mini 风格也接受
      scope?: string;
      cwd?: string;
    };

    const pkg = (body.package ?? body.source ?? "").trim();
    if (!pkg) {
      return NextResponse.json(
        { error: "package required" },
        { status: 400 }
      );
    }

    const scope = (body.scope ?? "global").toLowerCase();
    const local = scope === "project";
    const cwd = resolveCwd(body.cwd);

    const pm = getPackageManager(cwd);
    const result = await pm.installAndPersist(pkg, { local });

    return NextResponse.json({
      success: true,
      output: `Installation complete: ${pkg}`,
      package: pkg,
      scope: local ? "project" : "global",
      result,
    });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * /api/skills —— skills 列表 + 包管理（install/remove/update）。
 *
 * GET  /api/skills?cwd=...           列出当前 cwd 下解析到的 skills + 已配置 packages
 * POST /api/skills                    body: { action, source?, local?, scope? }
 *   - action="install" + source         安装 npm/git 包并持久化到 settings
 *   - action="remove"  + source         从 settings 移除（不一定删文件）
 *   - action="update"  + source?        更新指定包或全部
 */
import { NextResponse } from "next/server";
import {
  getSettingsManager,
  getPackageManager,
} from "@/lib/agent-registry";
import {
  loadSkills,
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import os from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveCwd(input: string | null | undefined): string {
  if (input && input.trim().length > 0) return input;
  return os.homedir();
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cwd = resolveCwd(url.searchParams.get("cwd"));

    const sm = getSettingsManager(cwd);
    const pm = getPackageManager(cwd);

    // 1. 解析 packages（拿到 skill 资源路径）；onMissing 直接 skip
    const resolved = await pm.resolve(async () => "skip");

    // 2. 用 loadSkills 把 skills 真正加载出来（含来源与 description）
    const skills = loadSkills({
      cwd,
      agentDir: getAgentDir(),
      skillPaths: resolved.skills.map((r) => r.path),
      includeDefaults: true,
    });

    const configuredPackages = pm.listConfiguredPackages();

    return NextResponse.json({
      cwd,
      skills: skills.skills.map((s) => ({
        name: s.name,
        description: s.description,
        filePath: s.filePath,
        baseDir: s.baseDir,
        source: s.sourceInfo,
        disableModelInvocation: s.disableModelInvocation,
      })),
      diagnostics: skills.diagnostics,
      packages: configuredPackages,
      resolvedSkillPaths: resolved.skills.map((r) => ({
        path: r.path,
        enabled: r.enabled,
        source: r.metadata.source,
        scope: r.metadata.scope,
        origin: r.metadata.origin,
      })),
      // 给前端调试
      _settings: {
        skills: sm.getSkillPaths(),
        packages: sm.getPackages(),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, stack: (e as Error).stack },
      { status: 500 }
    );
  }
}

// PATCH /api/skills —— 切换 SKILL.md 的 disable-model-invocation 字段
export async function PATCH(req: Request) {
  try {
    const body = (await req.json()) as {
      filePath?: string;
      disableModelInvocation?: boolean;
    };
    const filePath = body.filePath ?? "";
    const disable = Boolean(body.disableModelInvocation);
    if (!filePath) {
      return NextResponse.json(
        { error: "filePath required" },
        { status: 400 }
      );
    }
    if (!existsSync(filePath)) {
      return NextResponse.json({ error: "file not found" }, { status: 404 });
    }

    const content = readFileSync(filePath, "utf8");
    const key = "disable-model-invocation";
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
    const alreadySet = Boolean(frontmatter[key]);

    let updated = content;
    if (disable && !alreadySet) {
      updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
      if (updated === content) updated = `---\n${key}: true\n---\n${content}`;
    } else if (!disable && alreadySet) {
      updated = content.replace(
        new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"),
        ""
      );
    }
    writeFileSync(filePath, updated, "utf8");
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      /* allow empty */
    }
    const action = (body.action as string | undefined) ?? "";
    const source = (body.source as string | undefined) ?? "";
    const local = body.local === true || body.scope === "project";
    const cwd = resolveCwd(body.cwd as string | undefined);

    const pm = getPackageManager(cwd);

    switch (action) {
      case "install": {
        if (!source) {
          return NextResponse.json(
            { error: "source required" },
            { status: 400 }
          );
        }
        await pm.installAndPersist(source, { local });
        return NextResponse.json({ ok: true });
      }
      case "remove": {
        if (!source) {
          return NextResponse.json(
            { error: "source required" },
            { status: 400 }
          );
        }
        const removed = await pm.removeAndPersist(source, { local });
        return NextResponse.json({ ok: true, removed });
      }
      case "update": {
        await pm.update(source || undefined);
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json(
          { error: `unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, stack: (e as Error).stack },
      { status: 500 }
    );
  }
}

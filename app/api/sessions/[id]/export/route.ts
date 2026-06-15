import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findSessionPathById } from "@/lib/sessions";
import { withRemoteAuth } from "@/lib/remote/with-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SDK 的 export-html 子路径不在 package.json exports map 里，
 * 直接 import 会被 Node 拦下。
 * 解法：先 import 主入口让 NFT trace SDK，再用 process.cwd() 拼到子路径。
 * 用 process.cwd() 会触发 Turbopack 警告 "整个项目被 trace"，
 * 但用 outputFileTracingExcludes 排除大头（dist/electron/scripts/build/源码副本）即可。
 */
type ExportFn = (
  inputPath: string,
  options?: { outputPath?: string; themeName?: string }
) => Promise<string>;

let cachedExport: ExportFn | null = null;

async function loadExportFromFile(): Promise<ExportFn> {
  if (cachedExport) return cachedExport;
  const sdk = (await import("@earendil-works/pi-coding-agent")) as Record<
    string,
    unknown
  >;
  void sdk; // 仅触发 NFT 把 SDK dist 算进 trace
  const target = resolve(
    process.cwd(),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "core",
    "export-html",
    "index.js"
  );
  const url = pathToFileURL(target).href;
  const mod = (await import(/* webpackIgnore: true */ url)) as {
    exportFromFile: ExportFn;
  };
  cachedExport = mod.exportFromFile;
  return cachedExport;
}

/** GET: 导出 session 为 HTML 字符串 */
export const GET = withRemoteAuth(async function (
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const path = await findSessionPathById(id);
    if (!path) {
      return new Response(JSON.stringify({ error: "session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    const exportFromFile = await loadExportFromFile();
    const outPath = join(
      tmpdir(),
      `diga-agent-export-${id}-${Date.now()}.html`
    );
    try {
      await exportFromFile(path, { outputPath: outPath });
      const html = await fs.readFile(outPath, "utf8");
      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": `attachment; filename="pi-session-${id}.html"`,
          "Cache-Control": "no-store",
        },
      });
    } finally {
      await fs.unlink(outPath).catch(() => {});
    }
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});

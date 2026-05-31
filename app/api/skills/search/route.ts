/**
 * POST /api/skills/search
 *
 * body: { query: string, limit?: number }
 * 返回: { results: Array<{package, installs, url}> }
 *
 * 直接代理到 skills.sh：GET https://skills.sh/api/search?q=...&limit=...
 * 响应 schema: { skills: [{ name, source?, id?, installs? }] }
 * 转换成 pi-web 兼容的 {package:`${source||id}@${name}`, installs:"X installs", url}。
 *
 * 排序：按 installs 降序。
 */
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SKILLS_API_URL = process.env.SKILLS_API_URL || "https://skills.sh";

interface SkillsShEntry {
  name?: string;
  source?: string;
  id?: string;
  installs?: number;
}

interface SkillsShResponse {
  skills?: SkillsShEntry[];
}

interface SearchResult {
  package: string;
  installs: string;
  url: string;
}

function formatInstalls(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M installs`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}K installs`;
  return `${n} install${n === 1 ? "" : "s"}`;
}

function installsRank(s: string): number {
  const m = s.match(/^([\d.]+)([KMB])?\s+installs?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mul =
    m[2] === "B" ? 1e9 : m[2] === "M" ? 1e6 : m[2] === "K" ? 1e3 : 1;
  return n * mul;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { query?: string; limit?: number };
    const query = (body?.query ?? "").trim();
    if (!query) {
      return NextResponse.json({ error: "query required" }, { status: 400 });
    }
    const rawLimit =
      typeof body.limit === "number" ? body.limit : Number(body.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(50, Math.max(1, Math.floor(rawLimit)))
      : 50;

    const url = `${SKILLS_API_URL}/api/search?q=${encodeURIComponent(
      query
    )}&limit=${limit}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) {
      return NextResponse.json(
        { error: `skills.sh HTTP ${r.status}` },
        { status: 502 }
      );
    }
    const data = (await r.json()) as SkillsShResponse;
    const list = data.skills ?? [];

    const results: SearchResult[] = list
      .map((s) => {
        const name = s.name?.trim();
        const source = s.source?.trim();
        const id = s.id?.trim();
        if (!name || (!source && !id)) return null;
        return {
          package: `${source || id}@${name}`,
          installs: formatInstalls(s.installs),
          url: id ? `${SKILLS_API_URL}/${id}` : "",
        };
      })
      .filter((x): x is SearchResult => x !== null)
      .sort((a, b) => installsRank(b.installs) - installsRank(a.installs));

    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

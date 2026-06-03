/**
 * RFC-3 Phase B / F2：全文检索 API。
 *
 * POST /api/search
 *   body: { query: string, limit?: number }
 *   resp: SearchResponse { results, builtAt, durationMs, totalDocs }
 *
 * 设计（v0）：
 *   - 内存倒排索引，进程生命周期内 cache（见 ./cache.ts）
 *   - 按 session list "(maxModified, sessionCount)" invalidate
 *     → 任一 session 新建 / 内容变更 / 删除 都会触发重建
 *   - 串行 build，首次 ~100-200ms（< 100 session），可接受
 *   - 不做并发请求合并：第一次冷构建期间，若并发多个请求，会重复 build；
 *     v0 用户量小，不优化；后续 phase 可加 in-flight promise dedup
 */

import { NextResponse } from "next/server";

import { search } from "@/lib/search";
import type { SearchResponse } from "@/lib/search/types";

import { getSearchIndexWithMeta } from "./cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function POST(req: Request) {
  const t0 = Date.now();
  try {
    const body = (await req.json().catch(() => ({}))) as {
      query?: unknown;
      limit?: unknown;
    };
    const query = typeof body.query === "string" ? body.query : "";
    if (!query.trim()) {
      return NextResponse.json(
        { error: "query is required" },
        { status: 400 },
      );
    }
    const limitRaw = typeof body.limit === "number" ? body.limit : DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw)));

    const { index, cacheHit, buildMs } = await getSearchIndexWithMeta();
    const results = search(index, query, limit);

    const resp: SearchResponse = {
      results,
      builtAt: index.builtAt,
      durationMs: Date.now() - t0,
      totalDocs: index.docs.size,
      indexStatus: cacheHit ? "cached" : "rebuilt",
      indexBuildMs: cacheHit ? undefined : buildMs,
    };
    return NextResponse.json(resp);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}

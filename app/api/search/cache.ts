/**
 * RFC-3 Phase B / F2：search 路由的 cache 单独抽出来，
 * 因为 Next.js 路由文件不允许导出 HTTP 方法之外的命名 export。
 *
 * 这里集中放：
 *   - cache state（module-level 单例，进程生命周期）
 *   - fingerprint 计算（用于 invalidate）
 *   - getIndex / __invalidateSearchCache
 */

import { buildSearchIndexFromAllSessions } from "@/lib/search/build-index";
import type { SearchIndex } from "@/lib/search/types";
import { listAllSessions } from "@/lib/sessions";

interface CacheState {
  index: SearchIndex;
  /** 上次构建时 session 列表的 max(modified) ms */
  maxModified: number;
  /** 上次构建时 session 总数 */
  sessionCount: number;
}

let cache: CacheState | null = null;

/** 拿当前 session list 的指纹（不读 entries，只 list） */
async function fingerprint(): Promise<{
  maxModified: number;
  sessionCount: number;
}> {
  const list = await listAllSessions();
  let maxModified = 0;
  for (const s of list) {
    const t = s.modified.getTime();
    if (t > maxModified) maxModified = t;
  }
  return { maxModified, sessionCount: list.length };
}

export async function getSearchIndex(): Promise<SearchIndex> {
  return (await getSearchIndexWithMeta()).index;
}

export async function getSearchIndexWithMeta(): Promise<{
  index: SearchIndex;
  cacheHit: boolean;
  buildMs: number;
}> {
  const fp = await fingerprint();
  if (
    cache &&
    cache.maxModified === fp.maxModified &&
    cache.sessionCount === fp.sessionCount
  ) {
    return { index: cache.index, cacheHit: true, buildMs: 0 };
  }
  const t0 = Date.now();
  const index = await buildSearchIndexFromAllSessions();
  cache = { index, ...fp };
  return { index, cacheHit: false, buildMs: Date.now() - t0 };
}

/** 测试 / dev 用：强制清缓存 */
export function __invalidateSearchCache(): void {
  cache = null;
}

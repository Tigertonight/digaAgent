/**
 * RFC-3 Phase B / F2：全量索引构建（IO 层）。
 *
 * 此文件碰 SDK / fs，单测不覆盖（API 集成测试覆盖）。
 * 纯函数抽取逻辑见 ./extract.ts。
 */

import { buildSearchDocFromSession } from "./extract";
import { buildIndex } from "./index";
import { getSessionDetail, listAllSessions } from "../sessions";
import type { SearchDoc, SearchIndex } from "./types";

/**
 * 全量构建索引：拉所有 session → SearchDoc → SearchIndex。
 *
 * v0：串行 fs 读，< 100 session 性能足够；并行优化留给后续 phase。
 * 单 session 解析失败不应拖垮整个索引。
 */
export async function buildSearchIndexFromAllSessions(): Promise<SearchIndex> {
  const all = await listAllSessions();
  const docs: SearchDoc[] = [];

  for (const info of all) {
    try {
      const detail = await getSessionDetail(info.id);
      if (!detail) continue;
      docs.push(buildSearchDocFromSession(detail.info, detail.entries));
    } catch (err) {
      console.warn(`[search] skip session ${info.id}:`, err);
    }
  }

  return buildIndex(docs);
}

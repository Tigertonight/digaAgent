/**
 * RFC-3 Phase B / F2：内存倒排索引 + 搜索。
 *
 * 纯函数：不碰 fs / 不碰 SDK。
 * 数据怎么来 → 见 build-index.ts
 *
 * 评分（v0，BM25-lite）：
 *   - session 命中 token 越多 → 分越高
 *   - hit 数越多 → 分越高（封顶避免长 session 霸榜）
 *   - 单 token 在 corpus 里越稀有（出现 session 数越少）→ 权重越大
 */

import { tokenize, tokenizeQuery } from "./tokenize";
import type {
  SearchDoc,
  SearchHit,
  SearchIndex,
  SearchResult,
} from "./types";

const SNIPPET_RADIUS = 40; // 命中位置前后各取 40 字符
const MAX_HITS_PER_SESSION = 5;
const HIT_COUNT_CAP = 10; // hit 计数封顶
const DEFAULT_LIMIT = 50;

/** 从 SearchDoc[] 构建倒排索引（纯函数） */
export function buildIndex(docs: SearchDoc[]): SearchIndex {
  const idx: SearchIndex = {
    docs: new Map(),
    inverted: new Map(),
    builtAt: Date.now(),
  };

  for (const doc of docs) {
    idx.docs.set(doc.sessionId, doc);
    const tokens = tokenize(doc.fullText);
    for (const tok of tokens) {
      let bucket = idx.inverted.get(tok);
      if (!bucket) {
        bucket = new Set();
        idx.inverted.set(tok, bucket);
      }
      bucket.add(doc.sessionId);
    }
  }

  return idx;
}

/** 搜索（纯函数） */
export function search(
  idx: SearchIndex,
  query: string,
  limit: number = DEFAULT_LIMIT,
): SearchResult[] {
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) return [];

  // 1) AND 求交：所有 token 都必须出现
  let candidateIds: Set<string> | null = null;
  for (const tok of queryTokens) {
    const bucket = idx.inverted.get(tok);
    if (!bucket || bucket.size === 0) return []; // 任何一个 token 没命中 → 空
    if (candidateIds === null) {
      candidateIds = new Set(bucket);
    } else {
      candidateIds = intersect(candidateIds, bucket);
      if (candidateIds.size === 0) return [];
    }
  }
  if (!candidateIds) return [];

  const totalDocs = idx.docs.size || 1;

  // 2) 每个候选 session 算分 + 抽 snippet
  const results: SearchResult[] = [];
  for (const sessionId of candidateIds) {
    const doc = idx.docs.get(sessionId);
    if (!doc) continue;

    // 在 doc.hits 里找包含任意 query token 的 entry，抽 snippet
    const entryHits: SearchHit[] = [];
    for (const h of doc.hits) {
      const matched = matchedTokensIn(h.text, queryTokens);
      if (matched.length === 0) continue;
      entryHits.push({
        entryId: h.entryId,
        kind: h.kind,
        snippet: extractSnippet(h.text, matched[0]),
        matchedTokens: matched,
      });
      if (entryHits.length >= MAX_HITS_PER_SESSION * 3) break; // 早停，留余量给排序
    }

    if (entryHits.length === 0) {
      // fullText 命中但 hits 没命中（理论不该发生，跳过）
      continue;
    }

    // 排序 entryHits（多 token 命中靠前）+ 截断
    entryHits.sort((a, b) => b.matchedTokens.length - a.matchedTokens.length);
    const topHits = entryHits.slice(0, MAX_HITS_PER_SESSION);

    // 评分
    const distinctTokenScore = queryTokens.reduce((acc, tok) => {
      const docFreq = idx.inverted.get(tok)?.size ?? 0;
      const idf = Math.log(1 + totalDocs / Math.max(1, docFreq));
      return acc + (entryHits.some((h) => h.matchedTokens.includes(tok)) ? idf : 0);
    }, 0);
    const hitCountScore = Math.log(1 + Math.min(entryHits.length, HIT_COUNT_CAP));

    results.push({
      sessionId,
      score: distinctTokenScore + hitCountScore,
      hits: topHits,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/** 集合交（小集合驱动） */
function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  const out = new Set<string>();
  for (const x of small) {
    if (big.has(x)) out.add(x);
  }
  return out;
}

/** 文本里出现的 query token 列表（lowercase 比对，去重保序） */
function matchedTokensIn(text: string, queryTokens: string[]): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const tok of queryTokens) {
    if (lower.includes(tok)) out.push(tok);
  }
  return out;
}

/** 从原始文本里抽出含 token 的片段（前后各 SNIPPET_RADIUS 字符） */
function extractSnippet(text: string, token: string): string {
  const lower = text.toLowerCase();
  const pos = lower.indexOf(token);
  if (pos < 0) return text.slice(0, SNIPPET_RADIUS * 2);

  const start = Math.max(0, pos - SNIPPET_RADIUS);
  const end = Math.min(text.length, pos + token.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end) + suffix;
}

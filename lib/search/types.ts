/**
 * RFC-3 Phase B / F2 全文检索：类型定义。
 *
 * 设计原则（v0）：
 *   - 纯内存索引，进程生命周期内缓存，按 session 列表 mtime invalidate
 *   - 不持久化到 disk（留给后续 phase）
 *   - 不增量（每次 invalidate 后全量重建）
 *   - 文本来源：user / assistant text / bashExecution / compaction / branchSummary / sessionInfo.name
 *   - 不索引 thinking / toolResult / image content（噪声大、体积大）
 *
 * 抽象边界：
 *   - tokenize / buildIndex / search 全部纯函数，不依赖 fs / SDK
 *   - build-index.ts 负责从 SDK 拉数据 → SearchDoc[]，再丢给 buildIndex
 *   - API 路由负责 cache 生命周期
 */

/** 命中点：定位到 session 的某条 entry */
export interface SearchHit {
  /** SessionEntry.id；UI 拿来跳转锚点（v0 暂只跳 session） */
  entryId: string;
  /** entry 的语义类型，用于 UI 着色 / 过滤 */
  kind:
    | "user"
    | "assistant"
    | "bash"
    | "compaction"
    | "branch-summary"
    | "session-info"
    | "custom";
  /** 该 entry 的文本片段（已截断），UI 拿来高亮渲染 */
  snippet: string;
  /** 命中的 token 列表（已去重、lowercase），UI 高亮用 */
  matchedTokens: string[];
}

/** 单 session 的索引文档 */
export interface SearchDoc {
  sessionId: string;
  /** SessionInfo.path（jsonl 路径），用于调试 */
  path: string;
  /** SessionInfo.cwd */
  cwd: string;
  /** 索引构建时刻 epoch ms */
  indexedAt: number;
  /** 该 session 全部可索引文本拼接（已 lowercase），用于摘要 / 调试 */
  fullText: string;
  /** entry 粒度的命中候选列表（搜索时从这里选片段） */
  hits: Array<{
    entryId: string;
    kind: SearchHit["kind"];
    /** 原始文本（未 lowercase），供 snippet 抽取 */
    text: string;
  }>;
}

/** 倒排索引：token → 出现该 token 的 sessionId 集合 */
export interface SearchIndex {
  /** sessionId → SearchDoc */
  docs: Map<string, SearchDoc>;
  /** token → Set<sessionId> */
  inverted: Map<string, Set<string>>;
  /** 索引构建完成时刻 */
  builtAt: number;
}

/** 搜索单条结果 */
export interface SearchResult {
  sessionId: string;
  /** 评分（v0：命中 hit 数 + token 多样性，越大越靠前） */
  score: number;
  /** 该 session 内的命中点（已按 score 降序、限制条数） */
  hits: SearchHit[];
}

/** 搜索响应体（API 层用） */
export interface SearchResponse {
  results: SearchResult[];
  /** 索引构建完成时刻；UI 可显示「索引于 X 分钟前」 */
  builtAt: number;
  /** 本次搜索耗时（ms） */
  durationMs: number;
  /** 索引中 session 总数 */
  totalDocs: number;
  /** 本次搜索使用缓存还是触发了重建；向后兼容的诊断字段。 */
  indexStatus?: "cached" | "rebuilt";
  /** 若触发重建，记录索引构建耗时。 */
  indexBuildMs?: number;
}

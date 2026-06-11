/**
 * RFC-3 Phase A：mini-pi-web 自维护的 session 补充元数据。
 *
 * 与 SDK 的 ~/.pi/sessions/{id}.jsonl 严格分离：
 *   - SDK 数据是 single-source-of-truth 的对话内容
 *   - meta 是 mini-pi-web 自己加的"视图层属性"（title 覆盖 / pin / labels / ...）
 *
 * 存储位置：~/.mini-pi/sessions/{id}.meta.json（单 session 一个文件）。
 *
 * v0 Phase A 落地 id / title / pinned / lastSeenAt；其他字段类型先声明，
 * 给 Phase B（summary / cost / turns）/ Phase C（labels / noAutoSummary）
 * 预留 schema 锚点，避免后续 breaking change。
 */

export interface SessionMeta {
  /** = SessionInfo.id（SDK 的 session id） */
  id: string;

  /** 用户手动改的标题；未设置时 UI 走原 fallback（cwd basename 等） */
  title?: string;

  /** sidebar 置顶 */
  pinned?: boolean;

  // ---------- 以下字段 v0 仅声明类型、未启用，给后续 Phase 留位 ----------

  /** Phase B：F3 自动摘要的一段话 */
  summary?: string;

  /** Phase B：用户打的标签 */
  labels?: string[];

  /** 最后已读到的 session modified 时间戳。用于跨安装恢复蓝点状态。 */
  lastSeenAt?: number;

  /** Phase B：累计花费（聚合自 turn_end） */
  cost?: { usd: number; updatedAt: number };

  /** Phase B：累计 turn 数 */
  turns?: number;

  /** Phase B：F3 摘要最后生成时间，用于增量更新判断 */
  summaryGeneratedAt?: number;

  /** Phase B：用户禁用此 session 的自动摘要 */
  noAutoSummary?: boolean;
}

/** v0 实际启用字段的白名单，PATCH 路由用于过滤 body */
export const META_WRITABLE_FIELDS_V0 = ["title", "pinned", "lastSeenAt"] as const;
export type MetaWritableFieldV0 = (typeof META_WRITABLE_FIELDS_V0)[number];

/**
 * 全部已知字段白名单（v0 + 预留），store 层归一化用。
 * 如果客户端塞进未知字段，store 会静默丢弃（forward compat 防御）。
 */
export const META_KNOWN_FIELDS = [
  "id",
  "title",
  "pinned",
  "summary",
  "labels",
  "lastSeenAt",
  "cost",
  "turns",
  "summaryGeneratedAt",
  "noAutoSummary",
] as const;

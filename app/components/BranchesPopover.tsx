"use client";

/**
 * Branches 视图：把当前 session 的树形结构铺开来，让用户切到任意节点。
 *
 * 数据来自 GET /api/agent/[id]?action=tree → { tree, leafId }
 * 切换通过 POST /api/agent/[id] { type: "navigate_tree", targetId }
 *
 * 节点类型：
 *   - message    user/assistant 消息（主要展示对象）
 *   - branch_summary    分叉摘要（只读，标识"这里曾分支过"）
 *   - 其它（compaction/model_change/...）默认折叠成淡色一行
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, X, ChevronRight, ChevronDown, Check } from "lucide-react";

interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  // SessionMessageEntry
  message?: {
    role: string;
    content?: Array<{
      type: string;
      text?: string;
      thinking?: string;
    }>;
  };
  // BranchSummaryEntry
  fromId?: string;
  summary?: string;
  // CompactionEntry
  firstKeptEntryId?: string;
  // ModelChangeEntry
  provider?: string;
  modelId?: string;
}

interface TreeNode {
  entry: SessionEntry;
  children: TreeNode[];
  label?: string;
}

interface Props {
  agentId: string;
  onClose: () => void;
  onNavigated: () => void;
}

export default function BranchesPopover({
  agentId,
  onClose,
  onNavigated,
}: Props) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [leafId, setLeafId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [navigating, setNavigating] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/agent/${agentId}?action=tree`);
      const d = (await r.json()) as
        | { tree: TreeNode[]; leafId: string | null }
        | { error: string };
      if ("error" in d) {
        setErr(d.error);
      } else {
        setTree(d.tree || []);
        setLeafId(d.leafId);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const navigate = useCallback(
    async (targetId: string) => {
      setNavigating(targetId);
      setErr(null);
      try {
        const r = await fetch(`/api/agent/${agentId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "navigate_tree", targetId }),
        });
        const d = (await r.json()) as { ok?: boolean; error?: string };
        if (d.error) {
          setErr(d.error);
          return;
        }
        // 通知上层重新拉 context、刷新 chat state
        onNavigated();
        onClose();
      } catch (e) {
        setErr(String(e));
      } finally {
        setNavigating(null);
      }
    },
    [agentId, onNavigated, onClose]
  );

  // 展平成可视化的"分支组"：找出所有有 >1 children 的节点（分叉点），并列出每条分支的 leaf
  const branches = useMemo(() => {
    const out: Array<{
      forkPoint: TreeNode;
      forkPointSummary: string;
      paths: Array<{
        firstNode: TreeNode;
        leafNode: TreeNode;
        nodeCount: number;
        isCurrent: boolean;
      }>;
    }> = [];

    const walk = (node: TreeNode) => {
      if (node.children.length > 1) {
        const paths = node.children.map((child) => {
          // 沿着 child 走到叶子（取第一个孩子，遇到第二次分叉就停在那里）
          let cur = child;
          let count = 1;
          let containsLeaf = false;
          while (cur.children.length === 1) {
            if (leafId && cur.entry.id === leafId) containsLeaf = true;
            cur = cur.children[0];
            count++;
          }
          if (leafId && cur.entry.id === leafId) containsLeaf = true;
          return {
            firstNode: child,
            leafNode: cur,
            nodeCount: count,
            isCurrent: containsLeaf,
          };
        });
        out.push({
          forkPoint: node,
          forkPointSummary: summarize(node.entry),
          paths,
        });
      }
      node.children.forEach(walk);
    };
    tree.forEach(walk);
    return out;
  }, [tree, leafId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16"
      style={{ background: "var(--color-overlay)" }}
      onClick={onClose}
    >
      <div
        className="w-[640px] max-h-[70vh] flex flex-col rounded-lg border shadow-xl"
        style={{
          background: "var(--bg-panel)",
          borderColor: "var(--border)",
          color: "var(--text)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-3 py-2 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <span className="inline-flex items-center gap-1.5 text-token-ui font-medium">
            <GitBranch size={14} />
            Branches
          </span>
          <button
            type="button"
            onClick={onClose}
            className="opacity-60 hover:opacity-100"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2 text-token-sm">
          {loading && (
            <div
              className="px-2 py-1"
              style={{ color: "var(--text-muted)" }}
            >
              loading…
            </div>
          )}
          {err && (
            <div
              className="px-2 py-1"
              style={{ color: "var(--color-danger)" }}
              title={err}
            >
              {err}
            </div>
          )}
          {!loading && !err && tree.length === 0 && (
            <div
              className="px-2 py-1"
              style={{ color: "var(--text-muted)" }}
            >
              当前 session 没有节点。
            </div>
          )}

          {/* 分叉点视图：每个 fork point 一组，下面列每条分支 */}
          {branches.length > 0 && (
            <div className="space-y-3 mb-3">
              {branches.map((b, bi) => (
                <div
                  key={b.forkPoint.entry.id}
                  className="rounded border"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div
                    className="border-b px-2 py-1 text-token-xs"
                    style={{
                      borderColor: "var(--border)",
                      color: "var(--text-muted)",
                    }}
                  >
                    分叉点 #{bi + 1} · {b.forkPointSummary}
                  </div>
                  <div>
                    {b.paths.map((p, pi) => (
                      <button
                        key={p.firstNode.entry.id}
                        type="button"
                        onClick={() => void navigate(p.leafNode.entry.id)}
                        disabled={navigating !== null}
                        className="w-full text-left px-2 py-1.5 flex items-start gap-2 hover:bg-[color:var(--bg-hover)] disabled:opacity-50"
                      >
                        <span
                          className="mt-0.5 shrink-0"
                          style={{
                            color: p.isCurrent
                              ? "var(--accent)"
                              : "var(--text-muted)",
                          }}
                        >
                          {p.isCurrent ? <Check size={12} /> : <span>·</span>}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block truncate">
                            分支 {pi + 1}：{summarize(p.firstNode.entry)}
                          </span>
                          <span
                            className="block text-token-xs"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {p.nodeCount} 个节点 · 末端{" "}
                            {summarize(p.leafNode.entry, 40)}
                          </span>
                        </span>
                        {p.isCurrent && (
                          <span
                            className="shrink-0 rounded-token-sm px-1.5 py-[1px] text-token-xs"
                            style={{
                              color: "var(--accent)",
                              background:
                                "color-mix(in srgb, var(--accent) 12%, transparent)",
                            }}
                          >
                            current
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 完整树视图（折叠） */}
          {tree.length > 0 && (
            <details>
              <summary
                className="cursor-pointer select-none px-2 py-1 text-token-xs"
                style={{ color: "var(--text-muted)" }}
              >
                显示完整树
              </summary>
              <div className="pl-1 pt-1">
                {tree.map((root) => (
                  <TreeRow
                    key={root.entry.id}
                    node={root}
                    depth={0}
                    leafId={leafId}
                    onNavigate={navigate}
                    navigating={navigating}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  leafId,
  onNavigate,
  navigating,
}: {
  node: TreeNode;
  depth: number;
  leafId: string | null;
  onNavigate: (id: string) => void;
  navigating: string | null;
}) {
  const [open, setOpen] = useState(true);
  const isCurrent = node.entry.id === leafId;
  const hasChildren = node.children.length > 0;
  const showable = node.entry.type === "message";
  return (
    <div>
      <div
        className="flex items-center gap-1 hover:bg-[color:var(--bg-hover)] rounded-sm"
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="opacity-60 hover:opacity-100"
          >
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <span style={{ width: 11 }} />
        )}
        <button
          type="button"
          onClick={() => onNavigate(node.entry.id)}
          disabled={navigating !== null || !showable}
          className="flex-1 min-w-0 text-left py-0.5 disabled:opacity-50"
          title={
            showable ? `切到此节点（${node.entry.id.slice(0, 8)}）` : undefined
          }
        >
          <span className="flex items-center gap-1">
            {isCurrent && (
              <Check size={11} style={{ color: "var(--accent)" }} />
            )}
            <span
              className="truncate"
              style={{
                color: showable ? "var(--text)" : "var(--text-muted)",
                fontWeight: isCurrent ? 600 : 400,
              }}
            >
              {summarize(node.entry, 60)}
            </span>
          </span>
        </button>
      </div>
      {open &&
        node.children.map((c) => (
          <TreeRow
            key={c.entry.id}
            node={c}
            depth={depth + 1}
            leafId={leafId}
            onNavigate={onNavigate}
            navigating={navigating}
          />
        ))}
    </div>
  );
}

function summarize(entry: SessionEntry, max = 50): string {
  if (entry.type === "message") {
    const role = entry.message?.role || "?";
    const text =
      entry.message?.content
        ?.map((c) => c.text || c.thinking || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim() || "";
    const truncated = text.length > max ? text.slice(0, max) + "…" : text;
    return `${role}: ${truncated || "(empty)"}`;
  }
  if (entry.type === "branch_summary") {
    const s = (entry.summary || "").replace(/\s+/g, " ").trim();
    return `branch_summary: ${s.length > max ? s.slice(0, max) + "…" : s}`;
  }
  if (entry.type === "compaction") return "compaction";
  if (entry.type === "model_change")
    return `model: ${entry.provider}/${entry.modelId}`;
  if (entry.type === "thinking_level_change") return "thinking_level_change";
  if (entry.type === "session_info") return "session_info";
  if (entry.type === "label") return "label";
  return entry.type;
}
